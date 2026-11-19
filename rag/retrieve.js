import { EVIDENCE_TYPES } from "./ingestHelpers.js";

// Metadata-aware, evidence-aware retrieval (RAG_RETRIEVAL_MODE=evidence). Deterministic: no model call
// beyond the query embedding the caller provides. Uses the Chroma collection API (`query` with `where`)
// so the same code runs on Chroma Cloud and on rag/localIndex.js.
//
//   1. analyzeQuery classifies the question (advisory / statistics / unknown) and finds crops/districts.
//   2. Advisory questions search ONLY advisory chunks. If there are none, nothing is returned: a yield
//      table is never offered as agronomic advice merely because it mentions the crop.
//   3. Statistics questions search statistics chunks and require a data row. A legacy collection has no
//      evidence_type, so that search falls back to all chunks minus geography/HTML-export files.
//   4. Candidates are reranked by cosine similarity plus fixed bonuses for an exact district or crop
//      match and for query-term coverage.
// The weights were set once, before the first evaluation, and are recorded in every result. Nothing
// here reads the evaluation's expected files or labels.

export const RETRIEVAL_CONFIG = Object.freeze({
  version: "evidence-v1",
  candidateK: 100,
  weights: Object.freeze({ district: 0.3, statsCrop: 0.15, statsLexical: 0.1, advisoryCrop: 0.2, advisoryCropMismatch: -0.2, advisoryLexical: 0.15 }),
});

const CROPS = Object.freeze({
  rice: ["rice", "paddy", "samba", "kuruvai", "நெல்"],
  maize: ["maize", "corn", "மக்காச்சோளம்"],
  ragi: ["ragi", "finger millet", "கேழ்வரகு"],
  sorghum: ["sorghum", "jowar", "cholam", "சோளம்"],
  sugarcane: ["sugarcane", "கரும்பு"],
  coconut: ["coconut", "தென்னை"],
  banana: ["banana", "வாழை"],
  groundnut: ["groundnut", "peanut", "நிலக்கடலை"],
  tomato: ["tomato", "தக்காளி"],
  cotton: ["cotton", "பருத்தி"],
  tea: ["tea"],
  coffee: ["coffee"],
  neem: ["neem", "வேம்பு"],
  "black gram": ["black gram", "blackgram", "urad", "உளுந்து"],
  "green gram": ["green gram", "greengram", "பாசிப்பயறு"],
  "red gram": ["red gram", "redgram", "pigeon pea", "துவரை"],
  turmeric: ["turmeric", "மஞ்சள் பயிர்"],
  onion: ["onion", "வெங்காயம்"],
  chilli: ["chilli", "chili", "மிளகாய்"],
});

// English names as in config/districts.js, with common alternative spellings and the Tamil name.
const DISTRICTS = Object.freeze({
  chennai: ["chennai", "சென்னை"],
  kancheepuram: ["kancheepuram", "kanchipuram", "காஞ்சிபுரம்"],
  tiruvallur: ["tiruvallur", "thiruvallur", "திருவள்ளூர்"],
  coimbatore: ["coimbatore", "கோயம்புத்தூர்", "கோவை"],
  erode: ["erode", "ஈரோடு"],
  madurai: ["madurai", "மதுரை"],
  trichy: ["trichy", "tiruchirappalli", "tiruchchirappalli", "திருச்சி"],
  salem: ["salem", "சேலம்"],
  tirunelveli: ["tirunelveli", "திருநெல்வேலி"],
  thanjavur: ["thanjavur", "tanjore", "தஞ்சாவூர்"],
  vellore: ["vellore", "வேலூர்"],
  dharmapuri: ["dharmapuri", "தர்மபுரி"],
  cuddalore: ["cuddalore", "கடலூர்"],
  nagapattinam: ["nagapattinam", "நாகப்பட்டினம்"],
  kanyakumari: ["kanyakumari", "கன்னியாகுமரி"],
  karur: ["karur", "கரூர்"],
  pudukkottai: ["pudukkottai", "pudukottai", "புதுக்கோட்டை"],
  ramanathapuram: ["ramanathapuram", "ramnad", "இராமநாதபுரம்", "ராமநாதபுரம்"],
  sivaganga: ["sivaganga", "sivagangai", "சிவகங்கை"],
  theni: ["theni", "தேனி"],
  tiruppur: ["tiruppur", "திருப்பூர்"],
  tiruvannamalai: ["tiruvannamalai", "திருவண்ணாமலை"],
  villupuram: ["villupuram", "viluppuram", "விழுப்புரம்"],
  virudhunagar: ["virudhunagar", "விருதுநகர்"],
  krishnagiri: ["krishnagiri", "கிருஷ்ணகிரி"],
  ariyalur: ["ariyalur", "அரியலூர்"],
  nilgiris: ["nilgiris", "nilgiri", "நீலகிரி"],
  perambalur: ["perambalur", "பெரம்பலூர்"],
  dindigul: ["dindigul", "திண்டுக்கல்"],
  namakkal: ["namakkal", "நாமக்கல்"],
  thoothukudi: ["thoothukudi", "tuticorin", "தூத்துக்குடி"],
  kallakurichi: ["kallakurichi", "கள்ளக்குறிச்சி"],
  ranipet: ["ranipet", "ராணிப்பேட்டை"],
  tenkasi: ["tenkasi", "தென்காசி"],
  tirupathur: ["tirupathur", "திருப்பத்தூர்"],
  chengalpattu: ["chengalpattu", "செங்கல்பட்டு"],
  mayiladuthurai: ["mayiladuthurai", "மயிலாடுதுறை"],
  tiruvarur: ["tiruvarur", "thiruvarur", "திருவாரூர்"],
});

