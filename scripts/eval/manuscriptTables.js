import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bibStats } from "./bibStats.js";

// Generates the LaTeX tables AND the prose-number macros of the manuscript FROM the committed evaluation
// results, the source ledger and the code defaults, so that no number in the paper is typed by hand.
// Run after `npm run eval`:  node scripts/eval/manuscriptTables.js
//
// Writes, all deterministic (no timestamps, so a re-run on unchanged inputs gives identical files):
//   docs/research/manuscript/generated_tables.tex   the tables (results/*.json and live/*.json)
//                                                   shared by main.tex (IEEEtran) and main-access.tex
//   docs/research/manuscript/generated_numbers.tex  one \newcommand per prose number (letters-only names)
//   docs/research/manuscript/generated_numbers.json {Macro: {value, source, pointer, formatter, raw}}
// scripts/eval/checkManuscriptNumbers.js (npm run manuscript:numbers) recomputes the numbers and fails
// when main.tex contains a number literal that is neither a macro nor on the allowlist.
// main-access.tex (the IEEE Access port) uses the same generated files; tests/researchAlignment.unit.test.js
// checks that every macro it uses is defined.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS = "docs/research/evaluation/results";
const LIVE = "docs/research/evaluation/live";
const MANUSCRIPT = "docs/research/manuscript";
export const TABLES_PATH = join(root, MANUSCRIPT, "generated_tables.tex");
export const NUMBERS_TEX_PATH = join(root, MANUSCRIPT, "generated_numbers.tex");
export const NUMBERS_JSON_PATH = join(root, MANUSCRIPT, "generated_numbers.json");
// The commit whose code ran the 16 October 2026 study (see docs/research/evaluation/live/
// satellite_case_studies_2026-10-16.provenance.md). Used only for values "in force during the study".
export const STUDY_COMMIT = "6dbe6b8";
// Those study-time values, extracted once from STUDY_COMMIT and pinned in FROZEN_HASHES.json, so the
// generator and its check run without the git history (a shallow CI clone, a copy without .git).
export const STUDY_DEFAULTS_PATH = `${LIVE}/study_code_defaults_2026-10-16.json`;
// The v1.1-safe-ai row of the fusion benchmark. results/fusion.json is the published baseline and is not
// rewritten, so the row has its own dated, write-once file
// (VIVASAYI_SKIP_DOTENV=1 node scripts/eval/fusion.eval.js --safe-ai-row --date=2026-10-16).
export const FUSION_SAFE_AI_PATH = `${RESULTS}/fusion_v1.1_2026-10-16.json`;
// The decision record that introduced v1.1-safe-ai; its status line carries the date of the change.
export const DECISIONS_PATH = "docs/decisions/18_DECISIONS.md";

const readText = (rel) => readFileSync(join(root, rel), "utf8");
const loadJson = (rel) => JSON.parse(readText(rel));

const pct = (r, digits = 1) => (r && r.value !== null ? `${(r.value * 100).toFixed(digits)}\\%` : "n/a");
const frac = (r) => `${r.k}/${r.n}`;
const tex = (s) => String(s).replace(/&/g, "\\&").replace(/_/g, "\\_").replace(/%/g, "\\%");

// Outcome of a live satellite case as the manuscript groups it: an analysed case keeps its analysis
// outcome; a case that never reached analysis has no usable post-event data.
const outcomeOf = (c) => (c.outcome === "ANALYSIS_COMPLETE" ? c.analysis.analysisOutcome : "NO_POST_DATA");

// The fusion rows of the manuscript: the published rows of results/fusion.json, then the v1.1-safe-ai row
// from its dated file. If a later `npm run eval` writes the v1.1 row into fusion.json as well, the two
// must agree and the row is listed once.
export const fusionRows = () => {
  const fusion = loadJson(`${RESULTS}/fusion.json`);
  const safeAi = loadJson(FUSION_SAFE_AI_PATH);
  must(safeAi.baseline && safeAi.baseline.publishedRowsReproduced === true, `${FUSION_SAFE_AI_PATH}: the published fusion rows did not reproduce when the v1.1 row was computed (EV-16)`);
  must(JSON.stringify(safeAi.scenarioFactors) === JSON.stringify(fusion.scenarioFactors), `${FUSION_SAFE_AI_PATH}: scenario factorial differs from fusion.json`);
  const rows = { ...fusion.policies };
  if (safeAi.label in rows) must(JSON.stringify(rows[safeAi.label]) === JSON.stringify(safeAi.row), `fusion.json and ${FUSION_SAFE_AI_PATH} disagree on the ${safeAi.label} row`);
  else rows[safeAi.label] = safeAi.row;
  return { fusion, safeAi, rows };
};

// --- Tables --------------------------------------------------------------------------------------

