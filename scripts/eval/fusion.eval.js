import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePolicy, COMPONENTS } from "../../config/verificationPolicy.js";
import { evaluateClaimVerification } from "../../services/claimVerificationEngine.service.js";
import { resolveComponents } from "../../services/verificationComponents.js";
import { writeJsonOnce } from "../live/lib/writeOnce.js";
import { rate } from "./lib/metrics.js";

// Evidence-fusion evaluation: a SPECIFICATION-CONFORMANCE benchmark over a full factorial of scenarios.
//
// Every combination of geometry, duplicate/overlap state, photographs and claimant-rights evidence is run
// through the deterministic engine under different policies. The "should approve" label is defined by the
// design rule (a claim may be approved only if it is inside its parcel, is not a duplicate, has no
// unresolved overlap with another farmer, has photographs that support it, and has acceptable claimant
// rights evidence). Because the label comes from the same design rule the gate implements, this shows that
// the gate enforces its rule and what each component contributes. It is NOT evidence about how accurate
// the rule is on real claims: that needs real labelled claims.

export const NOW = new Date("2026-09-21T00:00:00.000Z");
const GEOMETRY = { type: "Polygon", coordinates: [[[0, 0], [0.009, 0], [0.009, 0.009], [0, 0.009], [0, 0]]] };
const baseClaim = (claimantRelationship) => ({
  parcelId: "p1", eventType: "flood", eventDate: new Date(NOW.getTime() - 2 * 86400000), claimedGeometry: GEOMETRY,
  claimedAreaAcres: 0.5, parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 1 }, claimantRelationship,
});
const aggregate = (over = {}) => ({ damageDetected: true, damageType: "flood", confidence: "high", uncertain: false, inconsistencies: [], imageCount: 1, ...over });
const assessmentFor = (agg) => ({ status: "completed", aiAggregate: agg, aiImageAssessments: [{ observation: { cropDetected: "paddy", imageQuality: "good" } }] });

export const PHOTOS = {
  supportive: { assessment: assessmentFor(aggregate()), evidenceCount: 1, supports: true },
  no_damage: { assessment: assessmentFor(aggregate({ damageDetected: false, damageType: null })), evidenceCount: 1, supports: false },
  uncertain: { assessment: assessmentFor(aggregate({ uncertain: true })), evidenceCount: 1, supports: false },
  none: { assessment: null, evidenceCount: 0, supports: false },
};

let rowSeq = 0;
const doc = (status, category) => ({ _id: `d${++rowSeq}`, source: "OWNERSHIP", status, idempotencyKey: `owndoc_${rowSeq}`, createdAt: NOW, metadata: { documentCategory: category }, result: null });
export const RIGHTS = {
  none: { relationship: null, rows: () => [], acceptable: false },
  owner_pending: { relationship: "owner", rows: () => [doc("PENDING", "ownership_deed")], acceptable: false },
  owner_accepted: { relationship: "owner", rows: () => [doc("AVAILABLE", "ownership_deed")], acceptable: true },
  owner_inconsistent: { relationship: "owner", rows: () => [doc("INCONSISTENT", "ownership_deed")], acceptable: false },
  tenant_wrong_docs: { relationship: "tenant", rows: () => [doc("AVAILABLE", "ownership_deed")], acceptable: false },
  tenant_right_docs: { relationship: "tenant", rows: () => [doc("AVAILABLE", "lease_agreement"), doc("AVAILABLE", "land_record")], acceptable: true },
};

export const SATELLITE = {
  none: () => [],
  unavailable: () => [{ _id: "s1", source: "SATELLITE", status: "UNAVAILABLE", idempotencyKey: "sat2_x", createdAt: NOW, result: null }],
  inconclusive: () => [{ _id: "s2", source: "SATELLITE", status: "INSUFFICIENT", idempotencyKey: "sat2_y", createdAt: NOW, result: null }],
  supports: () => [{ _id: "s3", source: "SATELLITE", status: "AVAILABLE", idempotencyKey: "sat2_z", createdAt: NOW, result: { analysisOutcome: "SUPPORTS_LOSS" } }],
};
export const WEATHER = {
  none: () => [],
  unavailable: () => [{ _id: "w1", source: "WEATHER", status: "UNAVAILABLE", idempotencyKey: "wx_x", createdAt: NOW, result: null }],
};

