// Frozen RAG retrieval evaluation rule (plan A10, D3).
//
// The relevance rule behind the 2026-10-16 baseline (docs/research/evaluation/live/
// rag_retrieval_2026-10-16.json) lived only inside scripts/live/ragRetrieval.live.js. It lives here
// now, so every condition (the frozen baseline, the parity replay, the legacy chunker on the new
// corpus, and table-v1) is labelled and summarised by the same code.
//
// Each `// <frozen:NAME>` block is a byte-for-byte copy of lines of
// `git show 6dbe6b8:scripts/live/ragRetrieval.live.js`:
//   T 32-44, QUERIES 46-71, helpers 73-74 (containsAny, fileOf), kind 87, labelHits 102-120,
//   partition 127-129, summarize 130-147.
// labelHits sat inside the query loop and summarize closed over script-level rows, so both are
// wrapped in functions below. Their lines keep the original indentation so they hash to the pins.
//
// ragEvalSpec.provenance.json pins the sha256 of every block and of this whole file (specSha256,
// recorded in every result). scripts/live/verifyRagSpec.js re-checks the pins against git history
// (tests RS-1 and RS-3). Do not edit a frozen block. Any other edit to this file changes specSha256,
// so a changed rule can never pass silently as the old one.

export const SPEC_SOURCE_COMMIT = "6dbe6b8";
export const SPEC_SOURCE_PATH = "scripts/live/ragRetrieval.live.js";

// <frozen:T>
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
// </frozen:T>

// <frozen:QUERIES>
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
// </frozen:QUERIES>

// <frozen:helpers>
const containsAny = (text, variants) => variants.some((v) => text.includes(v.toLowerCase()));
const fileOf = (m) => (m && (m.filename || String(m.source || "").split("/").pop())) || null;
// </frozen:helpers>

// <frozen:kind>
const kind = (f) => (/\.kml$/i.test(f) ? "kml_geography" : /\.xls$/i.test(f) ? "xls_html_table" : /\.csv$/i.test(f) ? "csv_statistics" : "other");
// </frozen:kind>

// Labels the hits of one query. `docs`, `metas` and `dists` are the first row of a Chroma-style
// query result (documents[0], metadatas[0], distances[0]); `item` is one QUERIES entry.
export const labelHits = (item, docs, metas, dists) => {
// <frozen:labelHits>
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
// </frozen:labelHits>
  return hits;
};

// One hit at zero-based position `i` (rank i + 1), through the same frozen body.
export const labelHit = (item, doc, meta, distance, i = 0) => ({ ...labelHits(item, [doc], [meta], [distance])[0], rank: i + 1 });

// The frozen metric helpers bound to one set of evaluation rows ({id, kind, hits} or {id, error}).
// `summarize(k)` is the 6dbe6b8 function unchanged.
export const summarizer = (rows) => {
// <frozen:partition>
const ok = rows.filter((r) => !r.error);
const ans = ok.filter((r) => r.kind === "answerable");
const adv = ok.filter((r) => r.kind === "advisory");
// </frozen:partition>
// <frozen:summarize>
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
// </frozen:summarize>
  return { ok, ans, adv, at, frac, summarize };
};

export const summarizeRows = (rows, k) => summarizer(rows).summarize(k);

export { T, QUERIES, containsAny, fileOf, kind };

// ---------------------------------------------------------------------------------------------
// Not part of the 6dbe6b8 rule: the row-text-only sensitivity check (design critique E5).
//
// table-v1 puts `File:` / `Table:` / `Columns:` lines in every chunk, and the file name alone can
// satisfy a term group (e.g. "production_of_rice" for an advisory "rice" topic). The sensitivity
// labels apply the SAME frozen labelHits to the chunk text with those preamble lines removed (and
// the legacy `Headers:` / `Data:` lines), so a term only counts when it occurs in row text. Header
// names still count when a row repeats them as "header: value"; ragCompare.js states that caveat.
export const PREAMBLE_LINE = /^(File|Table|Columns|Headers|Data):/;

export const rowTextOf = (doc) =>
  String(doc || "")
    .split("\n")
    .filter((line) => !PREAMBLE_LINE.test(line.trim()))
    .join("\n");

// Only the term-dependent labels are meaningful on row text; headerOnly and snippet are not kept.
export const labelHitsRowTextOnly = (item, docs, metas, dists) =>
  labelHits(item, docs.map(rowTextOf), metas, dists).map((hit) => ({
    rank: hit.rank,
    relevant: hit.relevant,
    termsMatch: hit.termsMatch,
    topical: hit.topical,
  }));