export const renderTables = () => {
  const load = (name) => loadJson(`${RESULTS}/${name}.json`);
  const geometry = load("geometry");
  const { fusion, safeAi, rows: fusionPolicyRows } = fusionRows();
  const chat = load("chatContext");
  const names = load("names");
  const sat = load("satelliteSimulation");

  const out = [];
  out.push(`% GENERATED by scripts/eval/manuscriptTables.js from docs/research/evaluation/results/*.json (geometry, chat, fusion, the dated fusion row ${basename(FUSION_SAFE_AI_PATH)}, simulated satellite) and docs/research/evaluation/live/*.json (live satellite, retrieval). Shared by main.tex and main-access.tex. Do not edit by hand.`);

  // Table: geometry
  out.push(`
\\begin{table}[t]
\\caption{Geometry checks against analytic ground truth (synthetic rectangles placed across Tamil Nadu).}
\\label{tab:geometry}
\\centering
\\begin{tabular}{lrrr}
\\hline
Check & $n$ & Precision & Recall \\\\
\\hline
Outside-parcel detection & ${geometry.containment.scores.n} & ${geometry.containment.scores.precision} & ${geometry.containment.scores.recall} \\\\
Cross-farmer overlap flag & ${geometry.overlap.flagScores.n} & ${geometry.overlap.flagScores.precision} & ${geometry.overlap.flagScores.recall} \\\\
Invalid-geometry detection & ${geometry.invalidGeometry.detection.n} & ${geometry.invalidGeometry.detection.precision} & ${geometry.invalidGeometry.detection.recall} \\\\
\\hline
\\end{tabular}
\\par\\smallskip\\footnotesize Median relative area difference from an ellipsoidal reference: ${(geometry.area.relativeError.p50 * 100).toFixed(2)}\\% (systematic).
\\end{table}`);

  // Table: chat
  const f = chat.followUp;
  out.push(`
\\begin{table}[t]
\\caption{Follow-up question decisions, scored against a written specification (${f.cases} synthetic cases: ${f.unnecessaryCases} where no question is needed, ${f.necessaryCases} where one is).}
\\label{tab:chat}
\\centering
\\begin{tabular}{lrr}
\\hline
 & Previous rule & Context logic \\\\
\\hline
Unnecessary questions asked & ${pct(f.previousRule.unnecessaryFollowUpRate)} (${frac(f.previousRule.unnecessaryFollowUpRate)}) & ${pct(f.newLogic.unnecessaryFollowUpRate)} (${frac(f.newLogic.unnecessaryFollowUpRate)}) \\\\
Needed questions missed & ${pct(f.previousRule.missedNecessaryFollowUpRate)} (${frac(f.previousRule.missedNecessaryFollowUpRate)}) & ${pct(f.newLogic.missedNecessaryFollowUpRate)} (${frac(f.newLogic.missedNecessaryFollowUpRate)}) \\\\
Crop assumed when ambiguous & ${pct(f.previousRule.silentAssumptionWhenAmbiguous)} (${frac(f.previousRule.silentAssumptionWhenAmbiguous)}) & ${pct(f.newLogic.silentAssumptionWhenAmbiguous)} (${frac(f.newLogic.silentAssumptionWhenAmbiguous)}) \\\\
\\hline
\\end{tabular}
\\par\\smallskip\\footnotesize Intent classification accuracy ${pct(chat.intent.accuracy)} (${frac(chat.intent.accuracy)}). Context assembly latency p50/p95 ${chat.latencyMs.p50}/${chat.latencyMs.p95} ms with weather stubbed.
\\end{table}`);

  // Table: fusion
  const rows = Object.entries(fusionPolicyRows).map(([label, v]) => `${tex(label)} & ${frac(v.invalidApprovalRate)} & ${frac(v.adverseOnAiAlone)} & ${v.heldForReview} \\\\`);
  out.push(`
\\begin{table}[t]
\\caption{Evidence fusion over a ${fusion.scenarioFactors.total}-scenario factorial: invalid approvals, claims rejected on the AI reading alone, and claims held for review.}
\\label{tab:fusion}
\\centering
\\begin{tabular}{lrrr}
\\hline
Policy & Invalid & Rejected on & Held \\\\
 & approvals & AI alone & \\\\
\\hline
${rows.join("\n")}
\\hline
\\end{tabular}
\\par\\smallskip\\footnotesize The ${tex(safeAi.policy.id)} row was computed on ${safeAi.environment.date} on the same factorial (${tex(basename(FUSION_SAFE_AI_PATH))}); the other rows are the published results, which still reproduce exactly.
\\end{table}`);

  // Table: satellite simulation
  const headline = sat.headline;
  out.push(`
\\begin{table}[t]
\\caption{Simulated behaviour of the provisional NDVI-change rule (no real imagery; ${sat.model.trialsPerCell} trials per setting).}
\\label{tab:satellite}
\\centering
\\begin{tabular}{lr}
\\hline
Setting & Outcome rate \\\\
\\hline
No change, clear sky: flagged as supporting loss & ${pct(headline.falseSupportAtNoChangeClearSky)} \\\\
No change, cloudy: flagged as supporting loss & ${pct(headline.falseSupportAtNoChangeCloudy)} \\\\
NDVI drop 0.15, clear sky: detected & ${pct(headline.detectionAtDrop015ClearSky)} \\\\
NDVI drop 0.30, clear sky: detected & ${pct(headline.detectionAtDrop030ClearSky)} \\\\
Drop 0.30, 70\\% of pixels masked: inconclusive & ${pct(headline.inconclusiveWhenMostlyMasked)} \\\\
\\hline
\\end{tabular}
\\end{table}`);

  // Table: live Sentinel-2 case studies (production adapter, Copernicus Statistical API). Each row
  // is one 100 m square near a documented event, or a harvest control; outcome columns are counts.
  const live = loadJson(`${LIVE}/satellite_case_studies_2026-10-16.json`);
  const liveRows = live.events.map((event) => {
    const cases = live.cases.filter((c) => c.event === event.id);
    const count = (name) => cases.filter((c) => outcomeOf(c) === name).length;
    const deltas = cases.filter((c) => c.analysis?.deltaNdvi != null).map((c) => c.analysis.deltaNdvi.toFixed(2));
    return `${tex(event.id)} (${event.eventDate}) & ${cases.length} & ${count("SUPPORTS_LOSS")} & ${count("NO_CHANGE")} & ${count("INCONCLUSIVE") + count("NO_POST_DATA")} & ${deltas.join(", ")} \\\\`;
  });
  out.push(`
\\begin{table*}[t]
\\caption{Live Sentinel-2 L2A runs of the production adapter on 100\\,m squares near documented events and a harvest control (run ${live.runDate}). Land cover and crop at each square were not verified; the event rows are case studies, not labelled damage.}
\\label{tab:satellitelive}
\\centering
\\begin{tabular}{lrrrrl}
\\hline
Event (date) & Squares & Supports loss & No change & Inconclusive & $\\Delta$NDVI \\\\
\\hline
${liveRows.join("\n")}
\\hline
\\end{tabular}
\\end{table*}`);

  // Table: live retrieval over the production knowledge collection (read-only queries).
  const rag = loadJson(`${LIVE}/rag_retrieval_2026-10-16.json`);
  const ragK = rag.summaryAtProductionTopK;
  out.push(`
\\begin{table}[t]
\\caption{Live retrieval on the production collection (${rag.config.collection}, ${rag.config.embeddingModel}, top-${rag.config.productionTopK}). Relevance by a mechanical author-written rule, not human judgement.}
\\label{tab:rag}
\\centering
\\begin{tabular}{lr}
\\hline
Measure & Rate (k/n) \\\\
\\hline
Answerable: any relevant chunk & ${pct(ragK.answerable.hitRateAnyRelevant)} (${frac(ragK.answerable.hitRateAnyRelevant)}) \\\\
Answerable: top-1 relevant & ${pct(ragK.answerable.top1Relevant)} (${frac(ragK.answerable.top1Relevant)}) \\\\
Answerable: expected file retrieved & ${pct(ragK.answerable.anyExpectedFile)} (${frac(ragK.answerable.anyExpectedFile)}) \\\\
Expected-file hits that are header-only & ${pct(ragK.answerableExpectedFileHitsThatAreHeaderOnly)} (${frac(ragK.answerableExpectedFileHitsThatAreHeaderOnly)}) \\\\
Advisory: answer-bearing chunks & ${pct(ragK.advisory.answerBearingChunks)} (${frac(ragK.advisory.answerBearingChunks)}) \\\\
\\hline
\\end{tabular}
\\end{table}`);

  out.push(`\n% Name matching: ${names.n} author-labelled pairs; accuracy ${pct(names.accuracy)} after tuning on the same set (${names.failures.length} errors).\n`);
  return `${out.join("\n")}\n`;
};

