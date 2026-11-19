import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonOnce, writeResultOnce } from "./lib/writeOnce.js";
import { QUERIES, labelHits } from "./lib/ragEvalSpec.js";
import { exactMcNemar } from "./ragCompare.js";

// Mechanical-rule metrics for the 13 answerable queries, for each retrieval run: top-1/3/5 hit rate,
// Precision@3/5, MRR and Recall@3/5. These are NOT human relevance metrics; the 9 advisory queries have
// no labels here and are excluded. Recall's denominator is every chunk of that run's index that the
// frozen rule marks relevant (--conditions supplies the index directory).
// Usage: node scripts/live/ragMetrics.js --date=<d> --conditions=<name>=<run.json>=<index dir or ->,... --out=<stem>

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};

export const answerableMetrics = (rows, relevantTotals) => {
  const answerable = rows.filter((row) => row.kind === "answerable" && !row.error);
  const n = answerable.length;
  const hitAt = (row, k) => row.hits.slice(0, k).some((hit) => hit.relevant);
  const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
  const precision = (k) => mean(answerable.map((row) => row.hits.slice(0, k).filter((hit) => hit.relevant).length / k));
  const recall = (k) => (relevantTotals ? mean(answerable.filter((row) => relevantTotals[row.id] > 0).map((row) => row.hits.slice(0, k).filter((hit) => hit.relevant).length / relevantTotals[row.id])) : null);
  const queriesWithNoRelevant = relevantTotals ? answerable.filter((row) => relevantTotals[row.id] === 0).map((row) => row.id) : null;
  return {
    n,
    hit1: { k: answerable.filter((row) => hitAt(row, 1)).length, n },
    hit3: { k: answerable.filter((row) => hitAt(row, 3)).length, n },
    hit5: { k: answerable.filter((row) => hitAt(row, 5)).length, n },
    precision3: precision(3),
    precision5: precision(5),
    recall3: recall(3),
    recall5: recall(5),
    mrr: mean(answerable.map((row) => {
      const first = row.hits.findIndex((hit) => hit.relevant);
      return first >= 0 ? 1 / (first + 1) : 0;
    })),
    queriesWithNoRelevant,
  };
};

export const relevantTotalsFor = (documents, metadatas) => {
  const totals = {};
  for (const item of QUERIES.filter((q) => q.kind === "answerable")) {
    totals[item.id] = labelHits(item, documents, metadatas, documents.map(() => 0)).filter((hit) => hit.relevant).length;
  }
  return totals;
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const { loadLocalIndex } = await import("../../rag/localIndex.js");
  const conditions = [];
  for (const spec of arg("conditions").split(",")) {
    const [name, runPath, indexDir] = spec.split("=");
    const raw = readFileSync(resolve(runPath), "utf8").replace(/\r\n/g, "\n");
    const run = JSON.parse(raw);
    let totals = null;
    if (indexDir && indexDir !== "-") {
      const index = loadLocalIndex(resolve(indexDir));
      const all = await index.get({ include: ["documents", "metadatas"], limit: await index.count(), offset: 0 });
      totals = relevantTotalsFor(all.documents, all.metadatas);
    }
    conditions.push({ name, source: runPath, runSha256: sha256(raw), condition: run.condition ?? name, specSha256: run.specSha256 ?? null, indexManifestSha256: run.indexManifestSha256 ?? null, queryVectorsSha256: run.queryVectorsSha256 ?? null, retrieval: run.config?.retrieval ?? null, relevantTotals: totals, metrics: answerableMetrics(run.rows, totals), rows: run.rows });
  }
  const hit = (row, k) => row && row.hits.slice(0, k).some((h) => h.relevant);
  const reference = conditions[0];
  const paired = conditions.slice(1).flatMap((c) => [3, 5].map((k) => {
    let b = 0;
    let d = 0;
    for (const row of reference.rows.filter((r) => r.kind === "answerable" && !r.error)) {
      const other = c.rows.find((r) => r.id === row.id);
      if (!hit(row, k) && hit(other, k)) b += 1;
      if (hit(row, k) && !hit(other, k)) d += 1;
    }
    return { reference: reference.name, candidate: c.name, k, ...exactMcNemar(b, d), underpowered: true };
  }));
  const result = { name: "ragMechanicalMetrics", date: arg("date"), groundTruth: "frozen author-defined mechanical rule; answerable queries only (n=13); NOT human relevance", conditions: conditions.map(({ rows, ...rest }) => rest), paired };
  writeJsonOnce(resolve(`${arg("out")}.json`), result);
  const f = (v) => (v === null || v === undefined ? "n/a" : v.toFixed(3));
  const lines = ["| Condition | Top-1 | Top-3 | Top-5 | P@3 | P@5 | R@3 | R@5 | MRR |", "|---|---|---|---|---|---|---|---|---|", ...conditions.map(({ name, metrics: m }) => `| ${name} | ${m.hit1.k}/${m.n} | ${m.hit3.k}/${m.n} | ${m.hit5.k}/${m.n} | ${f(m.precision3)} | ${f(m.precision5)} | ${f(m.recall3)} | ${f(m.recall5)} | ${f(m.mrr)} |`), "", "Paired exact McNemar on hit@k against the first condition (n=13, underpowered):", "", "| Candidate | k | b (ref miss, cand hit) | c (ref hit, cand miss) | p |", "|---|---|---|---|---|", ...paired.map((p) => `| ${p.candidate} | ${p.k} | ${p.b} | ${p.c} | ${p.pValue.toFixed(4)} |`)];
  writeResultOnce(resolve(`${arg("out")}.md`), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  process.exit(0);
}
