import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { writeJsonOnce, ResultExistsError, runLabelProblem } from "./lib/writeOnce.js";

// Parity check for the local RAG evaluator (plan A10). Compares a replay of the frozen evaluation
// (ragRetrieval.live.js --backend=json on the read-only production snapshot, or on the baseline corpus
// rebuilt with the legacy chunker) with the frozen 2026-10-16 baseline, row by row. For each query and
// rank 1..5: filename and chunkIndex equal, |distance difference| <= tolerance, every label equal and
// the snippet equal; both summaries and the corpus composition equal. Conditions (ii) and (iii) are
// only declared comparable with the baseline when this passes. No provider is called. Writes
// docs/research/evaluation/live/rag/rag_parity_<date>[_<tag>].json (write-once).
// Usage: node scripts/live/ragParity.js --candidate=<run json> [--baseline=<json>] [--date=YYYY-MM-DD]
//        [--tag=<tag>] [--tolerance=0.001] [--out-dir=<dir>]

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE = join(root, "docs", "research", "evaluation", "live", "rag_retrieval_2026-10-16.json");
export const LABELS = ["fileKind", "relevant", "fileMatch", "termsMatch", "topical", "headerOnly"];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export const compareRuns = (baseline, candidate, { tolerance = 1e-3, k = 5 } = {}) => {
  const diffs = [];
  const queries = [];
  const byId = new Map((candidate.rows || []).map((row) => [row.id, row]));
  for (const base of baseline.rows || []) {
    const cand = byId.get(base.id);
    const rowDiffs = [];
    if (!cand) rowDiffs.push({ rank: null, field: "row", baseline: base.id, candidate: null });
    else {
      if (cand.query !== base.query) rowDiffs.push({ rank: null, field: "query", baseline: base.query, candidate: cand.query });
      if (Boolean(cand.error) !== Boolean(base.error)) rowDiffs.push({ rank: null, field: "error", baseline: base.error || null, candidate: cand.error || null });
      const baseHits = (base.hits || []).slice(0, k);
      const candHits = (cand.hits || []).slice(0, k);
      for (let i = 0; i < Math.max(baseHits.length, candHits.length); i += 1) {
        const b = baseHits[i];
        const c = candHits[i];
        if (!b || !c) {
          rowDiffs.push({ rank: i + 1, field: "hit", baseline: b ? `${b.filename}#${b.chunkIndex}` : null, candidate: c ? `${c.filename}#${c.chunkIndex}` : null });
          continue;
        }
        for (const field of ["filename", "chunkIndex", ...LABELS, "snippet"]) {
          if (b[field] !== c[field]) rowDiffs.push({ rank: i + 1, field, baseline: b[field], candidate: c[field] });
        }
        const delta = typeof b.distance === "number" && typeof c.distance === "number" ? Math.abs(b.distance - c.distance) : null;
        if (delta === null || delta > tolerance) rowDiffs.push({ rank: i + 1, field: "distance", baseline: b.distance, candidate: c.distance, delta });
      }
      // Diagnostic only: the same top-k set in a different order points at query-vector drift.
      const set = (hits) => hits.map((h) => `${h.filename}#${h.chunkIndex}`).sort().join("|");
      queries.push({ id: base.id, identical: rowDiffs.length === 0, sameSetAnyOrder: set(baseHits) === set(candHits) });
    }
    diffs.push(...rowDiffs.map((d) => ({ id: base.id, ...d })));
  }
  for (const row of candidate.rows || []) {
    if (!(baseline.rows || []).some((base) => base.id === row.id)) diffs.push({ id: row.id, rank: null, field: "row", baseline: null, candidate: row.id });
  }
  const summaries = ["summaryAtProductionTopK", "summaryAtK5"].map((name) => ({ name, equal: isDeepStrictEqual(baseline[name], candidate[name]) }));
  const corpus = {
    chunksEqual: (baseline.corpus || {}).chunks === (candidate.corpus || {}).chunks,
    chunksByFileEqual: isDeepStrictEqual((baseline.corpus || {}).chunksByFile, (candidate.corpus || {}).chunksByFile),
  };
  const pass = diffs.length === 0 && summaries.every((s) => s.equal) && corpus.chunksEqual && corpus.chunksByFileEqual;
  return { pass, tolerance, k, diffs, queries, summaries, corpus };
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = (name) => {
    const found = process.argv.find((a) => a.startsWith(`--${name}=`));
    return found === undefined ? undefined : found.slice(name.length + 3);
  };
  const candidatePath = arg("candidate");
  if (!candidatePath) {
    console.error("--candidate=<ragRetrieval result json> is required");
    process.exit(1);
  }
  const date = arg("date") || new Date().toISOString().slice(0, 10);
  const tag = arg("tag");
  const labelProblem = runLabelProblem({ date, tag });
  if (labelProblem) {
    console.error(labelProblem);
    process.exit(64);
  }
  const tolerance = arg("tolerance") === undefined ? 1e-3 : Number(arg("tolerance"));
  const outPath = join(arg("out-dir") ? resolve(arg("out-dir")) : join(root, "docs", "research", "evaluation", "live", "rag"), `rag_parity_${date}${tag ? `_${tag}` : ""}.json`);
  if (existsSync(outPath)) {
    console.error(new ResultExistsError(outPath).message);
    process.exit(2);
  }
  const baselinePath = resolve(arg("baseline") || BASELINE);
  const baselineRaw = readFileSync(baselinePath);
  const candidateRaw = readFileSync(resolve(candidatePath));
  const candidate = JSON.parse(candidateRaw.toString("utf8"));
  const report = compareRuns(JSON.parse(baselineRaw.toString("utf8")), candidate, { tolerance });
  const { readProvenance, specSha256 } = await import("./verifyRagSpec.js");
  const pinnedSpecSha256 = readProvenance().spec.specSha256;
  const result = {
    name: "ragParity",
    date,
    tag: tag || null,
    verdict: report.pass ? "PASS" : "FAIL",
    baseline: { path: relative(root, baselinePath), sha256: sha256(baselineRaw) },
    candidate: {
      path: relative(root, resolve(candidatePath)),
      sha256: sha256(candidateRaw),
      backend: candidate.backend || null,
      condition: candidate.condition || null,
      specSha256: candidate.specSha256 || null,
      indexManifestSha256: candidate.indexManifestSha256 || null,
      queryVectorsSha256: candidate.queryVectorsSha256 || null,
    },
    specSha256Now: specSha256(),
    specMatchesCandidate: candidate.specSha256 === specSha256(),
    // Informational here; ragCompare.js refuses comparability unless every run used the pinned rule.
    pinnedSpecSha256,
    specMatchesPin: candidate.specSha256 === pinnedSpecSha256,
    ...report,
    note: "If ranks or distances drift because Cohere query embeddings are not bit-for-bit deterministic, the diffs show it; conditions (ii) and (iii) are only comparable with the baseline when the verdict is PASS.",
  };
  writeJsonOnce(outPath, result);
  console.log(JSON.stringify({ verdict: result.verdict, diffs: report.diffs.length, summaries: report.summaries, corpus: report.corpus, out: relative(root, outPath) }, null, 2));
  process.exit(report.pass ? 0 : 1);
}
