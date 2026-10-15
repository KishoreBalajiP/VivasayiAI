import { compareNames } from "../../utils/nameMatch.js";
import { confusionMatrix, rate } from "./lib/metrics.js";

// Name-matching evaluation for the land-document comparison step.
//
// LABELS ARE AUTHOR-ASSIGNED, not expert annotations. The set is hand-built from common Tamil given
// names with their usual Latin spellings. It exercises the matcher's rules (script, spelling, honorifics,
// initials, word order, extra or different tokens) and is not a sample of how names actually appear on
// real land records, which would need documents and annotators we do not have.
// Ground truth is: match = same person's name; partial = shares some tokens; mismatch = different name.

const PAIRS = [
  // Tamil <-> Latin, same name (usual and variant spellings)
  ["முருகன்", "Murugan"], ["முருகன்", "Murukan"], ["கந்தசாமி", "Kandasamy"], ["கந்தசாமி", "Kandaswamy"],
  ["சுப்பிரமணியன்", "Subramanian"], ["சுப்பிரமணியன்", "Subramaniam"], ["இராமசாமி", "Ramasamy"], ["இராமசாமி", "Ramaswamy"],
  ["வேலு", "Velu"], ["செல்வம்", "Selvam"], ["லட்சுமி", "Lakshmi"], ["பழனிசாமி", "Palanisamy"], ["பழனிசாமி", "Palaniswamy"],
  ["அண்ணாமலை", "Annamalai"], ["ராஜேஸ்வரி", "Rajeswari"], ["குமார்", "Kumar"], ["மணிகண்டன்", "Manikandan"],
  ["கருப்பசாமி", "Karuppasamy"], ["நாகராஜன்", "Nagarajan"], ["சரவணன்", "Saravanan"], ["ஆறுமுகம்", "Arumugam"],
  ["சிவகுமார்", "Sivakumar"], ["பாலசுப்பிரமணியம்", "Balasubramaniam"],
  // Latin <-> Latin, same name
  ["Murugan", "MURUGAN"], ["A. Murugan", "A Murugan"], ["Kandasamy Murugan", "Murugan Kandasamy"],
  ["Subramanian", "Subramaniam"], ["Ramasamy", "Ramaswamy"], ["Thiru. Murugan S/o Kandasamy", "Murugan"],
  ["Tmt. Lakshmi W/o Murugan", "Lakshmi"], ["Mr. Selvam", "Selvam"], ["S. Murugan", "Subramanian Murugan"],
  ["R. Kumar", "Ravi Kumar"], ["Velu", "Vel"], ["Palanisamy", "Palaniswamy"],
  // Tamil <-> Tamil, same name
  ["முருகன் கந்தசாமி", "கந்தசாமி முருகன்"], ["செல்வம்", "செல்வம்"],
].map(([a, b]) => ({ a, b, expected: "match" }));

const PARTIAL = [
  ["Murugan", "Murugan Kandasamy"], ["Murugan Kandasamy", "Murugan Selvam"], ["முருகன்", "Murugan Kandasamy"],
  ["Lakshmi Devi", "Lakshmi"], ["Ravi Kumar", "Suresh Kumar"], ["Selvam Pillai", "Selvam"],
  ["Arumugam Ramasamy", "Arumugam"], ["Manikandan Velu", "Manikandan"],
].map(([a, b]) => ({ a, b, expected: "partial" }));

const MISMATCH = [
  ["Murugan", "Selvam"], ["முருகன்", "Selvam"], ["செல்வம்", "Murugan"], ["Lakshmi Devi", "Ramasamy Pillai"],
  ["Kumar", "Velu"], ["சரவணன்", "Rajeswari"], ["Nagarajan", "Annamalai"], ["Palanisamy", "Manikandan"],
  ["Sivakumar", "Arumugam"], ["R. Kumar", "S. Velu"], ["அண்ணாமலை", "Karuppasamy"], ["Rajeswari", "Lakshmi"],
  ["Subramanian", "Saravanan"], ["Ravi", "Selvam"], ["Kandasamy", "Ramasamy"],
].map(([a, b]) => ({ a, b, expected: "mismatch" }));

export const runNameEvaluation = () => {
  const rows = [...PAIRS, ...PARTIAL, ...MISMATCH].map((pair) => ({ ...pair, actual: compareNames(pair.a, pair.b) ?? "unusable" }));
  const labels = ["match", "partial", "mismatch", "unusable"];
  const perClass = {};
  for (const label of ["match", "partial", "mismatch"]) {
    const subset = rows.filter((row) => row.expected === label);
    perClass[label] = rate(subset.filter((row) => row.actual === label).length, subset.length);
  }
  // What matters most for a land-record check: a TRUE match must not be called a mismatch (a wrongful
  // flag) and a TRUE mismatch must not be called a match (a missed flag).
  const wrongfulFlags = rows.filter((row) => row.expected === "match" && row.actual === "mismatch");
  const missedFlags = rows.filter((row) => row.expected === "mismatch" && row.actual === "match");
  return {
    name: "names",
    description: "Tamil/Latin name comparison used when a land document is compared with the claimant.",
    groundTruth: "AUTHOR-ASSIGNED labels on a hand-built set; not expert annotations and not real land-record data",
    n: rows.length,
    accuracy: rate(rows.filter((row) => row.expected === row.actual).length, rows.length),
    perClass,
    confusionMatrix: confusionMatrix(rows, labels),
    matchCalledMismatch: rate(wrongfulFlags.length, rows.filter((row) => row.expected === "match").length),
    mismatchCalledMatch: rate(missedFlags.length, rows.filter((row) => row.expected === "mismatch").length),
    failures: rows.filter((row) => row.expected !== row.actual).map(({ a, b, expected, actual }) => ({ a, b, expected, actual })),
    tuningHistory: [
      "Before tuning, on this same set: 55 of 60 correct. All 5 errors were true matches called mismatches, caused by glide letters (Tamil சாமி is 'samy' but Latin spellings write 'swamy'; Tamil ய appears as 'ian' in 'Subramanian').",
      "The matcher was then changed to drop the glides w and y from the skeleton. The score after the change is therefore OPTIMISTIC: the rule was chosen after seeing these failures. A held-out set that was not used for tuning is needed for an unbiased estimate.",
    ],
    limitations: [
      "Labels were assigned by the author, so agreement with them is not agreement with an independent judge.",
      "Common given names only; surnames, caste/title suffixes, village prefixes and OCR errors are not represented.",
      "Names on real documents are read by a vision model first, so extraction errors compound with matching errors; this isolates the matching step.",
    ],
  };
};

export default runNameEvaluation;
