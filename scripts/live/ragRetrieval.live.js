import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isolateSharedInfrastructure, redact, stats, gitInfo } from "./lib/liveCommon.js";

// Live RAG retrieval evaluation. READ-ONLY: one Cohere query embedding per query and one Chroma
// similarity query per query against the production collection "farming-documents". No writes.
// Embedding and query parameters are the production ones (services/chat.service.js performRAG:
// Cohere AIConfig.embeddingModel, Chroma query, ragTopK); we request k=5 and also report the
// production top-3 prefix.
//
// Relevance rule (transparent, AUTHOR-DEFINED a priori, applied mechanically):
//   - Answerable query: a chunk is RELEVANT iff its filename matches the query's expected-file pattern
//     AND its text contains every required term group (case-insensitive substring; a group is a list of
//     spelling variants, any one of which counts). Groups are typically the district.
//   - Advisory query (the corpus has no advisory/how-to text): no chunk can be answer-bearing by
//     construction. We additionally report TOPICAL = chunk text contains the topic term group
//     (e.g. the crop), to show whether retrieval at least lands on the right crop.
// Usage: node scripts/live/ragRetrieval.live.js --date=2026-10-16

isolateSharedInfrastructure();
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const date = dateArg ? dateArg.slice(7) : new Date().toISOString().slice(0, 10);
const K = 5;

const { env } = await import("../../config/env.js");
const AIConfig = (await import("../../src/ai/AIConfig.js")).default;
const { CohereEmbeddings } = await import("@langchain/cohere");
const { CloudClient } = await import("chromadb");

const T = {
  thanjavur: ["thanjavur", "tanjore", "thanjavoor"],
  dindigul: ["dindigul"],
  krishnagiri: ["krishnagiri"],
  coimbatore: ["coimbatore"],
  villupuram: ["villupuram", "viluppuram", "vilupuram"],
  ramanathapuram: ["ramanathapuram", "ramnad"],
  nilgiris: ["nilgiris", "nilgiri"],
  tiruvarur: ["tiruvarur", "thiruvarur", "tiruvaru"],
  erode: ["erode"],
  salem: ["salem"],
  madurai: ["madurai"],
};

const QUERIES = [
  // answerable from the statistics corpus
  { id: "A1", kind: "answerable", q: "rice production in Thanjavur district 2017-18", file: /production_of_rice|production_of_total_cereals/i, groups: [T.thanjavur] },
  { id: "A2", kind: "answerable", q: "maize production in Dindigul district", file: /production_of_maize/i, groups: [T.dindigul] },
  { id: "A3", kind: "answerable", q: "ragi production in Krishnagiri", file: /production_of_ragi/i, groups: [T.krishnagiri] },
  { id: "A4", kind: "answerable", q: "soil nitrogen phosphorus potassium and pH values for Coimbatore", file: /soil data/i, groups: [T.coimbatore] },
  { id: "A5", kind: "answerable", q: "area irrigated by wells in Villupuram district", file: /irrigated_by_wells|total_area_irrigated/i, groups: [T.villupuram] },
  { id: "A6", kind: "answerable", q: "area irrigated by tanks in Ramanathapuram", file: /irrigated_by_tanks|total_area_irrigated/i, groups: [T.ramanathapuram] },
  { id: "A7", kind: "answerable", q: "tea area and production in the Nilgiris", file: /tea_2016/i, groups: [T.nilgiris] },
  { id: "A8", kind: "answerable", q: "black gram production in Tiruvarur district", file: /black_gram|total_pulses/i, groups: [T.tiruvarur] },
  { id: "A9", kind: "answerable", q: "sugarcane area and production in Erode district", file: /yield data|horizontal_|timeseries/i, groups: [T.erode, ["sugarcane"]] },
  { id: "A10", kind: "answerable", q: "coconut production in Salem district", file: /coconut/i, groups: [T.salem] },
  { id: "A11", kind: "answerable", q: "area under neem cultivation in Madurai", file: /neem/i, groups: [T.madurai] },
  { id: "A12", kind: "answerable", q: "rice pest incidence and weather observations (pest prediction data)", file: /RICE_PestPrediction/i, groups: [] },
  { id: "A13", kind: "answerable", q: "தஞ்சாவூர் மாவட்ட நெல் உற்பத்தி", lang: "ta", file: /production_of_rice|production_of_total_cereals/i, groups: [T.thanjavur] },
  // advisory questions the corpus cannot answer (no agronomic how-to text is ingested)
  { id: "B1", kind: "advisory", q: "how to control stem borer in paddy", topic: ["paddy", "rice", "stem borer"] },
  { id: "B2", kind: "advisory", q: "when should I irrigate sugarcane in summer", topic: ["sugarcane"] },
  { id: "B3", kind: "advisory", q: "how much urea per acre should I apply for paddy", topic: ["paddy", "rice", "urea"] },
  { id: "B4", kind: "advisory", q: "my banana leaves are turning yellow, what should I do", topic: ["banana"] },
  { id: "B5", kind: "advisory", q: "which crop should I grow after samba paddy in the Cauvery delta", topic: ["paddy", "rice", "samba"] },
  { id: "B6", kind: "advisory", q: "how to store harvested groundnut to avoid aflatoxin", topic: ["groundnut"] },
  { id: "B7", kind: "advisory", q: "how do I file a crop insurance claim under PMFBY", topic: ["insurance", "pmfby"] },
  { id: "B8", kind: "advisory", q: "neem oil spray dose for tomato fruit borer", topic: ["tomato"] },
  { id: "B9", kind: "advisory", q: "நெல் இலை மஞ்சள் ஆகிறது என்ன செய்வது", lang: "ta", topic: ["paddy", "rice", "நெல்"] },
];

