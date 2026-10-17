import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { writeJsonOnce, writeResultOnce, ResultExistsError, runLabelProblem } from "./lib/writeOnce.js";
import { summarizeRows } from "./lib/ragEvalSpec.js";
import { readProvenance } from "./verifyRagSpec.js";

// RAG before/after report (plan A10). Three conditions, all labelled by the frozen rule
// (scripts/live/lib/ragEvalSpec.js):
//   (i)   baseline: the frozen 2026-10-16 production result, never re-run or rewritten;
//   (ii)  old-chunker-new-corpus: the e9b779d chunker on the 57 CSVs with no row cap (isolates the
//         corpus change: KML/XLS removed, cap removed);
//   (iii) table-v1: the new chunker on the same 57 CSVs (isolates the chunker).
//   Optional (ii-b): the legacy chunker with the cap at 100.
// Reports top-3 and top-5 metrics, a per-query table, paired exact McNemar tests on answerable hit@k
// (n = 13, labelled underpowered), the row-text-only sensitivity summaries and the caveats. No
// provider is called. Writes docs/research/evaluation/live/rag/RAG_BEFORE_AFTER_<date>[_<tag>].{md,json}
// (write-once).
// Usage: node scripts/live/ragCompare.js --legacy=<run json> --table=<run json> --parity=<parity json>
//        [--baseline-replay=<parity run json>] [--legacy-capped=<run json>] [--baseline=<json>]
//        [--date=YYYY-MM-DD] [--tag=<tag>] [--out-dir=<dir>]

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE = join(root, "docs", "research", "evaluation", "live", "rag_retrieval_2026-10-16.json");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Two-sided exact McNemar test: binomial(b + c, 1/2) on the discordant pairs.
export const exactMcNemar = (b, c) => {
  const n = b + c;
  if (n === 0) return { b, c, n, pValue: 1 };
  let tail = 0;
  let coefficient = 1; // C(n, 0)
  for (let i = 0; i <= Math.min(b, c); i += 1) {
    if (i > 0) coefficient = (coefficient * (n - i + 1)) / i;
    tail += coefficient;
  }
  return { b, c, n, pValue: Math.min(1, (2 * tail) / 2 ** n) };
};

const answerable = (rows) => rows.filter((row) => row.kind === "answerable" && !row.error);
const hitAt = (row, k) => row.hits.slice(0, k).some((hit) => hit.relevant);

export const perQuery = (rows) =>
  answerable(rows).map((row) => {
    const first = row.hits.findIndex((hit) => hit.relevant);
    return { id: row.id, relevantAt3: hitAt(row, 3), relevantAt5: hitAt(row, 5), firstRelevantRank: first >= 0 ? first + 1 : null };
  });

// b = A missed and B hit; c = A hit and B missed. Only queries present without error in both count.
export const pairedMcNemar = (rowsA, rowsB, k) => {
  const byId = new Map(answerable(rowsB).map((row) => [row.id, row]));
  let b = 0;
  let c = 0;
  let pairs = 0;
  for (const row of answerable(rowsA)) {
    const other = byId.get(row.id);
    if (!other) continue;
    pairs += 1;
    const a = hitAt(row, k);
    const o = hitAt(other, k);
    if (!a && o) b += 1;
    if (a && !o) c += 1;
  }
  return { k, pairs, ...exactMcNemar(b, c), underpowered: true };
};

const rowTextRows = (run) => (run.rows || []).map((row) => (row.error || !row.rowTextOnly ? row : { ...row, hits: row.hits.map((hit, i) => ({ ...hit, ...row.rowTextOnly[i] })) }));

export const conditionSummary = (key, label, run, { replay } = {}) => {
  const rows = run.rows || [];
  const at3 = summarizeRows(rows, 3);
  const at5 = summarizeRows(rows, 5);
  const sensitivitySource = run.rows && run.rows.some((row) => row.rowTextOnly) ? run : replay && replay.rows && replay.rows.some((row) => row.rowTextOnly) ? replay : null;
  return {
    key,
    label,
    backend: run.backend || "chroma-cloud (2026-10-16 baseline)",
    condition: run.condition || key,
    commit: run.commit ?? null,
    dirty: run.dirty ?? run.dirtyWorkingTree ?? null,
    specSha256: run.specSha256 ?? null,
    indexManifestSha256: run.indexManifestSha256 ?? null,
    queryVectorsSha256: run.queryVectorsSha256 ?? null,
    corpus: run.corpus ? { chunks: run.corpus.chunks, files: run.corpus.files, chunksByFileKind: run.corpus.chunksByFileKind } : null,
    storedSummariesMatch: isDeepStrictEqual(run.summaryAtK5, at5) && (run.config && run.config.productionTopK === 3 ? isDeepStrictEqual(run.summaryAtProductionTopK, at3) : true),
    at3,
    at5,
    rowTextOnly: sensitivitySource
      ? { source: sensitivitySource === run ? "this run" : "baseline replay on the production snapshot", at3: summarizeRows(rowTextRows(sensitivitySource), 3), at5: summarizeRows(rowTextRows(sensitivitySource), 5) }
      : null,
    perQuery: perQuery(rows),
  };
};

