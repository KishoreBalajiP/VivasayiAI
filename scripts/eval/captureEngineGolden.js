import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Engine golden fixture (plan A0). Records what the deterministic engine decides TODAY under the
// frozen policies (v1-legacy, v2-components) for a full factorial of scenarios plus window and rule
// edge cases, so later engine/policy edits can be proven not to change a single historical decision
// (tests/policy.parity.test.js, PV-1/PV-2, VP-7).
//
//   node scripts/eval/captureEngineGolden.js            write tests/fixtures/engine-golden-2026-10.json
//                                                       (refuses to overwrite an existing fixture)
//   node scripts/eval/captureEngineGolden.js --check    recompute and compare with the fixture
//   node scripts/eval/captureEngineGolden.js --force    overwrite (only when a change is intended)
//
// Pure: no database, no network, no provider. The environment is fixed below to the values the test
// suite runs with (vitest.config.js), and `.env` is never loaded, so the recorded policy hashes are the
// ones the tests compute.
//
// The scenario tables are copied from scripts/eval/fusion.eval.js (same factors, same values) so the
// fixture does not depend on that evaluation script staying unchanged. Evidence row ids are reset per
// scenario, so every scenario's inputs are reproducible on their own.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GOLDEN_FIXTURE_PATH = join(ROOT, "tests", "fixtures", "engine-golden-2026-10.json");
export const GOLDEN_POLICIES = Object.freeze(["v1-legacy", "v2-components"]);
export const GOLDEN_FORMAT = "engine-golden-v1";

const DAY_MS = 24 * 60 * 60 * 1000;
export const GOLDEN_NOW = new Date("2026-09-21T00:00:00.000Z");
const GEOMETRY = { type: "Polygon", coordinates: [[[0, 0], [0.009, 0], [0.009, 0.009], [0, 0.009], [0, 0]]] };
const daysBefore = (days) => new Date(GOLDEN_NOW.getTime() - days * DAY_MS);

// ---------------------------------------------------------------------------------------------
// Scenario tables (factorial values identical to scripts/eval/fusion.eval.js)
// ---------------------------------------------------------------------------------------------

const aggregate = (over = {}) => ({ damageDetected: true, damageType: "flood", confidence: "high", uncertain: false, inconsistencies: [], imageCount: 1, ...over });
const assessmentFor = (agg, quality = "good") => ({ status: "completed", aiAggregate: agg, aiImageAssessments: [{ observation: { cropDetected: "paddy", imageQuality: quality } }] });

const PHOTOS = {
  supportive: () => ({ assessment: assessmentFor(aggregate()), evidenceCount: 1 }),
  no_damage: () => ({ assessment: assessmentFor(aggregate({ damageDetected: false, damageType: null })), evidenceCount: 1 }),
  uncertain: () => ({ assessment: assessmentFor(aggregate({ uncertain: true })), evidenceCount: 1 }),
  none: () => ({ assessment: null, evidenceCount: 0 }),
  // Edge-only photo states: a provider failure, an assessment still running, and photos that were never
  // assessed. Every one of these is "assessment_unavailable" to the engine.
  failed: () => ({ assessment: { status: "failed", aiAggregate: null, aiImageAssessments: [], error: { stage: "provider", message: "x" } }, evidenceCount: 1 }),
  processing: () => ({ assessment: { status: "processing", aiAggregate: null, aiImageAssessments: [] }, evidenceCount: 1 }),
  missing: () => ({ assessment: null, evidenceCount: 1 }),
  low_confidence: () => ({ assessment: assessmentFor(aggregate({ confidence: "low" })), evidenceCount: 1 }),
  no_damage_low_confidence: () => ({ assessment: assessmentFor(aggregate({ damageDetected: false, damageType: null, confidence: "low" })), evidenceCount: 1 }),
  poor_quality: () => ({ assessment: assessmentFor(aggregate(), "poor"), evidenceCount: 1 }),
  type_mismatch: () => ({ assessment: assessmentFor(aggregate({ damageType: "drought" })), evidenceCount: 1 }),
  inconsistent: () => ({ assessment: assessmentFor(aggregate({ inconsistencies: ["Different crops detected across evidence images"] })), evidenceCount: 1 }),
};
const FACTORIAL_PHOTOS = ["supportive", "no_damage", "uncertain", "none"];