const containsAny = (text, variants) => variants.some((v) => text.includes(v.toLowerCase()));
const fileOf = (m) => (m && (m.filename || String(m.source || "").split("/").pop())) || null;

const embeddings = new CohereEmbeddings({ apiKey: env.cohereApiKey, model: AIConfig.embeddingModel });
const client = new CloudClient({ apiKey: env.chromaApiKey, tenant: env.chromaTenant, database: env.chromaDatabase });
const collection = await client.getCollection({ name: "farming-documents" });
const chunkCount = await collection.count();

// Corpus composition (read-only paged get of metadata only).
const fileCounts = {};
for (let offset = 0; offset < chunkCount; offset += 250) {
  const page = await collection.get({ include: ["metadatas"], limit: 250, offset });
  for (const m of page.metadatas) { const f = fileOf(m); fileCounts[f] = (fileCounts[f] || 0) + 1; }
}
const kind = (f) => (/\.kml$/i.test(f) ? "kml_geography" : /\.xls$/i.test(f) ? "xls_html_table" : /\.csv$/i.test(f) ? "csv_statistics" : "other");
const composition = {};
for (const [f, c] of Object.entries(fileCounts)) composition[kind(f)] = (composition[kind(f)] || 0) + c;

const rows = [];
for (const item of QUERIES) {
  const t0 = performance.now();
  try {
    const vector = await embeddings.embedQuery(item.q);
    const t1 = performance.now();
    const res = await collection.query({ queryEmbeddings: [vector], nResults: K, include: ["documents", "metadatas", "distances"] });
    const t2 = performance.now();
    const docs = res.documents?.[0] || [];
    const metas = res.metadatas?.[0] || [];
    const dists = res.distances?.[0] || [];
    const hits = docs.map((doc, i) => {
      const text = String(doc || "").toLowerCase();
      const filename = fileOf(metas[i]);
      const fileOk = item.file ? item.file.test(filename || "") : false;
      const termsOk = (item.groups || []).every((g) => containsAny(text, g));
      return {
        rank: i + 1,
        filename,
        chunkIndex: metas[i] ? metas[i].chunk_index ?? null : null,
        distance: dists[i] !== undefined ? Math.round(dists[i] * 10000) / 10000 : null,
        fileKind: kind(filename || ""),
        relevant: item.kind === "answerable" ? fileOk && termsOk : false,
        fileMatch: item.kind === "answerable" ? fileOk : null,
        termsMatch: item.kind === "answerable" ? termsOk : null,
        topical: item.kind === "advisory" ? containsAny(text, item.topic) : null,
        headerOnly: /^File:/.test(String(doc || "").trim()) && !/Row \d+:/.test(String(doc || "")),
        snippet: String(doc || "").replace(/\s+/g, " ").slice(0, 160),
      };
    });
    rows.push({ id: item.id, kind: item.kind, lang: item.lang || "en", query: item.q, embedMs: Math.round(t1 - t0), queryMs: Math.round(t2 - t1), hits });
  } catch (error) {
    rows.push({ id: item.id, kind: item.kind, query: item.q, error: redact(error && error.message) });
  }
}