export const CAVEATS = [
  "Relevance is the frozen, author-defined mechanical rule (expected file pattern + district/crop terms), not human judgement.",
  "Answerable n = 13 and advisory n = 9. The paired exact McNemar tests are underpowered: a non-significant p-value is not evidence of no effect, and with 13 pairs only a large one-directional change can reach p < 0.05.",
  "'Topical' (advisory) is not comparable across conditions: table-v1 puts the file name in every chunk (e.g. production_of_rice matches the topic 'rice'), which inflates it.",
  "The chunk preamble (File:/Table:/Columns:) can satisfy a term group without the row being about it (e.g. 'sugarcane' for A9). The row-text-only sensitivity applies the same rule without those lines. Header names that rows repeat as 'header: value' still count there.",
  "A12 has no term groups, so any chunk of the rice pest file counts as relevant; it is close to automatically relevant.",
  "File-type denominators changed: conditions (ii) and (iii) drop the KML geography file and the two XLS exports (237 + 17 of the baseline's 450 chunks) and remove the 100-row cap.",
  "'Expected-file hits that are header-only' is zero for table-v1 by construction (no chunk without rows); it measures the old defect, not a retrieval gain.",
  "Conditions (ii) and (iii) use one cached set of Cohere query vectors and exact local squared-L2 search; the baseline used live query embeddings and the production HNSW index. They are comparable only when the parity check passes.",
  "Embeddings are English-only (embed-english-v3.0); 2 of the 22 queries are Tamil.",
  "Production chat still queries the old collection (D3); these results describe a local index that is not deployed.",
];

// pinnedSpecSha256 defaults to the pin in scripts/live/lib/ragEvalSpec.provenance.json: a run on an
// edited rule can share its specSha256 with the parity replay and still not be the frozen rule.
export const buildComparison = ({ baseline, legacy, table, legacyCapped, replay, parity, pinnedSpecSha256 = readProvenance().spec.specSha256 }) => {
  const conditions = [
    conditionSummary("i", "(i) baseline (frozen, production collection)", baseline, { replay }),
    conditionSummary("ii", "(ii) old chunker, new corpus", legacy),
    ...(legacyCapped ? [conditionSummary("ii-b", "(ii-b) old chunker, new corpus, 100-row cap", legacyCapped)] : []),
    conditionSummary("iii", "(iii) table-v1", table),
  ];
  const pairs = [
    ["i", "iii", baseline, table, "primary"],
    ["i", "ii", baseline, legacy, "secondary"],
    ["ii", "iii", legacy, table, "secondary"],
  ];
  const mcnemar = pairs.flatMap(([conditionA, conditionB, runA, runB, role]) => [3, 5].map((k) => ({ conditionA, conditionB, role, metric: `answerable hit@${k}`, ...pairedMcNemar(runA.rows || [], runB.rows || [], k) })));
  const local = [legacy, table, legacyCapped].filter(Boolean);
  const parityCandidate = (parity && parity.candidate) || {};
  const consistency = {
    sameSpecSha256: new Set(local.map((run) => run.specSha256)).size === 1,
    specMatchesPin: Boolean(pinnedSpecSha256) && local.every((run) => run.specSha256 === pinnedSpecSha256),
    sameQueryVectors: new Set(local.map((run) => run.queryVectorsSha256)).size === 1 && local.every((run) => run.queryVectorsSha256),
    // The parity replay must rank with the same rule and the same cached query vectors as (ii) and (iii).
    parityUsedSameSpec: Boolean(parityCandidate.specSha256) && local.every((run) => run.specSha256 === parityCandidate.specSha256),
    parityUsedSameQueryVectors: Boolean(parityCandidate.queryVectorsSha256) && local.every((run) => run.queryVectorsSha256 === parityCandidate.queryVectorsSha256),
  };
  const parityVerdict = parity ? parity.verdict : null;
  return {
    comparable: parityVerdict === "PASS" && Object.values(consistency).every(Boolean),
    parity: parity ? { verdict: parity.verdict, date: parity.date, diffs: (parity.diffs || []).length } : null,
    pinnedSpecSha256: pinnedSpecSha256 || null,
    consistency,
    conditions,
    mcnemar,
    caveats: CAVEATS,
  };
};

const pct = (f) => (!f || f.value === null ? "n/a" : `${(f.value * 100).toFixed(1)}% (${f.k}/${f.n})`);
const METRICS = [
  ["Answerable: any relevant chunk", (s) => s.answerable.hitRateAnyRelevant],
  ["Answerable: top-1 relevant", (s) => s.answerable.top1Relevant],
  ["Answerable: chunk precision", (s) => s.answerable.precisionOfChunks],
  ["Answerable: expected file retrieved", (s) => s.answerable.anyExpectedFile],
  ["Expected-file hits that are header-only", (s) => s.answerableExpectedFileHitsThatAreHeaderOnly],
  ["Advisory: topical chunks (not comparable)", (s) => s.advisory.topicalChunks],
];

