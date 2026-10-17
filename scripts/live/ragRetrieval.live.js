import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateSharedInfrastructure, redact, stats, gitInfo } from "./lib/liveCommon.js";
import { writeJsonOnce, writeResultOnce, ResultExistsError } from "./lib/writeOnce.js";
import { QUERIES, fileOf, kind, labelHits, labelHitsRowTextOnly, summarizer, summarizeRows } from "./lib/ragEvalSpec.js";
import { specSha256, verifyRagSpec } from "./verifyRagSpec.js";
import { ragCollectionName } from "../../config/ragConfig.js";

// Live RAG retrieval evaluation. READ-ONLY on every backend:
//   --backend=chroma-cloud (default): one Cohere query embedding per query (unless --query-vectors is
//     given) and one similarity query per query against the Chroma Cloud collection (--collection,
//     default RAG_COLLECTION, i.e. the production "farming-documents"). No writes.
//   --backend=json: the same queries against a local index directory (--index=<dir>, built by
//     rag/buildLocalIndex.js or scripts/live/ragSnapshotProd.js) with exact squared-L2 search
//     (rag/localIndex.js). Needs --query-vectors=<file> (scripts/live/ragEmbedQueries.js), so every
//     condition uses identical query vectors and no provider is called at all.
// Embedding and query parameters are the production ones (services/chat.service.js performRAG:
// Cohere AIConfig.embeddingModel, Chroma query, ragTopK); we request k=5 and also report the
// production top-3 prefix.
//
// Relevance rule (transparent, AUTHOR-DEFINED a priori, applied mechanically). The rule is frozen in
// scripts/live/lib/ragEvalSpec.js (moved verbatim from this file at 6dbe6b8; its sha256 is recorded
// in every result as specSha256):
//   - Answerable query: a chunk is RELEVANT iff its filename matches the query's expected-file pattern
//     AND its text contains every required term group (case-insensitive substring; a group is a list of
//     spelling variants, any one of which counts). Groups are typically the district.
//   - Advisory query (the corpus has no advisory/how-to text): no chunk can be answer-bearing by
//     construction. We additionally report TOPICAL = chunk text contains the topic term group
//     (e.g. the crop), to show whether retrieval at least lands on the right crop.
// Each result also carries a row-text-only sensitivity summary: the same rule applied to the chunk
// text without its File:/Table:/Columns:/Headers:/Data: lines (design critique E5).
// Before any provider or index work the spec is checked against its pin
// (scripts/live/lib/ragEvalSpec.provenance.json, via verifyRagSpec.js); a run on an edited rule is
// refused, so every result is labelled by the rule pinned against 6dbe6b8.
//
// Results are write-once (scripts/live/lib/writeOnce.js). A tag is required for --backend=json and
// for the date 2026-10-16, so the frozen baseline rag_retrieval_2026-10-16.{json,md} can never be
// overwritten. Tagged results go to docs/research/evaluation/live/rag/rag_retrieval_<date>_<tag>.*.
// Usage: node scripts/live/ragRetrieval.live.js --date=2026-10-20 [--backend=json --index=<dir>
//        --query-vectors=<file>] [--collection=<name>] [--tag=<tag>] [--condition=<label>]
//        [--out-dir=<dir>] (default docs/research/evaluation/live[/rag])