// Exported (with the scenario tables above) so the decision-consistency suite (DC-*) can compare an
// API + worker run against the pure engine for the same factors. Behaviour is unchanged.
export const decide = ({ policy, inside, duplicate, cross, photos, rights, satellite = "none", weather = "none" }) => {
  const claim = baseClaim(RIGHTS[rights].relationship);
  const spatial = {
    insideParcel: inside, overlapStatus: duplicate ? "overlaps_verified" : "none", overlapAreaAcres: duplicate ? 0.5 : 0,
    fullyCovered: duplicate, partialApproval: null,
  };
  const evidenceRows = [...RIGHTS[rights].rows(), ...SATELLITE[satellite](), ...WEATHER[weather]()];
  const components = resolveComponents({
    claim, assessment: PHOTOS[photos].assessment, spatial, crossOverlap: cross ? { flagged: true } : null,
    evidenceRows, evidenceCount: PHOTOS[photos].evidenceCount, policy,
  });
  const result = evaluateClaimVerification({
    claim, assessment: PHOTOS[photos].assessment, overlap: { status: "unchecked", overlapAreaAcres: 0 }, spatial,
    eligibleContext: { remainingEligibleAcres: 1, previouslyVerifiedAcres: duplicate ? 0.5 : 0, inFlightAreaAcres: 0 },
    evidenceCount: PHOTOS[photos].evidenceCount, now: NOW, components, policy,
  });
  return { outcome: result.outcome, disposition: result.disposition, approved: result.outcome === "verified" || result.outcome === "partially_verified" };
};

// A variant of the v2 policy with one component no longer required (an ablation).
const without = (name) => {
  const base = resolvePolicy("v2-components");
  const clone = JSON.parse(JSON.stringify(base));
  clone.components[name].required = false;
  return clone;
};

// The full factorial: geometry x duplicate x cross-farmer overlap x photographs x claimant rights.
export const buildScenarios = () => {
  const scenarios = [];
  for (const inside of [true, false])
    for (const duplicate of [false, true])
      for (const cross of [false, true])
        for (const photos of Object.keys(PHOTOS))
          for (const rights of Object.keys(RIGHTS))
            scenarios.push({ inside, duplicate, cross, photos, rights });
  return scenarios;
};

const shouldApprove = (s) => s.inside && !s.duplicate && !s.cross && PHOTOS[s.photos].supports && RIGHTS[s.rights].acceptable;

// One row of the policy table. The metric definitions are those of the 16 October 2026 results
// (docs/research/evaluation/results/fusion.json); EV-16 checks that they still reproduce those rows.
const scorePolicy = (policy, scenarios) => {
  const rows = scenarios.map((s) => ({ s, truth: shouldApprove(s), ...decide({ policy, ...s }) }));
  const truthApprove = rows.filter((r) => r.truth);
  const truthNot = rows.filter((r) => !r.truth);
  // Adverse decisions made on the strength of the AI reading alone: everything else is fine, the model
  // says "no damage", and the engine rejects. The design rule wants a person to confirm those.
  const aiAlone = rows.filter((r) => r.s.inside && !r.s.duplicate && !r.s.cross && r.s.photos === "no_damage" && RIGHTS[r.s.rights].acceptable);
  return {
    scenarios: rows.length,
    invalidApprovalRate: rate(truthNot.filter((r) => r.approved).length, truthNot.length),
    wrongfulNonApprovalRate: rate(truthApprove.filter((r) => !r.approved).length, truthApprove.length),
    adverseOnAiAlone: rate(aiAlone.filter((r) => r.outcome === "rejected").length, aiAlone.length),
    heldForReview: rows.filter((r) => r.disposition === "hold").length,
    invalidApprovalsByCause: Object.fromEntries(["outside", "duplicate", "cross", "photos", "rights"].map((cause) => [cause, truthNot.filter((r) => r.approved && (
      cause === "outside" ? !r.s.inside : cause === "duplicate" ? r.s.duplicate : cause === "cross" ? r.s.cross : cause === "photos" ? !PHOTOS[r.s.photos].supports : !RIGHTS[r.s.rights].acceptable
    )).length])),
  };
};