const RIGHTS = {
  none: { relationship: null, rows: () => [] },
  owner_pending: { relationship: "owner", rows: (doc) => [doc("PENDING", "ownership_deed")] },
  owner_accepted: { relationship: "owner", rows: (doc) => [doc("AVAILABLE", "ownership_deed")] },
  owner_inconsistent: { relationship: "owner", rows: (doc) => [doc("INCONSISTENT", "ownership_deed")] },
  tenant_wrong_docs: { relationship: "tenant", rows: (doc) => [doc("AVAILABLE", "ownership_deed")] },
  tenant_right_docs: { relationship: "tenant", rows: (doc) => [doc("AVAILABLE", "lease_agreement"), doc("AVAILABLE", "land_record")] },
};

const SATELLITE = {
  none: () => [],
  unavailable: () => [{ _id: "s1", source: "SATELLITE", status: "UNAVAILABLE", idempotencyKey: "sat2_x", createdAt: GOLDEN_NOW, result: null }],
  inconclusive: () => [{ _id: "s2", source: "SATELLITE", status: "INSUFFICIENT", idempotencyKey: "sat2_y", createdAt: GOLDEN_NOW, result: null }],
  supports: () => [{ _id: "s3", source: "SATELLITE", status: "AVAILABLE", idempotencyKey: "sat2_z", createdAt: GOLDEN_NOW, result: { analysisOutcome: "SUPPORTS_LOSS" } }],
};
const WEATHER = {
  none: () => [],
  unavailable: () => [{ _id: "w1", source: "WEATHER", status: "UNAVAILABLE", idempotencyKey: "wx_x", createdAt: GOLDEN_NOW, result: null }],
};

// Rule edge cases. Each entry overrides part of the factorial base scenario (inside the parcel, no
// duplicate, flood two days ago, 0.5 of a 1-acre parcel, full spatial facts).
const EDGES = {
  event_29_days: { eventDaysAgo: 29 },
  event_30_days: { eventDaysAgo: 30 },
  event_31_days: { eventDaysAgo: 31 },
  event_45_days: { eventDaysAgo: 45 },
  event_40_days_first_submitted_day_3: { eventDaysAgo: 40, firstSubmittedDaysAfterEvent: 3 },
  event_40_days_first_submitted_day_31: { eventDaysAgo: 40, firstSubmittedDaysAfterEvent: 31 },
  event_10_days_first_submitted_day_3: { eventDaysAgo: 10, firstSubmittedDaysAfterEvent: 3 },
  event_in_future: { eventDaysAgo: -1 },
  event_type_unknown: { eventType: "hail" },
  event_type_other: { eventType: "other" },
  out_of_limit: { claimedAreaAcres: 1.2 },
  outside_parcel: { inside: false },
  outside_parcel_and_late: { inside: false, eventDaysAgo: 45 },
  duplicate_full: { duplicate: true },
  partial_overlap: { partialOverlap: true },
  partial_overlap_over_budget: { partialOverlap: true, remainingEligibleAcres: 0.1 },
  overlaps_in_flight: { overlapStatus: "overlaps_in_flight" },
  remaining_exceeded: { remainingEligibleAcres: 0.2 },
  cross_farmer_overlap: { cross: true },
  legacy_sparse_unchecked: { legacySparse: "unchecked" },
  legacy_sparse_overlaps_verified: { legacySparse: "overlaps_verified" },
};
const EDGE_PHOTOS = ["supportive", "no_damage", "uncertain", "none", "failed", "processing", "missing", "low_confidence", "no_damage_low_confidence", "poor_quality", "type_mismatch", "inconsistent"];
const EDGE_RIGHTS = ["none", "owner_accepted", "tenant_right_docs"];

// ---------------------------------------------------------------------------------------------
// Scenario descriptors and inputs
// ---------------------------------------------------------------------------------------------

