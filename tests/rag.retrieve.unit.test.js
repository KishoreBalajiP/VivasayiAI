import { describe, expect, it } from "vitest";
import { analyzeQuery, retrieveEvidence, scoreHit } from "../rag/retrieve.js";
import { advisoryToChunks, tableToChunks, MIN_ADVISORY_BODY_CHARS } from "../rag/ingestHelpers.js";
import { dropMenuRuns, extractLinks, htmlToText, isCrawlableLink } from "../rag/advisorySources.js";
import { agreement, buildPool, disagreements, finalQrels, humanMetrics, poolId, validateLabels } from "../scripts/live/lib/ragHumanEval.js";
import { answerableMetrics } from "../scripts/live/ragMetrics.js";

// Chroma-shaped stub. `where` is honoured so filtering is exercised.
const collection = (rows) => ({
  async query({ where, nResults }) {
    const hits = rows.filter((r) => !where || Object.entries(where).every(([k, v]) => r.metadata[k] === v)).sort((a, b) => a.distance - b.distance).slice(0, nResults);
    return { ids: [hits.map((h) => h.id)], documents: [hits.map((h) => h.document)], metadatas: [hits.map((h) => h.metadata)], distances: [hits.map((h) => h.distance)] };
  },
});
const stat = (id, document, distance, extra = {}) => ({ id, document, distance, metadata: { filename: `${id}.csv`, evidence_type: "statistics", ...extra } });
const advice = (id, document, distance, crop = "rice") => ({ id, document, distance, metadata: { filename: `${id}.html`, evidence_type: "advisory", crop } });

describe("query analysis", () => {
  it("RE-1: separates advisory from statistics questions and finds crops and districts", () => {
    expect(analyzeQuery("how to control stem borer in paddy")).toMatchObject({ intent: "advisory", crops: ["rice"] });
    expect(analyzeQuery("maize production in Dindigul district")).toMatchObject({ intent: "statistics", crops: ["maize"], districts: ["dindigul"] });
    expect(analyzeQuery("தஞ்சாவூர் மாவட்ட நெல் உற்பத்தி")).toMatchObject({ intent: "statistics", crops: ["rice"], districts: ["thanjavur"] });
    expect(analyzeQuery("price of tractors").crops).toEqual([]); // "rice" must not match "price"
  });
});

describe("evidence-aware retrieval", () => {
  const vector = [1];

  it("RE-2: an advisory question never receives statistics, even if they are closer and name the crop", async () => {
    const coll = collection([stat("rice-yield", "File: rice\nRow 1: District: Salem; Rice: 9", 0.1), advice("borer", "Source: TNAU\nTo control stem borer in paddy apply the recommended measure.", 0.9)]);
    const { hits } = await retrieveEvidence(coll, { queryText: "how to control stem borer in paddy", vector, topK: 3 });
    expect(hits.map((h) => h.id)).toEqual(["borer"]);
  });

  it("RE-3: with no advisory chunks an advisory question gets nothing, so chat uses its no-context path", async () => {
    const coll = collection([stat("rice-yield", "Row 1: Rice: 9", 0.1)]);
    expect((await retrieveEvidence(coll, { queryText: "how to control stem borer in paddy", vector })).hits).toEqual([]);
  });

  it("RE-4: statistics questions reject header-only chunks and prefer the named district's row", async () => {
    const coll = collection([
      stat("header", "File: rice\nHeaders: District,Total", 0.2),
      stat("salem", "File: rice\nRow 1: District: Salem; Rice: 9", 0.6),
      stat("thanjavur", "File: rice\nRow 2: District: Thanjavur; Rice: 7", 0.8),
    ]);
    const { hits } = await retrieveEvidence(coll, { queryText: "rice production in Thanjavur district", vector });
    expect(hits.map((h) => h.id)).toEqual(["thanjavur", "salem"]);
  });

  it("RE-5: a district named only in the file preamble earns no district bonus", () => {
    const analysis = analyzeQuery("rice production in Thanjavur");
    const inRows = scoreHit(analysis, { document: "Row 1: District: Thanjavur", metadata: {}, distance: 1 });
    const inPreamble = scoreHit(analysis, { document: "File: thanjavur.csv\nRow 1: District: Salem", metadata: {}, distance: 1 });
    expect(inRows - inPreamble).toBeCloseTo(0.3, 5);
  });

  it("RE-6: a legacy collection without evidence_type still works for statistics and drops KML/XLS", async () => {
    const legacy = (id, document, distance, filename) => ({ id, document, distance, metadata: { filename } });
    const coll = collection([legacy("kml", "Row 1: coordinates", 0.1, "tamil-nadu.kml"), legacy("csv", "Row 1: District: Erode; Rice: 3", 0.5, "rice.csv")]);
    const { hits } = await retrieveEvidence(coll, { queryText: "rice production in Erode", vector });
    expect(hits.map((h) => h.id)).toEqual(["csv"]);
  });

  it("RE-7: order is deterministic when scores tie", async () => {
    const coll = collection([advice("b", "Source: x same text about paddy", 1), advice("a", "Source: x same text about paddy", 1)]);
    const { hits } = await retrieveEvidence(coll, { queryText: "how to grow paddy", vector });
    expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
  });
});