// Supporting evidence (satellite, weather) must never change a decision. `compare` picks what counts as
// a change: the outcome only (the published metric) or the outcome and the disposition (decide / hold).
const supportingEvidenceFlips = (policy, scenarios, compare = (a, b) => a.outcome === b.outcome) => {
  let compared = 0;
  let changed = 0;
  for (const s of scenarios) {
    const baseline = decide({ policy, ...s });
    for (const satellite of Object.keys(SATELLITE)) {
      for (const weather of Object.keys(WEATHER)) {
        compared += 1;
        if (!compare(decide({ policy, ...s, satellite, weather }), baseline)) changed += 1;
      }
    }
  }
  return rate(changed, compared);
};

const LEGACY_LABEL = "photo-only (v1-legacy)";
const GATE_LABEL = "full fusion (v2-components)";
// ADR-022 (owner decisions D1, D2). Added on 2026-10-16 after the rows above were published; it is the
// last key, so the earlier rows and their order are unchanged (EV-16).
export const SAFE_AI_LABEL = "photo-only, safe AI (v1.1-safe-ai)";
export const SAFE_AI_POLICY_ID = "v1.1-safe-ai";
// The labels of the 16 October 2026 results (docs/research/evaluation/results/fusion.json), in order.
export const PUBLISHED_LABELS = Object.freeze([LEGACY_LABEL, GATE_LABEL, "v2 without claimant_rights", "v2 without overlap", "v2 without photos", "v2 without geometry"]);
export const PUBLISHED_FLIP_LABELS = Object.freeze([LEGACY_LABEL, GATE_LABEL]);

export const runFusionEvaluation = () => {
  const scenarios = buildScenarios();
  const policies = {
    [LEGACY_LABEL]: resolvePolicy("v1-legacy"),
    [GATE_LABEL]: resolvePolicy("v2-components"),
    "v2 without claimant_rights": without("claimant_rights"),
    "v2 without overlap": without("overlap"),
    "v2 without photos": without("photos"),
    "v2 without geometry": without("geometry"),
    [SAFE_AI_LABEL]: resolvePolicy(SAFE_AI_POLICY_ID),
  };

  const results = {};
  for (const [label, policy] of Object.entries(policies)) results[label] = scorePolicy(policy, scenarios);

  // Supporting evidence (satellite, weather) must never change an outcome, under any policy.
  const flips = {};
  for (const label of [LEGACY_LABEL, GATE_LABEL, SAFE_AI_LABEL]) flips[label] = supportingEvidenceFlips(policies[label], scenarios);

  return {
    name: "fusion",
    description: "Full-factorial scenario benchmark of the deterministic engine: photographs-only (legacy policy) versus component fusion, with one-component-removed ablations.",
    groundTruth: "the design rule (approve only when inside the parcel, not a duplicate, no unresolved cross-farmer overlap, supportive photographs, acceptable claimant-rights evidence); AUTHOR-DEFINED and identical to what the gate implements",
    scenarioFactors: { geometry: 2, duplicate: 2, crossFarmerOverlap: 2, photos: Object.keys(PHOTOS), claimantRights: Object.keys(RIGHTS), total: scenarios.length },
    policies: results,
    supportingEvidenceChangedOutcome: flips,
    components: COMPONENTS,
    reading: [
      "Photo-only approves claims with no, pending or inconsistent ownership evidence; the gate does not.",
      "Each ablation re-opens exactly the invalid approvals its component prevents (see invalidApprovalsByCause).",
      "Satellite and weather outcomes never change a decision, by design: they are optional supporting evidence.",
    ],
    limitations: [
      "The label is the design rule, so this shows rule enforcement and component contribution, not real-world accuracy.",
      "Scenarios are a synthetic full factorial; real claims are correlated and far messier.",
      "Evidence states are idealised (a document is cleanly pending, accepted or inconsistent).",
    ],
  };
};