const ok = rows.filter((r) => !r.error);
const ans = ok.filter((r) => r.kind === "answerable");
const adv = ok.filter((r) => r.kind === "advisory");
const at = (r, k) => r.hits.slice(0, k);
const frac = (num, den) => ({ k: num, n: den, value: den ? Math.round((num / den) * 10000) / 10000 : null });
const summarize = (k) => ({
  answerable: {
    hitRateAnyRelevant: frac(ans.filter((r) => at(r, k).some((h) => h.relevant)).length, ans.length),
    top1Relevant: frac(ans.filter((r) => r.hits[0] && r.hits[0].relevant).length, ans.length),
    precisionOfChunks: frac(ans.reduce((s, r) => s + at(r, k).filter((h) => h.relevant).length, 0), ans.reduce((s, r) => s + at(r, k).length, 0)),
    anyExpectedFile: frac(ans.filter((r) => at(r, k).some((h) => h.fileMatch)).length, ans.length),
  },
  advisory: {
    answerBearingChunks: frac(0, adv.reduce((s, r) => s + at(r, k).length, 0)),
    topicalChunks: frac(adv.reduce((s, r) => s + at(r, k).filter((h) => h.topical).length, 0), adv.reduce((s, r) => s + at(r, k).length, 0)),
    queriesWithAnyTopicalChunk: frac(adv.filter((r) => at(r, k).some((h) => h.topical)).length, adv.length),
  },
  retrievedFileKinds: ok.flatMap((r) => at(r, k)).reduce((acc, h) => ({ ...acc, [h.fileKind]: (acc[h.fileKind] || 0) + 1 }), {}),
  answerableExpectedFileHitsThatAreHeaderOnly: frac(ans.flatMap((r) => at(r, k)).filter((h) => h.fileMatch && h.headerOnly).length, ans.flatMap((r) => at(r, k)).filter((h) => h.fileMatch).length),
  kmlChunksRetrieved: frac(ok.flatMap((r) => at(r, k)).filter((h) => h.fileKind === "kml_geography").length, ok.flatMap((r) => at(r, k)).length),
});

const result = {
  name: "ragRetrievalLive",
  date,
  ...(await gitInfo()),
  description: "Live retrieval from the production Chroma collection with production Cohere embeddings. Read-only.",
  config: { collection: "farming-documents", embeddingModel: AIConfig.embeddingModel, productionTopK: AIConfig.ragTopK, evaluatedK: K, distanceNote: "Chroma distance as returned by the collection (lower = closer); the collection's space was not altered or inspected beyond the query." },
  corpus: { chunks: chunkCount, files: Object.keys(fileCounts).length, chunksByFileKind: composition, chunksByFile: fileCounts },
  relevanceRule: "Answerable: relevant iff filename matches the a-priori expected-file pattern AND chunk text contains each required term group (district, and crop where stated). Advisory: answer-bearing is impossible by construction (no advisory text ingested); 'topical' = chunk text contains the topic term group. Labels are author-defined and mechanical; not human-judged.",
  queries: { total: QUERIES.length, answerable: QUERIES.filter((q) => q.kind === "answerable").length, advisory: QUERIES.filter((q) => q.kind === "advisory").length, errors: rows.filter((r) => r.error).length },
  summaryAtProductionTopK: summarize(AIConfig.ragTopK),
  summaryAtK5: summarize(K),
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
  ],
};

const outDir = join(root, "docs", "research", "evaluation", "live");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `rag_retrieval_${date}.json`), `${JSON.stringify(result, null, 2)}\n`);

const s3k = result.summaryAtProductionTopK; const s5 = result.summaryAtK5;
const pct = (f) => (f.value === null ? "n/a" : `${(f.value * 100).toFixed(1)}% (${f.k}/${f.n})`);
const md = `# Live RAG retrieval — ${date}

Production collection \`farming-documents\` (${chunkCount} chunks, ${Object.keys(fileCounts).length} files), Cohere \`${AIConfig.embeddingModel}\`, read-only queries. Commit ${result.commit}${result.dirtyWorkingTree ? " (dirty tree)" : ""}.

**Corpus composition (chunks):** ${Object.entries(composition).map(([k, v]) => `${k} ${v}`).join(", ")}. The corpus is statistical tables and a geography file, not advisory text.

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

**Main observed failure mode:** ingestion splits each table into a header chunk ("File: … Headers: …", no rows) and row chunks that carry neither the file name nor the crop. Queries find the right *file* through its header chunk, but the row naming the requested district is a separate chunk with no crop context, so it is rarely retrieved together with it. The model therefore usually receives column headers, or district rows of an unrelated crop table.

Top-1 distance: answerable median ${result.distances.top1Answerable.median}, advisory median ${result.distances.top1Advisory.median}.
Errors: ${result.queries.errors}. Full rows (filenames, distances, labels) in \`rag_retrieval_${date}.json\`.

Limitations: ${result.limitations.join(" ")}
`;
writeFileSync(join(outDir, `rag_retrieval_${date}.md`), md);
console.log(md);
process.exit(0);
