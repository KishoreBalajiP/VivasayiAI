import { readFileSync } from "node:fs";

// Scoring for land-document field extraction. The EXTRACTION RESULTS ARE PENDING: they need a set of
// real (or realistic) document images with manually verified labels and a live Gemini key. This module
// is the scorer, tested on synthetic pairs, so results can be computed the moment labelled output
// exists. Field accuracy here is NOT ownership-verification accuracy: a perfectly read document can
// still be forged or belong to someone else.
//
//   node scripts/eval/docExtraction.score.js <predictions.json> <labels.json>
// Both files: { "<documentId>": { surveyNumber, district, holderNames: [...], parcelExtent, ... } }

export const SCORED_FIELDS = ["documentType", "recordNumber", "state", "district", "taluk", "village", "surveyNumber", "subdivisionNumber", "holderNames", "parcelExtent", "extentUnit", "documentDate"];

const norm = (value) => (value === null || value === undefined ? null : String(value).trim().toLowerCase().replace(/\s+/g, " "));
const normList = (list) => (Array.isArray(list) ? list.map(norm).filter(Boolean).sort() : []);

const present = (field, value) => (field === "holderNames" ? normList(value).length > 0 : norm(value) !== null);

const equal = (field, a, b) => {
  if (field === "holderNames") return JSON.stringify(normList(a)) === JSON.stringify(normList(b));
  if (field === "parcelExtent") return a !== null && b !== null && Math.abs(Number(a) - Number(b)) <= 0.01 * Math.max(Math.abs(Number(b)), 1e-9);
  return norm(a) === norm(b);
};

// Per-field precision (of the values the system produced, how many are right), recall (of the values
// that exist on the document, how many the system produced correctly) and F1, plus exact-match counts.
export const scoreExtraction = ({ predictions, labels }) => {
  const ids = Object.keys(labels);
  const perField = {};
  for (const field of SCORED_FIELDS) {
    let tp = 0; let fp = 0; let fn = 0; let labelled = 0;
    for (const id of ids) {
      const truth = labels[id] ? labels[id][field] : null;
      const guess = predictions[id] ? predictions[id][field] : null;
      const truthPresent = present(field, truth);
      const guessPresent = present(field, guess);
      if (truthPresent) labelled += 1;
      if (guessPresent && truthPresent && equal(field, guess, truth)) tp += 1;
      else {
        if (guessPresent) fp += 1;
        if (truthPresent) fn += 1;
      }
    }
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = tp + fn === 0 ? null : tp / (tp + fn);
    perField[field] = {
      labelled, tp, fp, fn,
      precision: precision === null ? null : Math.round(precision * 10000) / 10000,
      recall: recall === null ? null : Math.round(recall * 10000) / 10000,
      f1: precision === null || recall === null || precision + recall === 0 ? null : Math.round(((2 * precision * recall) / (precision + recall)) * 10000) / 10000,
    };
  }
  const f1s = Object.values(perField).map((f) => f.f1).filter((v) => v !== null);
  const documentsFullyCorrect = ids.filter((id) => SCORED_FIELDS.every((field) => !present(field, labels[id] && labels[id][field]) ? !present(field, predictions[id] && predictions[id][field]) : equal(field, predictions[id] && predictions[id][field], labels[id][field]))).length;
  return { documents: ids.length, macroF1: f1s.length ? Math.round((f1s.reduce((s, v) => s + v, 0) / f1s.length) * 10000) / 10000 : null, documentsFullyCorrect, perField };
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [, , predictionsPath, labelsPath] = process.argv;
  if (!predictionsPath || !labelsPath) {
    console.error("usage: node scripts/eval/docExtraction.score.js <predictions.json> <labels.json>");
    process.exit(2);
  }
  console.log(JSON.stringify(scoreExtraction({ predictions: JSON.parse(readFileSync(predictionsPath, "utf8")), labels: JSON.parse(readFileSync(labelsPath, "utf8")) }), null, 2));
}

export default scoreExtraction;