isolateSharedInfrastructure();
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FROZEN_BASELINE_DATE = "2026-10-16";
const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
};
const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const date = arg("date") || new Date().toISOString().slice(0, 10);
const backend = arg("backend") || "chroma-cloud";
const tag = arg("tag");
const indexArg = arg("index");
const queryVectorsArg = arg("query-vectors");
const K = 5;

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got "${date}"`);
if (!["chroma-cloud", "json"].includes(backend)) fail(`--backend must be chroma-cloud or json, got "${backend}"`);
if (tag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(tag)) fail(`--tag must be 1-100 characters of [A-Za-z0-9._-], got "${tag}"`);
if (backend === "json" && !tag) fail("--backend=json needs --tag=<tag>");
if (date === FROZEN_BASELINE_DATE && !tag) fail(`--date=${FROZEN_BASELINE_DATE} is the frozen baseline; pass --tag=<tag> for any new run`, 2);
if (backend === "json" && !indexArg) fail("--backend=json needs --index=<dir>");
if (backend === "json" && !queryVectorsArg) fail("--backend=json needs --query-vectors=<file> so every condition uses the same query vectors");
const condition = arg("condition") || tag || "production";

const outDir = arg("out-dir") ? resolve(arg("out-dir")) : tag ? join(root, "docs", "research", "evaluation", "live", "rag") : join(root, "docs", "research", "evaluation", "live");
const stem = tag ? `rag_retrieval_${date}_${tag}` : `rag_retrieval_${date}`;
const jsonPath = join(outDir, `${stem}.json`);
const mdPath = join(outDir, `${stem}.md`);
// Refuse before any provider call.
for (const path of [jsonPath, mdPath]) if (existsSync(path)) fail(new ResultExistsError(path).message, 2);
// Refuse an unpinned rule, also before any provider call. Git history is compared when available.
let specCheck;
try {
  specCheck = verifyRagSpec();
} catch (error) {
  fail(`Could not verify the frozen RAG rule: ${error.message}`);
}
if (!specCheck.ok) fail(`The RAG evaluation rule does not match its pin (run node scripts/live/verifyRagSpec.js): ${specCheck.errors.join("; ")}`);

const { env } = await import("../../config/env.js");
const AIConfig = (await import("../../src/ai/AIConfig.js")).default;

// Cached query vectors: checked against the frozen QUERIES so a stale cache can never be used.
let queryVectors = null;
let queryVectorsSha256 = null;
if (queryVectorsArg) {
  const raw = readFileSync(resolve(queryVectorsArg));
  queryVectorsSha256 = sha256(raw);
  const cache = JSON.parse(raw.toString("utf8"));
  if (cache.model !== AIConfig.embeddingModel) fail(`Query vectors were made with ${cache.model}, not ${AIConfig.embeddingModel}`);
  if (cache.inputType !== "search_query") fail(`Query vectors have inputType ${cache.inputType}, expected search_query`);
  queryVectors = new Map();
  for (const item of QUERIES) {
    const entry = (cache.queries || []).find((q) => q.id === item.id);
    if (!entry || entry.qSha256 !== sha256(item.q)) fail(`Query vectors do not match the frozen query ${item.id}`);
    queryVectors.set(item.id, entry.vector);
  }
}

let collection;
let collectionName = null;
let indexInfo = null;
if (backend === "json") {
  const { loadLocalIndex } = await import("../../rag/localIndex.js");
  const index = loadLocalIndex(resolve(indexArg));
  collection = index;
  indexInfo = {
    path: relative(root, index.dir),
    manifestSha256: index.manifestSha256,
    tag: index.manifest.tag ?? null,
    chunker: index.manifest.chunker ?? null,
    corpus: index.manifest.corpus ?? null,
    source: index.manifest.source ?? null,
    model: index.manifest.model ?? null,
    count: index.manifest.count,
  };
} else {
  const { CloudClient } = await import("chromadb");
  collectionName = arg("collection") ? ragCollectionName(arg("collection")) : ragCollectionName();
  const client = new CloudClient({ apiKey: env.chromaApiKey, tenant: env.chromaTenant, database: env.chromaDatabase });
  collection = await client.getCollection({ name: collectionName });
}
let embeddings = null;
if (!queryVectors) {
  const { CohereEmbeddings } = await import("@langchain/cohere");
  embeddings = new CohereEmbeddings({ apiKey: env.cohereApiKey, model: AIConfig.embeddingModel });
}
const chunkCount = await collection.count();

// Corpus composition (read-only paged get of metadata only).
const fileCounts = {};
for (let offset = 0; offset < chunkCount; offset += 250) {
  const page = await collection.get({ include: ["metadatas"], limit: 250, offset });
  for (const m of page.metadatas) { const f = fileOf(m); fileCounts[f] = (fileCounts[f] || 0) + 1; }
}
const composition = {};
for (const [f, c] of Object.entries(fileCounts)) composition[kind(f)] = (composition[kind(f)] || 0) + c;

const rows = [];
for (const item of QUERIES) {
  const t0 = performance.now();
  try {
    const vector = queryVectors ? queryVectors.get(item.id) : await embeddings.embedQuery(item.q);
    const t1 = performance.now();
    const res = await collection.query({ queryEmbeddings: [vector], nResults: K, include: ["documents", "metadatas", "distances"] });
    const t2 = performance.now();
    const docs = res.documents?.[0] || [];
    const metas = res.metadatas?.[0] || [];
    const dists = res.distances?.[0] || [];
    const hits = labelHits(item, docs, metas, dists);
    const rowTextOnly = labelHitsRowTextOnly(item, docs, metas, dists);
    rows.push({ id: item.id, kind: item.kind, lang: item.lang || "en", query: item.q, embedMs: queryVectors ? null : Math.round(t1 - t0), queryMs: Math.round(t2 - t1), hits, rowTextOnly });
  } catch (error) {
    rows.push({ id: item.id, kind: item.kind, query: item.q, error: redact(error && error.message) });
  }
}

const { ok, ans, adv } = summarizer(rows);
// Sensitivity rows: the same hits with the term-dependent labels taken from row text only.
const rowTextRows = rows.map((r) => (r.error ? r : { ...r, hits: r.hits.map((h, i) => ({ ...h, ...r.rowTextOnly[i] })) }));

const gitState = await gitInfo();
const ruleSha256 = specSha256(); // re-read: an edit during the run shows up as specPinned false
const result = {
  name: "ragRetrievalLive",
  date,
  ...gitState,
  dirty: gitState.dirtyWorkingTree,
  backend,
  condition,
  tag: tag || null,
  specSha256: ruleSha256,
  specPinned: specCheck.ok && ruleSha256 === specCheck.pinnedSpecSha256,
  pinnedSpecSha256: specCheck.pinnedSpecSha256,
  specGitChecked: specCheck.git.checked,
  indexManifestSha256: indexInfo ? indexInfo.manifestSha256 : null,
  queryVectorsSha256,
  description: backend === "json"
    ? "Retrieval from a local index (rag/localIndex.js, exact squared L2) with cached Cohere query vectors. No provider was called and nothing was written."
    : "Live retrieval from a Chroma Cloud collection with production Cohere embeddings. Read-only.",
  config: {
    backend,
    collection: collectionName,
    index: indexInfo,
    queryVectors: queryVectorsArg ? relative(root, resolve(queryVectorsArg)) : null,
    embeddingModel: AIConfig.embeddingModel,
    productionTopK: AIConfig.ragTopK,
    evaluatedK: K,
    distanceNote: backend === "json"
      ? "Squared L2 over the stored float32 vectors, computed locally (Chroma's default l2 space); lower = closer; ties broken by index order."
      : "Chroma distance as returned by the collection (lower = closer); the collection's space was not altered or inspected beyond the query.",
  },
  corpus: { chunks: chunkCount, files: Object.keys(fileCounts).length, chunksByFileKind: composition, chunksByFile: fileCounts },
  relevanceRule: "Answerable: relevant iff filename matches the a-priori expected-file pattern AND chunk text contains each required term group (district, and crop where stated). Advisory: answer-bearing is impossible by construction (no advisory text ingested); 'topical' = chunk text contains the topic term group. Labels are author-defined and mechanical; not human-judged.",
  queries: { total: QUERIES.length, answerable: QUERIES.filter((q) => q.kind === "answerable").length, advisory: QUERIES.filter((q) => q.kind === "advisory").length, errors: rows.filter((r) => r.error).length },
  summaryAtProductionTopK: summarizeRows(rows, AIConfig.ragTopK),
  summaryAtK5: summarizeRows(rows, K),
  sensitivity: {
    rowTextOnly: {
      rule: "Same frozen rule, applied to the chunk text without its File:/Table:/Columns:/Headers:/Data: lines, so a term counts only when it occurs in row text. Header names repeated inside 'header: value' pairs still count.",
      summaryAtProductionTopK: summarizeRows(rowTextRows, AIConfig.ragTopK),
      summaryAtK5: summarizeRows(rowTextRows, K),
    },
  },
  distances: {
    top1Answerable: stats(ans.map((r) => r.hits[0] && r.hits[0].distance)),
    top1Advisory: stats(adv.map((r) => r.hits[0] && r.hits[0].distance)),
    relevantChunks: stats(ans.flatMap((r) => r.hits.filter((h) => h.relevant).map((h) => h.distance))),
    irrelevantChunksAnswerable: stats(ans.flatMap((r) => r.hits.filter((h) => !h.relevant).map((h) => h.distance))),
  },
  latencyMs: { embed: stats(ok.map((r) => r.embedMs)), query: stats(ok.map((r) => r.queryMs)) },
  rows,
  limitations: [
    "The corpus is district-level agricultural STATISTICS (CSV/XLS tables) plus a Tamil Nadu KML geography file; it contains no agronomic advisory text, so advisory questions cannot be grounded in it whatever the retriever does.",
    "Relevance labels come from an author-written mechanical rule (filename pattern + term match), not human relevance judgements; a chunk can contain the district name and still not hold the requested number (chunking splits tables).",
    "Embeddings are English-only (embed-english-v3.0); the Tamil queries are included to show the effect, n=2.",
    "~20 queries; rates have wide uncertainty.",
    ...(backend === "json" ? ["Local exact search, not the production HNSW index; the parity check (scripts/live/ragParity.js) shows whether local search reproduces the production baseline."] : []),
  ],
};

try {
  writeJsonOnce(jsonPath, result);
} catch (error) {
  fail(error.message, error.exitCode || 1);
}

const s3k = result.summaryAtProductionTopK; const s5 = result.summaryAtK5;
const r3 = result.sensitivity.rowTextOnly.summaryAtProductionTopK; const r5 = result.sensitivity.rowTextOnly.summaryAtK5;
const pct = (f) => (f.value === null ? "n/a" : `${(f.value * 100).toFixed(1)}% (${f.k}/${f.n})`);
const where = backend === "json"
  ? `Local index \`${indexInfo.path}\` (${indexInfo.chunker || "unknown chunker"}, ${chunkCount} chunks, ${Object.keys(fileCounts).length} files), cached query vectors, exact squared-L2 search`
  : `Chroma Cloud collection \`${collectionName}\` (${chunkCount} chunks, ${Object.keys(fileCounts).length} files), Cohere \`${AIConfig.embeddingModel}\`, read-only queries`;