// Every scenario as a small JSON descriptor. The fixture stores these, and the parity tests rebuild
// the engine inputs from them with `buildScenarioInputs`.
export const buildGoldenScenarios = () => {
  const scenarios = [];
  for (const inside of [true, false])
    for (const duplicate of [false, true])
      for (const cross of [false, true])
        for (const photos of FACTORIAL_PHOTOS)
          for (const rights of Object.keys(RIGHTS))
            for (const satellite of Object.keys(SATELLITE))
              for (const weather of Object.keys(WEATHER))
                scenarios.push({
                  id: `f:${inside ? "in" : "out"}:${duplicate ? "dup" : "nodup"}:${cross ? "cross" : "nocross"}:${photos}:${rights}:${satellite}:${weather}`,
                  kind: "factorial",
                  inside, duplicate, cross, photos, rights, satellite, weather,
                });
  for (const [edge, over] of Object.entries(EDGES))
    for (const photos of EDGE_PHOTOS)
      for (const rights of EDGE_RIGHTS)
        scenarios.push({
          id: `e:${edge}:${photos}:${rights}`,
          kind: "edge",
          edge,
          inside: true, duplicate: false, cross: false, satellite: "none", weather: "none",
          ...over,
          photos, rights,
        });
  return scenarios;
};

// Plain engine inputs for one descriptor. Deterministic: ids restart at 1 for every scenario.
export const buildScenarioInputs = (scenario) => {
  let rowSeq = 0;
  const doc = (status, category) => {
    rowSeq += 1;
    return { _id: `d${rowSeq}`, source: "OWNERSHIP", status, idempotencyKey: `owndoc_${rowSeq}`, createdAt: GOLDEN_NOW, metadata: { documentCategory: category }, result: null };
  };
  const eventDaysAgo = scenario.eventDaysAgo ?? 2;
  const eventDate = daysBefore(eventDaysAgo);
  const claim = {
    parcelId: "p1",
    eventType: scenario.eventType ?? "flood",
    eventDate,
    claimedGeometry: GEOMETRY,
    claimedAreaAcres: scenario.claimedAreaAcres ?? 0.5,
    parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 1 },
    claimantRelationship: RIGHTS[scenario.rights].relationship,
  };
  if (typeof scenario.firstSubmittedDaysAfterEvent === "number") {
    claim.firstSubmittedAt = new Date(eventDate.getTime() + scenario.firstSubmittedDaysAfterEvent * DAY_MS);
  }

  let spatial;
  let eligibleContext;
  let overlap = { status: "unchecked", overlapAreaAcres: 0 };
  if (scenario.legacySparse) {
    spatial = null;
    eligibleContext = null;
    overlap = { status: scenario.legacySparse, overlapAreaAcres: scenario.legacySparse === "overlaps_verified" ? 0.5 : 0 };
  } else if (scenario.partialOverlap) {
    spatial = {
      insideParcel: scenario.inside, overlapStatus: "overlaps_verified", overlapAreaAcres: 0.2, fullyCovered: false,
      partialApproval: { geometry: GEOMETRY, areaAcres: 0.3 },
      overlapWarnings: [{ claimId: "c-other", overlapAreaAcres: 0.2 }],
    };
    eligibleContext = { remainingEligibleAcres: scenario.remainingEligibleAcres ?? 0.8, previouslyVerifiedAcres: 0.2, inFlightAreaAcres: 0 };
  } else {
    const overlapStatus = scenario.overlapStatus ?? (scenario.duplicate ? "overlaps_verified" : "none");
    spatial = {
      insideParcel: scenario.inside, overlapStatus, overlapAreaAcres: scenario.duplicate ? 0.5 : overlapStatus === "overlaps_in_flight" ? 0.1 : 0,
      fullyCovered: Boolean(scenario.duplicate), partialApproval: null,
    };
    eligibleContext = {
      remainingEligibleAcres: scenario.remainingEligibleAcres ?? 1,
      previouslyVerifiedAcres: scenario.duplicate ? 0.5 : 0,
      inFlightAreaAcres: overlapStatus === "overlaps_in_flight" ? 0.1 : 0,
    };
  }

  const photos = PHOTOS[scenario.photos]();
  const evidenceRows = [...RIGHTS[scenario.rights].rows(doc), ...SATELLITE[scenario.satellite](), ...WEATHER[scenario.weather]()];
  return {
    claim,
    assessment: photos.assessment,
    evidenceCount: photos.evidenceCount,
    spatial,
    eligibleContext,
    overlap,
    crossOverlap: scenario.cross ? { flagged: true } : null,
    evidenceRows,
    now: GOLDEN_NOW,
  };
};