// --- Prose numbers -------------------------------------------------------------------------------

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const FORMATTERS = {
  integer: (n) => String(n),
  thousands: (n) => n.toLocaleString("en-US"),
  fixed1: (n) => n.toFixed(1),
  fixed2: (n) => n.toFixed(2),
  word: (n) => {
    if (!Number.isInteger(n) || n < 0 || n >= WORDS.length) throw new Error(`no number word for ${n}`);
    return WORDS[n];
  },
  capitalWord: (n) => {
    const word = FORMATTERS.word(n);
    return word[0].toUpperCase() + word.slice(1);
  },
  longDate: (isoDate) => {
    const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new Error(`not an ISO date: ${isoDate}`);
    return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
  },
};

const must = (condition, message) => {
  if (!condition) throw new Error(`manuscript number check: ${message}`);
};

const median = (values) => {
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
};

const gitShow = (spec) => {
  try {
    return execSync(`git show ${spec}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }
};

// The numeric default of `Number(process.env.<KEY>) || <default>` in config/env.js source text.
const envDefaultFromSource = (text, key) => {
  const match = text.match(new RegExp(`process\\.env\\.${key}\\)\\s*\\|\\|\\s*(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
};

// The value of `pickFloat(env, ["<KEY>", ...], <default>)` in services/satellite/config.js source text.
const satelliteDefaultFromSource = (text, key) => {
  const match = text.match(new RegExp(`\\["${key}"[^\\]]*\\],\\s*(\\d+(?:\\.\\d+)?)\\)`));
  return match ? Number(match[1]) : null;
};

const SOURCE_PARSERS = { envDefault: envDefaultFromSource, pickFloat: satelliteDefaultFromSource };

// The study-time defaults from STUDY_DEFAULTS_PATH, as {KEY: number}.
export const loadStudyDefaults = (record = loadJson(STUDY_DEFAULTS_PATH)) => {
  must(String(record.studyCommit || "").startsWith(STUDY_COMMIT), `${STUDY_DEFAULTS_PATH} is not the record of commit ${STUDY_COMMIT}`);
  const values = {};
  for (const [key, entry] of Object.entries(record.values || {})) {
    must(typeof entry.value === "number" && Number.isFinite(entry.value), `${STUDY_DEFAULTS_PATH}: ${key} has no numeric value`);
    values[key] = entry.value;
  }
  return values;
};

// Optional cross-check of the record against the code at its commit. It runs only when the commit is
// reachable (a full clone); otherwise it is skipped ({checked: false}), which is not an error. `show`
// returns the text of `<commit>:<file>` or null.
export const crossCheckStudyDefaults = ({ record = loadJson(STUDY_DEFAULTS_PATH), show = gitShow } = {}) => {
  const texts = {};
  const mismatches = [];
  for (const [key, entry] of Object.entries(record.values || {})) {
    if (!(entry.file in texts)) texts[entry.file] = show(`${record.studyCommit}:${entry.file}`);
    if (texts[entry.file] === null) return { checked: false, mismatches: [] };
    const parse = SOURCE_PARSERS[entry.parser];
    const atCommit = parse ? parse(texts[entry.file], key) : null;
    if (atCommit !== entry.value) mismatches.push(`${key}: ${entry.value} in ${STUDY_DEFAULTS_PATH}, ${atCommit} in ${entry.file} at ${String(record.studyCommit).slice(0, 7)}`);
  }
  return { checked: true, mismatches };
};

// Code defaults, read so that the process environment cannot change them: config/env.js (through the
// policy module) is imported with the developer's .env skipped, and environment-dependent getters are
// read with their variable unset. Values that the Disclosures section reports as study-time behaviour
// come from the pinned study-defaults record, and today's code must still agree where the manuscript
// uses one macro for both, so a later code change cannot silently rewrite what the study did.
const loadCodeDefaults = async ({ show = gitShow } = {}) => {
  const savedSkip = process.env.VIVASAYI_SKIP_DOTENV;
  process.env.VIVASAYI_SKIP_DOTENV = "1";
  const policyModule = await import("../../config/verificationPolicy.js");
  const envModule = await import("../../config/env.js");
  const { resolveSatelliteConfig } = await import("../../services/satellite/config.js");
  const { getDefaultTimeoutMs } = await import("../../utils/aiTimeout.js");
  const { DOC_SPECS } = await import("../live/lib/syntheticLandDocs.js");
  if (savedSkip === undefined) delete process.env.VIVASAYI_SKIP_DOTENV;
  else process.env.VIVASAYI_SKIP_DOTENV = savedSkip;

  const tunings = policyModule.POLICY_IDS.map((id) => ({ id, satellite: policyModule.resolvePolicy(id).satellite }));
  must(tunings.every((t) => JSON.stringify(t.satellite) === JSON.stringify(tunings[0].satellite)), "satellite tuning differs between policies; the manuscript must say which policy it describes");

  const savedTimeout = process.env.GEMINI_TIMEOUT_MS;
  delete process.env.GEMINI_TIMEOUT_MS;
  const aiTimeoutMs = getDefaultTimeoutMs();
  if (savedTimeout !== undefined) process.env.GEMINI_TIMEOUT_MS = savedTimeout;

  // The manuscript quotes the claim-write limit in force DURING the study, so it comes from the study
  // record; a later change of the default (owner decision D5) must not silently rewrite it.
  const study = loadStudyDefaults();
  const cross = crossCheckStudyDefaults({ show });
  must(cross.mismatches.length === 0, `${STUDY_DEFAULTS_PATH} disagrees with the code at ${STUDY_COMMIT}: ${cross.mismatches.join("; ")}`);
  const satelliteConfig = resolveSatelliteConfig({});
  must(study.GEMINI_TIMEOUT_MS === aiTimeoutMs, `the AI timeout default changed since ${STUDY_COMMIT}; the disclosure quotes the study-time value, so give it its own macro`);
  must(study.SATELLITE_CLOUD_MAX === satelliteConfig.cloudMaxFraction, `the scene cloud limit changed since ${STUDY_COMMIT}; the disclosure quotes the study-time value, so give it its own macro`);
  must(study.SATELLITE_PROCESSING_SCENE_CLOUD_MAX === satelliteConfig.processingSceneCloudMax, `the processing scene cloud limit changed since ${STUDY_COMMIT}; the disclosure quotes the study-time value, so give it its own macro`);

  // Today's rate-limit defaults (owner decision D5), reported beside the study-time claim-write limit.
  const limits = envModule.RATE_LIMIT_DEFAULTS;
  must(limits && Number.isInteger(limits.claimWrites) && Number.isInteger(limits.evidence), "config/env.js no longer exports RATE_LIMIT_DEFAULTS {claimWrites, evidence}");
  must(limits.claimWrites !== study.CLAIM_RATE_LIMIT_MAX, "the prose says the claim-write default was raised after the study");

  return {
    policyIds: policyModule.POLICY_IDS,
    rateLimits: limits,
    components: policyModule.COMPONENTS,
    outcomes: policyModule.COMPONENT_OUTCOMES,
    satellite: tunings[0].satellite,
    satelliteConfig,
    aiTimeoutMs,
    claimWritesAtStudy: study.CLAIM_RATE_LIMIT_MAX,
    docSpecs: DOC_SPECS,
  };
};

// Every prose number of main.tex, in a stable order. Each entry names its source file or module, a
// pointer inside it, and how the raw value was formatted. Statements in the prose that a number
// supports (e.g. "NDVI rose afterwards") are asserted here, so a changed input cannot silently leave
// the sentence wrong. `show` (tests only) replaces `git show` for the optional study-commit cross-check.
export const computeNumbers = async ({ show = gitShow } = {}) => {
  const code = await loadCodeDefaults({ show });
  const entries = [];
  const add = (macro, raw, formatter, source, pointer) => {
    must(/^[A-Za-z]+$/.test(macro), `macro name ${macro} must be letters only`);
    must(!entries.some((e) => e.macro === macro), `duplicate macro ${macro}`);
    must(raw !== null && raw !== undefined && (typeof raw !== "number" || Number.isFinite(raw)), `${macro}: no value at ${source} ${pointer}`);
    entries.push({ macro, value: FORMATTERS[formatter](raw), raw, source, pointer, formatter });
  };

  // Synthetic benchmarks (results/*.json).
  const fusion = loadJson(`${RESULTS}/fusion.json`);
  const legacy = fusion.policies["photo-only (v1-legacy)"];
  const gate = fusion.policies["full fusion (v2-components)"];
  must(legacy && gate, "fusion.json policy labels changed");
  must(legacy.invalidApprovalRate.n === gate.invalidApprovalRate.n, "fusion invalid-approval denominators differ");
  must(gate.invalidApprovalRate.k === 0, "the prose says the gate approved none");
  add("FusionLegacyInvalidApprovals", legacy.invalidApprovalRate.k, "integer", `${RESULTS}/fusion.json`, '/policies/photo-only (v1-legacy)/invalidApprovalRate/k');
  add("FusionInvalidApprovalDenominator", legacy.invalidApprovalRate.n, "integer", `${RESULTS}/fusion.json`, '/policies/photo-only (v1-legacy)/invalidApprovalRate/n');
  const comparisons = Object.values(fusion.supportingEvidenceChangedOutcome);
  must(comparisons.every((r) => r.k === 0 && r.n === comparisons[0].n), "the prose says satellite and weather never changed a decision, with the same n per policy");
  add("FusionComparisonsPerPolicy", comparisons[0].n, "thousands", `${RESULTS}/fusion.json`, "/supportingEvidenceChangedOutcome/*/n (equal for every policy, every k = 0)");

  // The v1.1-safe-ai row (its own dated file; see fusionRows). The statements the prose makes about it are
  // asserted, so a recomputed row that disagrees stops the generator instead of leaving the text wrong.
  const { safeAi: safeAiFile } = fusionRows();
  const safe = safeAiFile.row;
  const safePath = FUSION_SAFE_AI_PATH;
  must(safeAiFile.policy.id === "v1.1-safe-ai", `${safePath} is not the v1.1-safe-ai row`);
  must(safe.invalidApprovalRate.n === legacy.invalidApprovalRate.n && safe.adverseOnAiAlone.n === legacy.adverseOnAiAlone.n, `${safePath}: denominators differ from fusion.json`);
  must(safe.invalidApprovalRate.k === legacy.invalidApprovalRate.k, "the prose says v1.1 does not reduce invalid approvals relative to v1-legacy");
  must(safe.adverseOnAiAlone.k === 0 && legacy.adverseOnAiAlone.k === legacy.adverseOnAiAlone.n, "the prose says v1-legacy rejected every AI-alone scenario and v1.1 none");
  const safeFlips = safeAiFile.supportingEvidenceChangedOutcome;
  must(safeFlips.k === 0 && safeFlips.n === comparisons[0].n, "the prose says satellite and weather never changed a v1.1 decision, with the same n as the other policies");
  must(safeAiFile.supportingEvidenceChangedOutcomeOrDisposition.k === 0, "the prose says satellite and weather never changed a v1.1 hold either");
  const changed = safeAiFile.comparedWithLegacy.decisionsChanged;
  must(JSON.stringify(Object.keys(changed)) === JSON.stringify(["rejected/decide -> null/hold"]), "the prose says the only decisions v1.1 changes are rejections that become holds");
  must(changed["rejected/decide -> null/hold"] === safe.heldForReview, "the prose says every v1.1 hold is a former v1-legacy rejection");
  add("FusionLegacyRejectedOnAiAlone", legacy.adverseOnAiAlone.k, "integer", `${RESULTS}/fusion.json`, "/policies/photo-only (v1-legacy)/adverseOnAiAlone/k");
  add("FusionAiAloneScenarios", legacy.adverseOnAiAlone.n, "integer", `${RESULTS}/fusion.json`, "/policies/photo-only (v1-legacy)/adverseOnAiAlone/n");
  add("FusionSafeAiInvalidApprovals", safe.invalidApprovalRate.k, "integer", safePath, "/row/invalidApprovalRate/k");
  add("FusionSafeAiRejectedOnAiAlone", safe.adverseOnAiAlone.k, "integer", safePath, "/row/adverseOnAiAlone/k");
  add("FusionSafeAiHeld", safe.heldForReview, "integer", safePath, "/row/heldForReview");
  add("FusionSafeAiChangedDecisions", changed["rejected/decide -> null/hold"], "integer", safePath, '/comparedWithLegacy/decisionsChanged/"rejected/decide -> null/hold" (the only transition)');

  const geometry = loadJson(`${RESULTS}/geometry.json`);
  add("GeometryAreaBiasPercent", geometry.area.relativeError.p50 * 100, "fixed1", `${RESULTS}/geometry.json`, "/area/relativeError/p50 (x100)");

  const names = loadJson(`${RESULTS}/names.json`);
  const before = String(names.tuningHistory?.[0] ?? "").match(/(\d+) of (\d+) correct/);
  must(before && Number(before[2]) === names.n, "names.json tuningHistory[0] must state 'k of n correct' for the same n");
  add("NamesPairs", names.n, "integer", `${RESULTS}/names.json`, "/n");
  add("NamesCorrectBeforeTuning", Number(before[1]), "integer", `${RESULTS}/names.json`, "/tuningHistory/0 (free text, regex 'k of n correct')");
  add("NamesCorrectAfterTuning", names.accuracy.k, "integer", `${RESULTS}/names.json`, "/accuracy/k");

  // Live satellite case studies.
  const satPath = `${LIVE}/satellite_case_studies_2026-10-16.json`;
  const sat = loadJson(satPath);
  const eventIds = sat.events.filter((e) => e.kind === "event").map((e) => e.id);
  const eventCases = sat.cases.filter((c) => eventIds.includes(c.event));
  const controlCases = sat.cases.filter((c) => !eventIds.includes(c.event));
  const perEvent = sat.events.map((e) => sat.cases.filter((c) => c.event === e.id).length);
  must(perEvent.every((n) => n === perEvent[0]), "squares per event differ; 'three squares each' would be wrong");
  const sides = [...new Set(sat.cases.map((c) => c.areaSideMetres))];
  must(sides.length === 1, "square sizes differ");
  add("StudyDate", sat.runDate, "longDate", satPath, "/runDate");
  add("SatLiveSquares", sat.cases.length, "integer", satPath, "/cases (count)");
  add("SatEventCountWord", eventIds.length, "word", satPath, '/events[kind="event"] (count)');
  add("SatSquaresPerEventWord", perEvent[0], "word", satPath, "/cases grouped by event (count, equal for every event)");
  add("SatSquareSideMetres", sides[0], "integer", satPath, "/cases/*/areaSideMetres (equal for every case)");
  add("SatEventSquares", eventCases.length, "integer", satPath, '/cases where event kind = "event" (count)');
  must(eventCases.every((c) => outcomeOf(c) !== "SUPPORTS_LOSS"), "the prose says no event square supported loss");
  add("SatEventNoChange", eventCases.filter((c) => outcomeOf(c) === "NO_CHANGE").length, "integer", satPath, "event cases with analysis.analysisOutcome NO_CHANGE (count)");
  const tooFewValid = eventCases.filter((c) => outcomeOf(c) === "INCONCLUSIVE");
  must(tooFewValid.every((c) => (c.analysis.reasons || []).includes("post_event_too_few_valid_pixels")), "an inconclusive event analysis is not 'too few valid post-event pixels'");
  add("SatEventTooFewValid", tooFewValid.length, "integer", satPath, "event cases with analysisOutcome INCONCLUSIVE, reason post_event_too_few_valid_pixels (count)");
  const noPost = eventCases.filter((c) => outcomeOf(c) === "NO_POST_DATA");
  must(noPost.every((c) => (c.notes || []).some((n) => /post-event window: no valid statistics/.test(n))), "a not-analysed event case lacks the 'post-event window: no valid statistics' note");
  add("SatEventNoPostData", noPost.length, "integer", satPath, "event cases not analysed, note 'post-event window: no valid statistics' (count)");
  const lowPre = eventCases.filter((c) => c.outcome === "ANALYSIS_COMPLETE" && c.analysis.before && c.analysis.before.ndvi < 0.2);
  must(lowPre.length > 0 && lowPre.every((c) => c.analysis.deltaNdvi > 0), "the prose says NDVI rose afterwards on the low pre-event NDVI squares");
  const lowValues = lowPre.map((c) => c.analysis.before.ndvi);
  add("SatLowPreNdviCountCapWord", lowPre.length, "capitalWord", satPath, "analysed event cases with analysis.before.ndvi < 0.2 (count)");
  add("SatLowPreNdviMin", Math.floor(Math.min(...lowValues) * 100) / 100, "fixed2", satPath, "min analysis.before.ndvi of those cases, rounded down to 0.01");
  add("SatLowPreNdviMax", Math.ceil(Math.max(...lowValues) * 100) / 100, "fixed2", satPath, "max analysis.before.ndvi of those cases, rounded up to 0.01");
  add("SatControlSquares", controlCases.length, "integer", satPath, '/cases where event kind = "control" (count)');
  const controlSupports = controlCases.filter((c) => outcomeOf(c) === "SUPPORTS_LOSS");
  must(controlSupports.length === 1, "the prose describes exactly one control square that supported loss");
  add("SatControlSupports", controlSupports.length, "integer", satPath, "control cases with analysisOutcome SUPPORTS_LOSS (count)");
  add("SatControlSupportsWord", controlSupports.length, "word", satPath, "control cases with analysisOutcome SUPPORTS_LOSS (count)");
  const support = controlSupports[0].analysis;
  add("SatControlSupportDelta", support.deltaNdvi, "fixed2", satPath, "that case's analysis.deltaNdvi");
  add("SatControlSupportPreNdvi", support.before.ndvi, "fixed2", satPath, "that case's analysis.before.ndvi");
  add("SatControlSupportPostNdvi", support.after.ndvi, "fixed2", satPath, "that case's analysis.after.ndvi");
  const latencies = sat.cases.map((c) => c.latencyMs);
  add("SatLatencyMedianSeconds", median(latencies) / 1000, "fixed1", satPath, "median of /cases/*/latencyMs, in seconds");
  add("SatLatencyMaxSeconds", Math.max(...latencies) / 1000, "fixed1", satPath, "max of /cases/*/latencyMs, in seconds");
  add("SatPocHttpStatus", sat.resolutionCheck.pocRequest.httpStatus, "integer", satPath, "/resolutionCheck/pocRequest/httpStatus");

  // Live retrieval.
  const ragPath = `${LIVE}/rag_retrieval_2026-10-16.json`;
  const rag = loadJson(ragPath);
  const ragK = rag.summaryAtProductionTopK;
  must(ragK.answerable.hitRateAnyRelevant.n === rag.queries.answerable, "answerable-query denominators differ");
  add("RagQueries", rag.queries.total, "integer", ragPath, "/queries/total");
  add("RagAnswerableQueries", rag.queries.answerable, "integer", ragPath, "/queries/answerable");
  add("RagAdvisoryQueries", rag.queries.advisory, "integer", ragPath, "/queries/advisory");
  add("RagCorpusChunks", rag.corpus.chunks, "integer", ragPath, "/corpus/chunks");
  add("RagCorpusFiles", rag.corpus.files, "integer", ragPath, "/corpus/files");
  add("RagPestTableChunks", rag.corpus.chunksByFile["RICE_PestPredictionKnowledgeBase.csv"], "integer", ragPath, "/corpus/chunksByFile/RICE_PestPredictionKnowledgeBase.csv");
  add("RagAnswerableRelevantHits", ragK.answerable.hitRateAnyRelevant.k, "integer", ragPath, "/summaryAtProductionTopK/answerable/hitRateAnyRelevant/k");
  add("RagAnswerableExpectedFile", ragK.answerable.anyExpectedFile.k, "integer", ragPath, "/summaryAtProductionTopK/answerable/anyExpectedFile/k");
  add("RagHeaderOnlyHits", ragK.answerableExpectedFileHitsThatAreHeaderOnly.k, "integer", ragPath, "/summaryAtProductionTopK/answerableExpectedFileHitsThatAreHeaderOnly/k");
  add("RagExpectedFileHits", ragK.answerableExpectedFileHitsThatAreHeaderOnly.n, "integer", ragPath, "/summaryAtProductionTopK/answerableExpectedFileHitsThatAreHeaderOnly/n");
  add("RagAdvisoryAnswerBearing", ragK.advisory.answerBearingChunks.k, "integer", ragPath, "/summaryAtProductionTopK/advisory/answerBearingChunks/k");
  add("RagAdvisoryChunks", ragK.advisory.answerBearingChunks.n, "integer", ragPath, "/summaryAtProductionTopK/advisory/answerBearingChunks/n");

  // Live acceptance runs.
  for (const [macro, policy] of [["Legacy", "v1-legacy"], ["Gated", "v2-components"]]) {
    const path = `${LIVE}/acceptance_${policy}_2026-10-16.json`;
    const run = loadJson(path);
    must(/mock image AI/.test(run.environment) && /mock land records/.test(run.environment), `${path}: the prose says acceptance used mock image AI and mock land records`);
    add(`Acceptance${macro}Passed`, run.passed, "integer", path, "/passed");
    add(`Acceptance${macro}Total`, run.total, "integer", path, "/total");
  }

  // Blocked live evaluations.
  const statusPath = `${LIVE}/live_eval_status_2026-10-16.json`;
  const status = loadJson(statusPath);
  const planned = String(status.chatContextLive?.detail ?? "").match(/(\d+) planned items/);
  must(planned, "live_eval_status chatContextLive.detail no longer states the planned item count");
  add("ChatLiveItems", Number(planned[1]), "integer", statusPath, "/chatContextLive/detail (free text, regex 'n planned items')");
  add("LandDocsSynthetic", code.docSpecs.length, "integer", "scripts/live/lib/syntheticLandDocs.js", "DOC_SPECS.length");
  add("LandDocsInjected", code.docSpecs.filter((s) => s.adversarial).length, "integer", "scripts/live/lib/syntheticLandDocs.js", "DOC_SPECS with an adversarial field (count)");

  // Code defaults.
  add("PolicyCountWord", code.policyIds.length, "word", "config/verificationPolicy.js", "POLICY_IDS.length");
  const adr = readText(DECISIONS_PATH).match(/## ADR-022[^\n]*\n+\*\*Status:\*\*[^\n]*?(\d{4}-\d{2}-\d{2})/);
  must(adr, `${DECISIONS_PATH} no longer dates ADR-022 (the v1.1-safe-ai decision) on its status line`);
  must(code.policyIds.includes("v1.1-safe-ai"), "config/verificationPolicy.js no longer defines v1.1-safe-ai");
  add("PolicySafeAiDate", adr[1], "longDate", DECISIONS_PATH, "'## ADR-022' status line date (owner decisions D1, D2: v1.1-safe-ai becomes the default)");
  add("PolicyComponentsCapWord", code.components.length, "capitalWord", "config/verificationPolicy.js", "COMPONENTS.length");
  add("PolicyOutcomesWord", code.outcomes.length, "word", "config/verificationPolicy.js", "COMPONENT_OUTCOMES.length");
  const tuning = `resolvePolicy(id).satellite, equal for ${code.policyIds.join(", ")}`;
  add("SatPreWindowFarDays", code.satellite.preWindowDays[0], "integer", "config/verificationPolicy.js", `${tuning}: preWindowDays[0]`);
  add("SatPreWindowNearDays", code.satellite.preWindowDays[1], "integer", "config/verificationPolicy.js", `${tuning}: preWindowDays[1]`);
  add("SatPostWindowNearDays", code.satellite.postWindowDays[0], "integer", "config/verificationPolicy.js", `${tuning}: postWindowDays[0]`);
  add("SatPostWindowFarDays", code.satellite.postWindowDays[1], "integer", "config/verificationPolicy.js", `${tuning}: postWindowDays[1]`);
  add("SatNdviDropSupport", code.satellite.ndviDropSupport, "fixed2", "config/verificationPolicy.js", `${tuning}: ndviDropSupport`);
  add("SatMinValidPixelFraction", code.satellite.minValidPixelFraction, "fixed1", "config/verificationPolicy.js", `${tuning}: minValidPixelFraction`);
  add("SatSceneCloudMaxPercent", Math.round(code.satelliteConfig.cloudMaxFraction * 100), "integer", "services/satellite/config.js", "resolveSatelliteConfig({}).cloudMaxFraction (x100)");
  add("SatProcessingSceneCloudMaxPercent", Math.round(code.satelliteConfig.processingSceneCloudMax * 100), "integer", "services/satellite/config.js", "resolveSatelliteConfig({}).processingSceneCloudMax (x100)");
  add("AiTimeoutSeconds", code.aiTimeoutMs / 1000, "integer", "utils/aiTimeout.js", "getDefaultTimeoutMs() with GEMINI_TIMEOUT_MS unset (ms / 1000)");
  add("ClaimWritesPerHourAtStudyWord", code.claimWritesAtStudy, "word", STUDY_DEFAULTS_PATH, `/values/CLAIM_RATE_LIMIT_MAX/value (default in config/env.js at commit ${STUDY_COMMIT}, in force during the 16 October 2026 study)`);
  add("ClaimWritesPerHourWord", code.rateLimits.claimWrites, "word", "config/env.js", "RATE_LIMIT_DEFAULTS.claimWrites (current default, owner decision D5)");
  add("EvidenceRequestsPerHour", code.rateLimits.evidence, "integer", "config/env.js", "RATE_LIMIT_DEFAULTS.evidence (current default, owner decision D5)");

  // Bibliography and source ledger.
  const stats = bibStats();
  const ledger = loadJson("docs/research/source_ledger.json");
  const ledgerKeys = ledger.entries.map((e) => e.key).sort();
  must(JSON.stringify(ledgerKeys) === JSON.stringify([...stats.keys].sort()), "source_ledger.json keys differ from references.bib keys");
  add("BibEntries", stats.entries, "integer", "docs/research/references.bib", "@entries (count, scripts/eval/bibStats.js)");
  add("GapFirstPassVerified", ledger.entries.filter((e) => e.pass === 1 && e.verification !== "web_page").length, "integer", "docs/research/source_ledger.json", "entries with pass 1 and verification other than web_page (count)");
  add("GapFirstPassWeb", ledger.entries.filter((e) => e.pass === 1 && e.verification === "web_page").length, "integer", "docs/research/source_ledger.json", "entries with pass 1 and verification web_page (count)");
  add("GapSecondPassAdded", ledger.entries.filter((e) => e.pass === 2).length, "integer", "docs/research/source_ledger.json", "entries with pass 2 (count)");
  const searchDate = readText("docs/research/literature_review.md").match(/\*\*Search date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  must(searchDate, "literature_review.md no longer states its search date");
  add("LiteratureSearchDate", searchDate[1], "longDate", "docs/research/literature_review.md", "'**Search date:**' line");

  return entries;
};

export const renderNumbersTex = (entries) =>
  [
    "% GENERATED by scripts/eval/manuscriptTables.js. Do not edit by hand. One macro per prose number of",
    "% main.tex; the source of each value is in generated_numbers.json. Checked by",
    "% scripts/eval/checkManuscriptNumbers.js (npm run manuscript:numbers).",
    ...entries.map((e) => `\\newcommand{\\${e.macro}}{${e.value}}`),
    "",
  ].join("\n");

export const renderNumbersJson = (entries) =>
  `${JSON.stringify(Object.fromEntries(entries.map(({ macro, value, source, pointer, formatter, raw }) => [macro, { value, source, pointer, formatter, raw }])), null, 2)}\n`;

// Unchanged files are not rewritten, so their modification time keeps meaning "content changed" and the
// stale-PDF check in checkManuscriptNumbers.js does not fire after a no-op regeneration.
const writeIfChanged = (path, text) => {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  writeFileSync(path, text);
  return true;
};

const main = async () => {
  const entries = await computeNumbers();
  const written = [
    [TABLES_PATH, renderTables()],
    [NUMBERS_TEX_PATH, renderNumbersTex(entries)],
    [NUMBERS_JSON_PATH, renderNumbersJson(entries)],
  ].map(([path, text]) => `${basename(path)} ${writeIfChanged(path, text) ? "written" : "unchanged"}`);
  console.log(`${MANUSCRIPT}: ${written.join(", ")} (${entries.length} macros)`);
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error && error.message ? error.message : error);
      process.exit(1);
    }
  );
}