// --- The v1.1-safe-ai row as its own dated, write-once result ---------------------------------------
//
// results/fusion.json is the published 16 October 2026 baseline and is not rewritten for a new row.
// The v1.1 row is written to results/fusion_v1.1_<date>.json instead, together with a check that the
// published rows still reproduce byte for byte (EV-16) and the decisions that change against v1-legacy.
//   VIVASAYI_SKIP_DOTENV=1 node scripts/eval/fusion.eval.js --safe-ai-row --date=YYYY-MM-DD

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASELINE_PATH = "docs/research/evaluation/results/fusion.json";
export const safeAiRowPath = (date) => join(root, "docs", "research", "evaluation", "results", `fusion_v1.1_${date}.json`);
// Environment variables that change the merged policy rules (and so the policy hash) of every policy.
const RULE_ENV_KEYS = ["CLAIM_WINDOW_DAYS", "CLAIM_AREA_OVERAGE_FRACTION", "CLAIM_OVERLAP_TOLERANCE_M"];

// The published rows that no longer reproduce byte for byte (empty: EV-16 holds).
export const publishedRowDifferences = (baseline, current = runFusionEvaluation()) => {
  const differences = [];
  const same = (a, b) => JSON.stringify(a, null, 2) === JSON.stringify(b, null, 2);
  for (const label of PUBLISHED_LABELS) if (!same(current.policies[label], baseline.policies[label])) differences.push(`policies/${label}`);
  for (const label of PUBLISHED_FLIP_LABELS) if (!same(current.supportingEvidenceChangedOutcome[label], baseline.supportingEvidenceChangedOutcome[label])) differences.push(`supportingEvidenceChangedOutcome/${label}`);
  if (!same(current.scenarioFactors, baseline.scenarioFactors)) differences.push("scenarioFactors");
  return differences;
};

// Pure: the content of the dated v1.1 file, without the run environment.
export const computeSafeAiRow = ({ baseline }) => {
  const scenarios = buildScenarios();
  const legacy = resolvePolicy("v1-legacy");
  const safeAi = resolvePolicy(SAFE_AI_POLICY_ID);
  const current = runFusionEvaluation();
  const row = current.policies[SAFE_AI_LABEL];
  const legacyRow = current.policies[LEGACY_LABEL];

  // Every scenario whose decision differs from v1-legacy, as "outcome/disposition -> outcome/disposition".
  const transitions = {};
  let unchanged = 0;
  for (const s of scenarios) {
    const before = decide({ policy: legacy, ...s });
    const after = decide({ policy: safeAi, ...s });
    if (before.outcome === after.outcome && before.disposition === after.disposition) {
      unchanged += 1;
      continue;
    }
    const key = `${before.outcome}/${before.disposition} -> ${after.outcome}/${after.disposition}`;
    transitions[key] = (transitions[key] || 0) + 1;
  }

  const differences = publishedRowDifferences(baseline, current);
  return {
    name: "fusion-v1.1-safe-ai",
    description: "The v1.1-safe-ai row of the fusion benchmark (scripts/eval/fusion.eval.js), on the same full factorial and with the same metrics as the published rows. Computed, not assumed.",
    groundTruth: current.groundTruth,
    baseline: {
      file: BASELINE_PATH,
      sha256: createHash("sha256").update(readFileSync(join(root, BASELINE_PATH))).digest("hex"),
      publishedLabels: [...PUBLISHED_LABELS],
      publishedRowsReproduced: differences.length === 0,
      differences,
    },
    policy: { id: safeAi.id, hash: safeAi.hash, rules: safeAi.rules },
    label: SAFE_AI_LABEL,
    scenarioFactors: current.scenarioFactors,
    row,
    supportingEvidenceChangedOutcome: current.supportingEvidenceChangedOutcome[SAFE_AI_LABEL],
    // Stricter than the published metric: a hold that satellite or weather turned into a decision (or
    // the reverse) also counts as a change.
    supportingEvidenceChangedOutcomeOrDisposition: supportingEvidenceFlips(safeAi, scenarios, (a, b) => a.outcome === b.outcome && a.disposition === b.disposition),
    comparedWithLegacy: {
      legacyLabel: LEGACY_LABEL,
      invalidApprovals: { legacy: legacyRow.invalidApprovalRate.k, safeAi: row.invalidApprovalRate.k, n: row.invalidApprovalRate.n, reduced: row.invalidApprovalRate.k < legacyRow.invalidApprovalRate.k },
      rejectedOnAiAlone: { legacy: legacyRow.adverseOnAiAlone.k, safeAi: row.adverseOnAiAlone.k, n: row.adverseOnAiAlone.n },
      heldForReview: { legacy: legacyRow.heldForReview, safeAi: row.heldForReview },
      decisionsUnchanged: unchanged,
      decisionsChanged: transitions,
    },
    notCovered: [
      "Technical failures (provider error, unreadable model output) are not factors of this factorial; the 'none' photographs level is 'no stored evidence', not a failed assessment. Their v1.1 handling (hold, never more_evidence_required) is covered by the engine and service tests (tests/claim.verify.safeAi.test.js), not by this benchmark.",
      "The claim-window reference (first submission under v1.1) does not change any decision here: every scenario's event is two days before the decision time.",
      "Queue timing (satellite never waited for) is not modelled: the engine is called with the evidence rows directly.",
    ],
    limitations: current.limitations,
  };
};