// Stable JSON (sorted keys, Dates as ISO strings) used for hashing and for deep comparison.
const canonicalValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]).filter(([, v]) => v !== undefined));
  }
  return value;
};
export const canonicalize = (value) => canonicalValue(value);
export const sha256 = (value) => createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
// Table key: the first 16 hex characters of the sha256 (64 bits; the fixture holds a few thousand).
export const shortHash = (value) => sha256(value).slice(0, 16);

// A result is stored as two deduplicated parts: the decision (everything but the component outcomes)
// and the component outcome map. Satellite and weather variants change only the second part.
export const splitResult = (result) => {
  const { components, ...decision } = result;
  return { decision, components: components ?? null };
};

// Run one scenario through the resolver and the engine exactly as the claim service does.
export const evaluateGoldenScenario = ({ scenario, policy, evaluateClaimVerification, resolveComponents }) => {
  const inputs = buildScenarioInputs(scenario);
  const components = resolveComponents({
    claim: inputs.claim,
    assessment: inputs.assessment,
    spatial: inputs.spatial,
    crossOverlap: inputs.crossOverlap,
    evidenceRows: inputs.evidenceRows,
    evidenceCount: inputs.evidenceCount,
    policy,
  });
  const result = evaluateClaimVerification({
    claim: inputs.claim,
    assessment: inputs.assessment,
    overlap: inputs.overlap,
    spatial: inputs.spatial,
    eligibleContext: inputs.eligibleContext,
    weatherCorrelation: null,
    evidenceCount: inputs.evidenceCount,
    now: inputs.now,
    components,
    policy,
  });
  return canonicalValue(result);
};

export const loadGoldenFixture = (path = GOLDEN_FIXTURE_PATH) => JSON.parse(readFileSync(path, "utf8"));

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

const SOURCE_FILES = [
  "services/claimVerificationEngine.service.js",
  "services/verificationComponents.js",
  "config/verificationPolicy.js",
  "config/claimantEvidence.js",
];

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return null;
  }
};

const fileSha = (text) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

