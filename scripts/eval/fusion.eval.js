import { resolvePolicy, COMPONENTS } from "../../config/verificationPolicy.js";
import { evaluateClaimVerification } from "../../services/claimVerificationEngine.service.js";
import { resolveComponents } from "../../services/verificationComponents.js";
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

const NOW = new Date("2026-09-21T00:00:00.000Z");
const GEOMETRY = { type: "Polygon", coordinates: [[[0, 0], [0.009, 0], [0.009, 0.009], [0, 0.009], [0, 0]]] };
const baseClaim = (claimantRelationship) => ({
  parcelId: "p1", eventType: "flood", eventDate: new Date(NOW.getTime() - 2 * 86400000), claimedGeometry: GEOMETRY,
  claimedAreaAcres: 0.5, parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 1 }, claimantRelationship,
});
const aggregate = (over = {}) => ({ damageDetected: true, damageType: "flood", confidence: "high", uncertain: false, inconsistencies: [], imageCount: 1, ...over });
const assessmentFor = (agg) => ({ status: "completed", aiAggregate: agg, aiImageAssessments: [{ observation: { cropDetected: "paddy", imageQuality: "good" } }] });

const PHOTOS = {
  supportive: { assessment: assessmentFor(aggregate()), evidenceCount: 1, supports: true },
  no_damage: { assessment: assessmentFor(aggregate({ damageDetected: false, damageType: null })), evidenceCount: 1, supports: false },
  uncertain: { assessment: assessmentFor(aggregate({ uncertain: true })), evidenceCount: 1, supports: false },
  none: { assessment: null, evidenceCount: 0, supports: false },
};

let rowSeq = 0;
const doc = (status, category) => ({ _id: `d${++rowSeq}`, source: "OWNERSHIP", status, idempotencyKey: `owndoc_${rowSeq}`, createdAt: NOW, metadata: { documentCategory: category }, result: null });
const RIGHTS = {
  none: { relationship: null, rows: () => [], acceptable: false },
  owner_pending: { relationship: "owner", rows: () => [doc("PENDING", "ownership_deed")], acceptable: false },
  owner_accepted: { relationship: "owner", rows: () => [doc("AVAILABLE", "ownership_deed")], acceptable: true },
  owner_inconsistent: { relationship: "owner", rows: () => [doc("INCONSISTENT", "ownership_deed")], acceptable: false },
  tenant_wrong_docs: { relationship: "tenant", rows: () => [doc("AVAILABLE", "ownership_deed")], acceptable: false },
  tenant_right_docs: { relationship: "tenant", rows: () => [doc("AVAILABLE", "lease_agreement"), doc("AVAILABLE", "land_record")], acceptable: true },
};

const SATELLITE = {
  none: () => [],
  unavailable: () => [{ _id: "s1", source: "SATELLITE", status: "UNAVAILABLE", idempotencyKey: "sat2_x", createdAt: NOW, result: null }],
  inconclusive: () => [{ _id: "s2", source: "SATELLITE", status: "INSUFFICIENT", idempotencyKey: "sat2_y", createdAt: NOW, result: null }],
  supports: () => [{ _id: "s3", source: "SATELLITE", status: "AVAILABLE", idempotencyKey: "sat2_z", createdAt: NOW, result: { analysisOutcome: "SUPPORTS_LOSS" } }],
};
const WEATHER = {
  none: () => [],
  unavailable: () => [{ _id: "w1", source: "WEATHER", status: "UNAVAILABLE", idempotencyKey: "wx_x", createdAt: NOW, result: null }],
};

const decide = ({ policy, inside, duplicate, cross, photos, rights, satellite = "none", weather = "none" }) => {
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

export const runFusionEvaluation = () => {
  const scenarios = [];
  for (const inside of [true, false])
    for (const duplicate of [false, true])
      for (const cross of [false, true])
        for (const photos of Object.keys(PHOTOS))
          for (const rights of Object.keys(RIGHTS))
            scenarios.push({ inside, duplicate, cross, photos, rights });

  const shouldApprove = (s) => s.inside && !s.duplicate && !s.cross && PHOTOS[s.photos].supports && RIGHTS[s.rights].acceptable;
  const policies = {
    "photo-only (v1-legacy)": resolvePolicy("v1-legacy"),
    "full fusion (v2-components)": resolvePolicy("v2-components"),
    "v2 without claimant_rights": without("claimant_rights"),
    "v2 without overlap": without("overlap"),
    "v2 without photos": without("photos"),
    "v2 without geometry": without("geometry"),
  };

  const results = {};
  for (const [label, policy] of Object.entries(policies)) {
    const rows = scenarios.map((s) => ({ s, truth: shouldApprove(s), ...decide({ policy, ...s }) }));
    const truthApprove = rows.filter((r) => r.truth);
    const truthNot = rows.filter((r) => !r.truth);
    // Adverse decisions made on the strength of the AI reading alone: everything else is fine, the model
    // says "no damage", and the engine rejects. The design rule wants a person to confirm those.
    const aiAlone = rows.filter((r) => r.s.inside && !r.s.duplicate && !r.s.cross && r.s.photos === "no_damage" && RIGHTS[r.s.rights].acceptable);
    results[label] = {
      scenarios: rows.length,
      invalidApprovalRate: rate(truthNot.filter((r) => r.approved).length, truthNot.length),
      wrongfulNonApprovalRate: rate(truthApprove.filter((r) => !r.approved).length, truthApprove.length),
      adverseOnAiAlone: rate(aiAlone.filter((r) => r.outcome === "rejected").length, aiAlone.length),
      heldForReview: rows.filter((r) => r.disposition === "hold").length,
      invalidApprovalsByCause: Object.fromEntries(["outside", "duplicate", "cross", "photos", "rights"].map((cause) => [cause, truthNot.filter((r) => r.approved && (
        cause === "outside" ? !r.s.inside : cause === "duplicate" ? r.s.duplicate : cause === "cross" ? r.s.cross : cause === "photos" ? !PHOTOS[r.s.photos].supports : !RIGHTS[r.s.rights].acceptable
      )).length])),
    };
  }

  // Supporting evidence (satellite, weather) must never change an outcome, under either policy.
  const flips = {};
  for (const label of ["photo-only (v1-legacy)", "full fusion (v2-components)"]) {
    let compared = 0;
    let changed = 0;
    for (const s of scenarios) {
      const baseline = decide({ policy: policies[label], ...s });
      for (const satellite of Object.keys(SATELLITE)) {
        for (const weather of Object.keys(WEATHER)) {
          compared += 1;
          if (decide({ policy: policies[label], ...s, satellite, weather }).outcome !== baseline.outcome) changed += 1;
        }
      }
    }
    flips[label] = rate(changed, compared);
  }

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

export default runFusionEvaluation;
