import { createHash } from "node:crypto";

// Human relevance assessment: pooling, blinding, label validation, inter-assessor agreement,
// adjudication and metrics. Pure functions; scripts/live/ragHumanEval.js does the file handling.
//
// Grades: 2 answer-bearing, 1 topical only, 0 not relevant, U cannot judge. An empty cell is UNJUDGED
// and stays unjudged: it is never counted as not relevant. Every label file must say the assessor type
// is "human", and any other type (an LLM, a script) is rejected, so model output cannot enter ground
// truth.

export const GRADES = Object.freeze(["2", "1", "0", "U"]);
export const poolId = (queryId, text) => `${queryId}-${createHash("sha256").update(String(text)).digest("hex").slice(0, 12)}`;

// One blinded item per distinct (query, chunk text) across every run. Order is by pool id, a hash, so
// neither rank nor condition can be read from a packet. The conditions stay in the separate key.
export const buildPool = (runs) => {
  const pool = new Map();
  for (const { condition, rows } of runs) {
    for (const row of rows) {
      if (row.error || !row.rawHits) continue;
      row.rawHits.forEach((hit, i) => {
        const id = poolId(row.id, hit.document);
        if (!pool.has(id)) pool.set(id, { pool_id: id, query_id: row.id, query: row.query, chunk_text: hit.document, source_url: hit.metadata?.source || hit.metadata?.filename || "", appearsIn: [] });
        pool.get(id).appearsIn.push({ condition, rank: i + 1 });
      });
    }
  }
  return [...pool.values()].sort((a, b) => a.pool_id.localeCompare(b.pool_id));
};

// labels: [{pool_id, label, assessor_id, assessor_type, notes?}] as read from a returned packet.
export const validateLabels = (labels, poolIds) => {
  const known = new Set(poolIds);
  const errors = [];
  const seen = new Set();
  const assessors = new Set();
  labels.forEach((row, i) => {
    const where = `row ${i + 1}`;
    if (row.assessor_type !== "human") errors.push(`${where}: assessor_type must be "human", got "${row.assessor_type ?? ""}"`);
    if (!row.assessor_id) errors.push(`${where}: assessor_id is required`);
    if (!known.has(row.pool_id)) errors.push(`${where}: unknown pool_id ${row.pool_id}`);
    if (seen.has(row.pool_id)) errors.push(`${where}: duplicate pool_id ${row.pool_id}`);
    seen.add(row.pool_id);
    if (row.label !== "" && row.label !== undefined && !GRADES.includes(String(row.label))) errors.push(`${where}: label must be 2, 1, 0, U or empty, got "${row.label}"`);
    assessors.add(row.assessor_id);
  });
  if (assessors.size > 1) errors.push(`one file must hold one assessor, found ${assessors.size}`);
  return { ok: errors.length === 0, errors, assessor: [...assessors][0] ?? null, unjudged: labels.filter((row) => row.label === "" || row.label === undefined).length };
};

const kappa = (pairs, categories) => {
  const n = pairs.length;
  if (n === 0) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  let chance = 0;
  for (const category of categories) chance += (pairs.filter(([a]) => a === category).length / n) * (pairs.filter(([, b]) => b === category).length / n);
  return chance === 1 ? null : (observed - chance) / (1 - chance);
};

// Agreement on items both assessors graded 0/1/2. U and empty are excluded and counted.
export const agreement = (labelsA, labelsB) => {
  const b = new Map(labelsB.map((row) => [row.pool_id, String(row.label ?? "")]));
  const graded = ["0", "1", "2"];
  const pairs = labelsA.map((row) => [String(row.label ?? ""), b.get(row.pool_id) ?? ""]).filter(([x, y]) => graded.includes(x) && graded.includes(y));
  const binary = pairs.map(([x, y]) => [x === "2" ? "1" : "0", y === "2" ? "1" : "0"]);
  return { compared: pairs.length, excluded: labelsA.length - pairs.length, exactAgreement: pairs.length ? pairs.filter(([x, y]) => x === y).length / pairs.length : null, cohenKappa: kappa(pairs, graded), cohenKappaAnswerBearing: kappa(binary, ["0", "1"]) };
};

// Items that need a third, human adjudicator: the assessors differ, or either said U.
export const disagreements = (labelsA, labelsB) => {
  const b = new Map(labelsB.map((row) => [row.pool_id, String(row.label ?? "")]));
  return labelsA.map((row) => ({ pool_id: row.pool_id, a: String(row.label ?? ""), b: b.get(row.pool_id) ?? "" })).filter(({ a, b: other }) => a !== other || a === "U");
};

// Final grade per item: agreed grades, overridden by human adjudication rows. Unresolved stay absent.
export const finalQrels = (labelsA, labelsB, adjudicated = []) => {
  const qrels = new Map();
  const b = new Map(labelsB.map((row) => [row.pool_id, String(row.label ?? "")]));
  for (const row of labelsA) {
    const a = String(row.label ?? "");
    if (["0", "1", "2"].includes(a) && a === b.get(row.pool_id)) qrels.set(row.pool_id, a);
  }
  for (const row of adjudicated) {
    if (row.assessor_type !== "human") throw new Error(`adjudication for ${row.pool_id} must have assessor_type "human"`);
    if (["0", "1", "2"].includes(String(row.label))) qrels.set(row.pool_id, String(row.label));
  }
  return qrels;
};

// Metrics at k for one run, where "relevant" means grade 2 (answer-bearing). Unjudged items are not
// treated as irrelevant: precision is over judged items and unjudged counts are reported. Recall is
// pooled: its denominator is the relevant items found in the assessed pool, not the whole corpus.
export const humanMetrics = (rows, qrels, k) => {
  const perQuery = [];
  for (const row of rows.filter((r) => !r.error && r.rawHits)) {
    const grades = row.rawHits.slice(0, k).map((hit) => qrels.get(poolId(row.id, hit.document)));
    const judged = grades.filter((grade) => grade !== undefined);
    const relevant = grades.filter((grade) => grade === "2").length;
    const allRelevant = [...qrels.entries()].filter(([id, grade]) => grade === "2" && id.startsWith(`${row.id}-`)).length;
    const first = grades.findIndex((grade) => grade === "2");
    perQuery.push({ id: row.id, kind: row.kind, retrieved: grades.length, judged: judged.length, unjudged: grades.length - judged.length, hit: relevant > 0, precisionJudged: judged.length ? relevant / judged.length : null, recallPooled: allRelevant ? relevant / allRelevant : null, reciprocalRank: first >= 0 ? 1 / (first + 1) : 0 });
  }
  const mean = (values) => {
    const present = values.filter((v) => v !== null);
    return present.length ? present.reduce((sum, v) => sum + v, 0) / present.length : null;
  };
  return { k, relevantGrade: 2, queries: perQuery.length, hitRate: mean(perQuery.map((q) => (q.hit ? 1 : 0))), precisionJudged: mean(perQuery.map((q) => q.precisionJudged)), recallPooled: mean(perQuery.map((q) => q.recallPooled)), mrr: mean(perQuery.map((q) => q.reciprocalRank)), unjudgedRetrieved: perQuery.reduce((sum, q) => sum + q.unjudged, 0), perQuery };
};

export const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