describe("row-level provenance and advisory chunking", () => {
  it("RE-8: statistics chunks record exactly which rows they hold and their evidence type", () => {
    const [chunk] = tableToChunks({ key: "r.csv", headers: ["District", "T"], rows: [["A", "1"], ["B", "2"], ["A", "3"]] });
    expect(chunk.metadata).toMatchObject({ row_numbers: "1,3,2", evidence_type: "statistics", row_count: 3 });
  });

  const long = "Apply the recommended practice at the correct stage of the crop for good results. ".repeat(3);

  it("RE-9: advisory chunks carry document provenance, and a heading alone never becomes a chunk", () => {
    const chunks = advisoryToChunks({ docId: "d.html", text: `# Heading only\nshort\n# Real section\n${long}`, title: "T", issuer: "TNAU", url: "https://x/d.html", crop: "rice", retrievedAt: "2026-11-09", fileSha256: "abc" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("Section: Real section");
    expect(chunks[0].metadata).toMatchObject({ evidence_type: "advisory", source: "https://x/d.html", issuer: "TNAU", crop: "rice", retrieved_at: "2026-11-09", fileSha256: "abc", section: "Real section" });
    expect(long.length).toBeGreaterThan(MIN_ADVISORY_BODY_CHARS);
  });

  it("RE-10: extraction keeps table rows together and drops scripts, styles and menus", () => {
    const text = htmlToText("<title>x</title><script>var a=1;</script><style>.a{}</style><table><tr><td>Urea</td><td>50 kg/ha</td></tr></table><p>Apply &amp; irrigate.</p>");
    expect(text).toBe("Urea | 50 kg/ha\nApply & irrigate.");
    expect(dropMenuRuns(["Botany", "Climate", "Season", "Varieties", "Apply 50 kg per hectare."])).toEqual(["Apply 50 kg per hectare."]);
  });

  it("RE-11: the crawler stays inside the seed scope and skips site chrome", () => {
    const seed = { scope: "https://agritech.tnau.ac.in/expert_system/sugar/" };
    expect(extractLinks('<a href="irrigation.html">x</a><a href="contactus.html">y</a>', "https://agritech.tnau.ac.in/expert_system/sugar/index.html").filter((u) => isCrawlableLink(u, seed))).toEqual(["https://agritech.tnau.ac.in/expert_system/sugar/irrigation.html"]);
    expect(isCrawlableLink("https://agritech.tnau.ac.in/other/a.html", seed)).toBe(false);
  });
});

describe("human relevance workflow", () => {
  const rows = [{ id: "A1", kind: "answerable", query: "q", rawHits: [{ document: "one", metadata: { source: "u" } }, { document: "two", metadata: {} }] }];
  const [one, two] = [poolId("A1", "one"), poolId("A1", "two")];
  const human = (pool_id, label, assessor_id = "a1") => ({ pool_id, label, assessor_id, assessor_type: "human" });

  it("RE-12: the pool is deduplicated across conditions and the packet fields do not reveal condition or rank", () => {
    const pool = buildPool([{ condition: "x", rows }, { condition: "y", rows }]);
    expect(pool).toHaveLength(2);
    expect(pool[0].appearsIn).toHaveLength(2);
    expect(pool.map((p) => p.pool_id)).toEqual([one, two].sort());
  });

  it("RE-13: non-human labels and bad grades are rejected; empty stays unjudged", () => {
    expect(validateLabels([{ ...human(one, "2"), assessor_type: "llm" }], [one]).ok).toBe(false);
    expect(validateLabels([human(one, "5")], [one]).ok).toBe(false);
    expect(validateLabels([human(one, ""), human(two, "U")], [one, two])).toMatchObject({ ok: true, unjudged: 1 });
    expect(() => finalQrels([], [], [{ pool_id: one, label: "2", assessor_type: "gpt" }])).toThrow(/human/);
  });

  it("RE-14: agreement, disagreement, adjudication and metrics follow the labels and never count unjudged as irrelevant", () => {
    const a = [human(one, "2"), human(two, "1")];
    const b = [human(one, "2", "a2"), human(two, "0", "a2")];
    expect(agreement(a, b)).toMatchObject({ compared: 2, exactAgreement: 0.5 });
    expect(disagreements(a, b)).toEqual([{ pool_id: two, a: "1", b: "0" }]);
    const unresolved = finalQrels(a, b);
    expect([...unresolved.keys()]).toEqual([one]);
    const m = humanMetrics(rows, unresolved, 2);
    expect(m).toMatchObject({ precisionJudged: 1, hitRate: 1, mrr: 1, unjudgedRetrieved: 1, recallPooled: 1 });
    expect(humanMetrics(rows, finalQrels(a, b, [human(two, "0", "adj")]), 2)).toMatchObject({ precisionJudged: 0.5, unjudgedRetrieved: 0 });
  });
});

describe("mechanical metrics", () => {
  it("RE-15: precision, recall and MRR use only the labels given", () => {
    const hit = (relevant) => ({ relevant });
    const rows = [{ id: "A1", kind: "answerable", hits: [hit(false), hit(true), hit(false), hit(false), hit(false)] }, { id: "A2", kind: "answerable", hits: [hit(false), hit(false), hit(false), hit(false), hit(false)] }, { id: "B1", kind: "advisory", hits: [hit(false)] }];
    const m = answerableMetrics(rows, { A1: 2, A2: 0 });
    expect(m).toMatchObject({ n: 2, hit1: { k: 0 }, hit3: { k: 1 }, mrr: 0.25, recall3: 0.5, queriesWithNoRelevant: ["A2"] });
    expect(m.precision3).toBeCloseTo(1 / 6, 5);
    expect(answerableMetrics(rows, null).recall3).toBeNull();
  });
});