const md = `# RAG retrieval — ${date}${tag ? ` — ${tag}` : ""}

${where}. Condition: ${condition}. Commit ${result.commit}${result.dirtyWorkingTree ? " (dirty tree)" : ""}. Rule specSha256 \`${result.specSha256}\` (${result.specPinned ? "matches the pin" : "DOES NOT match the pin"}).

**Corpus composition (chunks):** ${Object.entries(composition).map(([k, v]) => `${k} ${v}`).join(", ")}.

Relevance is a mechanical, author-defined rule (expected filename pattern + district/crop terms), not human judgement.

| Metric | top-${AIConfig.ragTopK} (production) | top-5 |
|---|---|---|
| Answerable (n=${ans.length}): any relevant chunk | ${pct(s3k.answerable.hitRateAnyRelevant)} | ${pct(s5.answerable.hitRateAnyRelevant)} |
| Answerable: top-1 relevant | ${pct(s3k.answerable.top1Relevant)} | ${pct(s5.answerable.top1Relevant)} |
| Answerable: chunk precision | ${pct(s3k.answerable.precisionOfChunks)} | ${pct(s5.answerable.precisionOfChunks)} |
| Answerable: expected file retrieved at all | ${pct(s3k.answerable.anyExpectedFile)} | ${pct(s5.answerable.anyExpectedFile)} |
| Advisory (n=${adv.length}): answer-bearing chunks | ${pct(s3k.advisory.answerBearingChunks)} | ${pct(s5.advisory.answerBearingChunks)} |
| Advisory: chunks merely topical (crop term present) | ${pct(s3k.advisory.topicalChunks)} | ${pct(s5.advisory.topicalChunks)} |
| Answerable: expected-file hits that are header-only chunks (no data rows) | ${pct(s3k.answerableExpectedFileHitsThatAreHeaderOnly)} | ${pct(s5.answerableExpectedFileHitsThatAreHeaderOnly)} |
| All retrieved chunks from the KML geography file | ${pct(s3k.kmlChunksRetrieved)} | ${pct(s5.kmlChunksRetrieved)} |
| Sensitivity, row text only: answerable any relevant chunk | ${pct(r3.answerable.hitRateAnyRelevant)} | ${pct(r5.answerable.hitRateAnyRelevant)} |
| Sensitivity, row text only: answerable chunk precision | ${pct(r3.answerable.precisionOfChunks)} | ${pct(r5.answerable.precisionOfChunks)} |
| Sensitivity, row text only: advisory topical chunks | ${pct(r3.advisory.topicalChunks)} | ${pct(r5.advisory.topicalChunks)} |

Top-1 distance: answerable median ${result.distances.top1Answerable.median}, advisory median ${result.distances.top1Advisory.median}.
Errors: ${result.queries.errors}. Full rows (filenames, distances, labels) in \`${stem}.json\`.

Limitations: ${result.limitations.join(" ")}
`;
try {
  writeResultOnce(mdPath, md);
} catch (error) {
  fail(error.message, error.exitCode || 1);
}
console.log(md);
process.exit(0);