const ADVISORY = /\b(how (to|do i|can i|much)|when (should|to)|what should|which crop|what crop|what to do|should i|control|treat|prevent|manage|dose|dosage|spray|symptoms?|remedy|recommend\w*)\b|என்ன செய்வது|எப்படி|எவ்வளவு/i;
const STATISTICS = /\b(production|yield|area under|area irrigated|irrigated by|acreage|statistics|incidence|observations?|values?|data)\b|உற்பத்தி|பரப்பளவு/i;
const STOPWORDS = new Set("the and for with from that this what when which how should does are was were can into per about your have has not district data".split(" "));

// ASCII terms match on word boundaries ("rice" must not match "price"); Tamil terms as substrings.
const mentions = (text, term) => (/^[\x20-\x7e]+$/.test(term) ? new RegExp(`\\b${term.replace(/ /g, "[\\s_-]*")}\\b`, "i").test(text.replace(/_/g, " ")) : text.includes(term));
const namesIn = (table, text) => Object.keys(table).filter((name) => table[name].some((term) => mentions(text, term)));

export const analyzeQuery = (text) => {
  const query = String(text || "");
  const intent = ADVISORY.test(query) ? "advisory" : STATISTICS.test(query) ? "statistics" : "unknown";
  const tokens = [...new Set(query.toLowerCase().match(/[a-z]{3,}/g) || [])].filter((token) => !STOPWORDS.has(token));
  return { intent, crops: namesIn(CROPS, query), districts: namesIn(DISTRICTS, query), tokens };
};

const fileName = (metadata) => String((metadata && (metadata.filename || metadata.source)) || "").split("/").pop();

const hasDataRow = (document) => /(^|\n)Row\s+\d+:/.test(String(document || ""));

// Row text only, so a file name or column list cannot satisfy a district match.
const rowText = (document) => String(document || "").split("\n").filter((line) => !/^(File|Table|Columns|Headers|Data):/.test(line.trim())).join("\n");

const isGeographyOrExport = (metadata) => /\.(kml|xls)$/i.test(fileName(metadata));

export const scoreHit = (analysis, { document, metadata, distance }, weights = RETRIEVAL_CONFIG.weights) => {
  const similarity = 1 - Number(distance) / 2; // unit vectors: squared L2 = 2 - 2 * cosine
  const text = `${document} ${fileName(metadata)} ${metadata?.crop || ""}`;
  const lexical = analysis.tokens.length ? analysis.tokens.filter((token) => text.toLowerCase().includes(token)).length / analysis.tokens.length : 0;
  const cropMatch = analysis.crops.some((crop) => CROPS[crop].some((term) => mentions(text, term)));
  if (analysis.intent === "advisory") {
    const mismatch = analysis.crops.length > 0 && Boolean(metadata?.crop) && !cropMatch;
    return similarity + (cropMatch ? weights.advisoryCrop : 0) + (mismatch ? weights.advisoryCropMismatch : 0) + weights.advisoryLexical * lexical;
  }
  const rows = rowText(document);
  const districtMatch = analysis.districts.some((district) => DISTRICTS[district].some((term) => mentions(rows, term)));
  return similarity + (districtMatch ? weights.district : 0) + (cropMatch ? weights.statsCrop : 0) + weights.statsLexical * lexical;
};

const toHits = (result) => {
  const ids = result.ids?.[0] || [];
  return ids.map((id, i) => ({ id, document: result.documents?.[0]?.[i] ?? "", metadata: result.metadatas?.[0]?.[i] || {}, distance: result.distances?.[0]?.[i] }));
};

// Returns at most topK hits [{id, document, metadata, distance, score}], best first; ties by distance,
// then by id so the order is reproducible.
export const retrieveEvidence = async (collection, { queryText, vector, topK = 3, config = RETRIEVAL_CONFIG }) => {
  const analysis = analyzeQuery(queryText);
  const search = (where) => collection.query({ queryEmbeddings: [vector], nResults: config.candidateK, include: ["documents", "metadatas", "distances"], ...(where ? { where } : {}) }).then(toHits);

  let candidates;
  if (analysis.intent === "advisory") {
    candidates = await search({ evidence_type: EVIDENCE_TYPES.ADVISORY });
  } else if (analysis.intent === "statistics") {
    candidates = await search({ evidence_type: EVIDENCE_TYPES.STATISTICS });
    if (candidates.length === 0) candidates = (await search()).filter((hit) => !isGeographyOrExport(hit.metadata));
    candidates = candidates.filter((hit) => hasDataRow(hit.document));
  } else {
    candidates = (await search()).filter((hit) => !isGeographyOrExport(hit.metadata) && (hit.metadata.evidence_type === EVIDENCE_TYPES.ADVISORY || hasDataRow(hit.document)));
  }

  return {
    analysis,
    hits: candidates
      .map((hit) => ({ ...hit, score: scoreHit(analysis, hit, config.weights) }))
      .sort((a, b) => b.score - a.score || a.distance - b.distance || String(a.id).localeCompare(String(b.id)))
      .slice(0, topK),
  };
};

export default { RETRIEVAL_CONFIG, analyzeQuery, scoreHit, retrieveEvidence };