export const captureGolden = async () => {
  const { resolvePolicy } = await import("../../config/verificationPolicy.js");
  const engine = await import("../../services/claimVerificationEngine.service.js");
  const { resolveComponents } = await import("../../services/verificationComponents.js");

  const scenarios = buildGoldenScenarios();
  const decisions = {};
  const componentSets = {};
  const rows = [];
  const policies = {};
  for (const id of GOLDEN_POLICIES) {
    const policy = resolvePolicy(id);
    policies[id] = { hash: policy.hash, rules: canonicalValue(policy.rules) };
  }
  for (const scenario of scenarios) {
    const row = { ...scenario, inputsHash: shortHash(buildScenarioInputs(scenario)), results: {} };
    for (const id of GOLDEN_POLICIES) {
      const result = evaluateGoldenScenario({ scenario, policy: resolvePolicy(id), evaluateClaimVerification: engine.evaluateClaimVerification, resolveComponents });
      const { decision, components } = splitResult(result);
      const d = shortHash(decision);
      const c = shortHash(components);
      decisions[d] = decision;
      componentSets[c] = components;
      row.results[id] = { d, c };
    }
    rows.push(row);
  }

  const head = (git(["rev-parse", "HEAD"]) || "").trim() || null;
  const sources = Object.fromEntries(SOURCE_FILES.map((file) => {
    const working = fileSha(readFileSync(join(ROOT, file), "utf8"));
    const atHead = fileSha(head ? git(["show", `${head}:${file}`]) : null);
    return [file, { sha256: working, matchesHead: working === atHead }];
  }));

  return {
    format: GOLDEN_FORMAT,
    description: "Engine decisions under the frozen policies before the v1.1-safe-ai change (plan A0). PV-1/PV-2 require byte-identical replay.",
    capturedAt: new Date().toISOString(),
    commit: head,
    engineVersion: engine.VERIFICATION_ENGINE_VERSION,
    now: GOLDEN_NOW.toISOString(),
    environment: {
      CLAIM_WINDOW_DAYS: process.env.CLAIM_WINDOW_DAYS ?? null,
      CLAIM_AREA_OVERAGE_FRACTION: process.env.CLAIM_AREA_OVERAGE_FRACTION ?? null,
      CLAIM_OVERLAP_TOLERANCE_M: process.env.CLAIM_OVERLAP_TOLERANCE_M ?? null,
      node: process.version,
    },
    sources,
    policies,
    counts: {
      scenarios: rows.length,
      factorial: rows.filter((row) => row.kind === "factorial").length,
      edge: rows.filter((row) => row.kind === "edge").length,
      distinctDecisions: Object.keys(decisions).length,
      distinctComponentSets: Object.keys(componentSets).length,
    },
    scenarios: rows,
    decisions,
    components: componentSets,
  };
};

// Readable but compact: top-level keys indented, one scenario / table entry per line.
const serializeGolden = (golden) => {
  const { scenarios, decisions, components, ...head } = golden;
  const block = (entries) => entries.join(",\n");
  const headJson = JSON.stringify(head, null, 1).replace(/\n}$/, "");
  return `${headJson},
 "scenarios": [
${block(scenarios.map((row) => `  ${JSON.stringify(row)}`))}
 ],
 "decisions": {
${block(Object.entries(decisions).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`))}
 },
 "components": {
${block(Object.entries(components).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`))}
 }
}
`;
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  // Same rule knobs as vitest.config.js; nothing else is read. Must be set before config/env.js loads.
  process.env.VIVASAYI_SKIP_DOTENV = "1";
  process.env.CLAIM_WINDOW_DAYS = "30";
  delete process.env.CLAIM_AREA_OVERAGE_FRACTION;
  delete process.env.CLAIM_OVERLAP_TOLERANCE_M;
  process.env.LOG_LEVEL ||= "silent";

  const check = process.argv.includes("--check");
  const force = process.argv.includes("--force");
  const golden = await captureGolden();
  if (check) {
    const stored = loadGoldenFixture();
    const strip = (fixture) => ({ ...fixture, capturedAt: null, commit: null, sources: null, environment: { ...fixture.environment, node: null } });
    const same = JSON.stringify(strip(stored)) === JSON.stringify(strip(golden));
    console.log(same ? "engine golden: replay matches the fixture" : "engine golden: replay DIFFERS from the fixture");
    process.exit(same ? 0 : 1);
  }
  if (existsSync(GOLDEN_FIXTURE_PATH) && !force) {
    console.error(`Refusing to overwrite ${GOLDEN_FIXTURE_PATH}; pass --force only when the change is intended.`);
    process.exit(1);
  }
  const modified = Object.entries(golden.sources).filter(([, info]) => !info.matchesHead).map(([file]) => file);
  if (modified.length > 0) {
    console.error(`Refusing to capture: these files differ from HEAD: ${modified.join(", ")}`);
    process.exit(1);
  }
  const text = serializeGolden(golden);
  JSON.parse(text); // never write a fixture that does not parse
  writeFileSync(GOLDEN_FIXTURE_PATH, text);
  console.log(`engine golden: ${golden.counts.scenarios} scenarios (${golden.counts.factorial} factorial, ${golden.counts.edge} edge), ${golden.counts.distinctDecisions} distinct decisions, ${golden.counts.distinctComponentSets} component sets -> ${GOLDEN_FIXTURE_PATH}`);
  process.exit(0);
}