export const renderMarkdown = (comparison, { date }) => {
  const { conditions } = comparison;
  const header = `| Metric | ${conditions.map((c) => c.label).join(" | ")} |\n|---|${conditions.map(() => "---").join("|")}|`;
  const table = (k, pick) => [header, ...METRICS.map(([name, get]) => `| ${name} | ${conditions.map((c) => { const s = pick(c, k); return s ? pct(get(s)) : "n/a"; }).join(" | ")} |`)].join("\n");
  const ids = [...new Set(conditions.flatMap((c) => c.perQuery.map((q) => q.id)))];
  const cell = (c, id) => {
    const q = c.perQuery.find((x) => x.id === id);
    return q ? `${q.relevantAt3 ? "yes" : "no"} / ${q.relevantAt5 ? "yes" : "no"} / ${q.firstRelevantRank ?? "-"}` : "n/a";
  };
  return `# RAG before/after — ${date}

${comparison.comparable ? "Parity check PASSED, and the parity replay and every local condition used the same pinned rule and the same query vectors: conditions are comparable." : "**Comparability NOT ESTABLISHED**: the parity check did not pass or is missing, or the parity replay and the local conditions did not all use the pinned rule and the same query vectors. Do not cite these numbers as a before/after effect."}
Parity: ${comparison.parity ? `${comparison.parity.verdict} (${comparison.parity.diffs} row differences)` : "not provided"}.

## Top-3 (production top-k)

${table(3, (c, k) => c[`at${k}`])}

## Top-5

${table(5, (c, k) => c[`at${k}`])}

## Row-text-only sensitivity (preamble lines removed before the term check)

Top-3:

${table(3, (c) => (c.rowTextOnly ? c.rowTextOnly.at3 : null))}

Top-5:

${table(5, (c) => (c.rowTextOnly ? c.rowTextOnly.at5 : null))}

The frozen baseline stores 160-character snippets, not documents, so its row-text-only column needs the parity replay (\`--baseline-replay\`); without it the column is n/a.

## Per answerable query (relevant@3 / relevant@5 / rank of first relevant chunk)

| Query | ${conditions.map((c) => c.label).join(" | ")} |
|---|${conditions.map(() => "---").join("|")}|
${ids.map((id) => `| ${id} | ${conditions.map((c) => cell(c, id)).join(" | ")} |`).join("\n")}

## Paired exact McNemar (answerable hit@k) — UNDERPOWERED (n = 13)

| Pair | Role | Metric | b (A miss, B hit) | c (A hit, B miss) | p (two-sided exact) |
|---|---|---|---|---|---|
${comparison.mcnemar.map((m) => `| ${m.conditionA} vs ${m.conditionB} | ${m.role} | ${m.metric} | ${m.b} | ${m.c} | ${m.pValue.toFixed(4)} |`).join("\n")}

## Caveats

${comparison.caveats.map((c) => `- ${c}`).join("\n")}
`;
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name) => {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found === undefined ? undefined : found.slice(name.length + 3);
  };
  for (const required of ["legacy", "table"]) {
    if (!arg(required)) {
      console.error(`--${required}=<ragRetrieval result json> is required`);
      process.exit(1);
    }
  }
  const date = arg("date") || new Date().toISOString().slice(0, 10);
  const tag = arg("tag");
  const labelProblem = runLabelProblem({ date, tag });
  if (labelProblem) {
    console.error(labelProblem);
    process.exit(64);
  }
  const stem = `RAG_BEFORE_AFTER_${date}${tag ? `_${tag}` : ""}`;
  const outDir = arg("out-dir") ? resolve(arg("out-dir")) : join(root, "docs", "research", "evaluation", "live", "rag");
  for (const ext of ["json", "md"]) {
    const path = join(outDir, `${stem}.${ext}`);
    if (existsSync(path)) {
      console.error(new ResultExistsError(path).message);
      process.exit(2);
    }
  }
  const inputs = {};
  const sources = {};
  const load = (name, path) => {
    if (!path) return;
    const raw = readFileSync(resolve(path));
    sources[name] = { path: relative(root, resolve(path)), sha256: sha256(raw) };
    inputs[name] = JSON.parse(raw.toString("utf8"));
  };
  load("baseline", arg("baseline") || BASELINE);
  load("legacy", arg("legacy"));
  load("table", arg("table"));
  load("legacyCapped", arg("legacy-capped"));
  load("replay", arg("baseline-replay"));
  load("parity", arg("parity"));
  const comparison = buildComparison(inputs);
  const result = { name: "ragBeforeAfter", date, tag: tag || null, createdAt: new Date().toISOString(), sources, ...comparison };
  writeJsonOnce(join(outDir, `${stem}.json`), result);
  const md = renderMarkdown(comparison, { date });
  writeResultOnce(join(outDir, `${stem}.md`), md);
  console.log(md);
  process.exit(0);
}