const gitValue = (command) => {
  try {
    return execSync(command, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
};

const writeSafeAiRow = (argv) => {
  const dateArg = argv.find((arg) => arg.startsWith("--date="));
  const date = dateArg ? dateArg.slice("--date=".length) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date=YYYY-MM-DD is required");
  // The policy hash covers the merged rules, so the developer's .env or a rule override would make the
  // recorded hash differ from the code default. Refuse rather than record an environment-specific hash.
  if (process.env.VIVASAYI_SKIP_DOTENV !== "1") throw new Error("set VIVASAYI_SKIP_DOTENV=1 so the developer's .env cannot change the policy rules");
  const overridden = RULE_ENV_KEYS.filter((key) => process.env[key] !== undefined);
  if (overridden.length) throw new Error(`unset ${overridden.join(", ")}: the row must use the code-default policy rules`);

  const baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
  const content = computeSafeAiRow({ baseline });
  if (!content.baseline.publishedRowsReproduced) throw new Error(`EV-16: the published rows no longer reproduce (${content.baseline.differences.join(", ")}); fix that before adding a row`);
  const environment = {
    date,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    commit: gitValue("git rev-parse --short HEAD"),
    branch: gitValue("git rev-parse --abbrev-ref HEAD"),
    dirty: Boolean(gitValue("git status --porcelain")),
  };
  const path = writeJsonOnce(safeAiRowPath(date), { environment, ...content });
  const { row } = content;
  console.log(`${relative(root, path)} written: invalid approvals ${row.invalidApprovalRate.k}/${row.invalidApprovalRate.n}, rejected on AI alone ${row.adverseOnAiAlone.k}/${row.adverseOnAiAlone.n}, held ${row.heldForReview}, satellite/weather changed ${content.supportingEvidenceChangedOutcome.k}/${content.supportingEvidenceChangedOutcome.n}`);
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    if (!process.argv.includes("--safe-ai-row")) throw new Error("usage: VIVASAYI_SKIP_DOTENV=1 node scripts/eval/fusion.eval.js --safe-ai-row --date=YYYY-MM-DD (the full benchmark runs through npm run eval)");
    writeSafeAiRow(process.argv.slice(2));
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exit(error && error.exitCode ? error.exitCode : 1);
  }
}

export default runFusionEvaluation;
