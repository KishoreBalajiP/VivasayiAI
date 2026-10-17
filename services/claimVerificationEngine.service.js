import { env } from "../config/env.js";
import { CLAIM_EVENT_TYPES } from "../models/LossClaim.js";
import { COMPONENTS as COMPONENT_NAMES, policySetting } from "../config/verificationPolicy.js";

// E9-S5 (ADR-019) — Deterministic Claim Verification Engine (07_Database_Design §8, 06 §9).
// E9-S9 (Phase 9) — Real Overclaim-Prevention Engine: the spatial/eligibility inputs below make the
// frozen engine enact the overclaim-prevention contract (08_API_Documentation §10.8 enriched).
//
// PURE rule engine: no database, no Express, no Gemini, no S3, no weather API, no network.
// It consumes claim facts + the Phase 4 ClaimAssessment AI observation (as EVIDENCE only — the AI
// never decides, P4) and returns the deterministic outcome. The same inputs always produce the
// same output (injectable `now` is the only time source), so verification is auditable and races
// are idempotent.
//
// Frozen rule set (documented) with a strict precedence — the first failing blocking rule decides
// the outcome:
//   1. timelinessCheck  — eventDate within CLAIM_WINDOW_DAYS and not future        → rejected
//   2. eventTypeCheck   — eventType in the frozen CLAIM_EVENT_TYPES vocabulary     → rejected
//   3. areaCheck        — claimedAreaAcres within parcel*(1+CLAIM_AREA_OVERAGE_FRACTION)
//                                                                                 → out_of_limit
//   4. spatialCheck     — (E9-S9, optional) drawn polygon inside the owner's parcel (with
//                         tolerance); outside → rejected
//   5. overlapCheck     — overlaps_verified → duplicate_area OR partially_verified (E9-S9);
//                         overlaps_in_flight → more_evidence_required
//   6. remainingCheck   — (E9-S9, optional) new area ≤ remainingEligibleAcres
//                         (parcel − verified − partially verified − in-flight)    → out_of_limit
//   7. aiCheck          — insufficient/uncertain → more_evidence_required;
//                         confident no-damage                                    → rejected
//   8. weatherCheck     — supporting-only (P3): absence NEVER blocks              → (never fails)
//   else                                                                          → verified
//
// Legacy-sparse mode (backward compatible): when `spatial`/`eligibleContext` are ABSENT the engine
// runs exactly the frozen E9-S5 rules — `overlap` (status + overlapAreaAcres) drives an
// overlaps_verified → duplicate_area, `partially_verified` is NOT emitted, and remainingEligible is
// `parcelArea − claimedArea`. When the E9-S9 spatial engine supplies complete facts, the enriched
// branches below are active. The SAME decision for identical facts either way; the difference is
// only which facts are available.
//
// Phase 5 scope notes (documented deferrals, resolved below in E9-S9):
//   - Overlap evaluation (E9-S3) is now IMPLEMENTED: services/claimSpatial.service.js computes
//     overlap facts with Turf; the engine consumes `spatial.overlapStatus` +
//     `spatial.partialApproval` + `spatial.overlapAreaAcres` + `spatial.overlapWarnings`.
//   - `partially_verified` NOW has a trigger (E9-S9): a drawn polygon that PARTIALLY overlaps an
//     already-verified/partially-verified claim is approved only for its non-overlapping remainder
//     (approvedGeometry = Turf `difference` remainder, approvedAreaAcres = remainder acres).
//   - Crop consistency is informational ONLY (no authoritative crop taxonomy exists — a parcel
//     crop "Paddy" must not be treated as a mismatch with AI "rice"). It is recorded in `reasons`
//     and never blocks.
//   - Weather correlation is supporting-only (P3): no thresholds, no rejection, null is accepted.

export const VERIFICATION_ENGINE_VERSION = "2";

export const OVERLAP_STATUSES = ["unchecked", "none", "overlaps_verified", "overlaps_in_flight"];

// Confidence/qo vocabularies are the frozen AI contract values (ClaimLossVisionTemplates.js).
const ACCEPTABLE_CONFIDENCE = new Set(["high", "medium"]);
const ACCEPTABLE_QUALITY = new Set(["good", "fair"]);

const round4 = (value) => Math.round(value * 10000) / 10000;

const uniqueNonEmpty = (values) => Array.from(new Set(values.filter(Boolean)));

const recordsCandidateSource = (policy) =>
  Boolean(policy) &&
  (policySetting(policy, "aiNoDamageScope") !== null || policySetting(policy, "technicalFailure") === "hold");

export const evaluateAiCheck = ({ claim, assessment, evidenceCount }) => {
  const aggregate = assessment && assessment.aiAggregate ? assessment.aiAggregate : null;
  const imageCount = aggregate && typeof aggregate.imageCount === "number" ? aggregate.imageCount : 0;
  const images = assessment && Array.isArray(assessment.aiImageAssessments)
    ? assessment.aiImageAssessments
    : [];
  const qualities = images
    .map((image) => image.observation && image.observation.imageQuality)
    .filter(Boolean);

  if (!evidenceCount || evidenceCount <= 0) {
    return { passed: false, decision: "more_evidence_required", code: "no_evidence", reason: "No stored evidence to assess" };
  }
  if (!assessment || assessment.status !== "completed" || !aggregate || imageCount <= 0) {
    return {
      passed: false,
      decision: "more_evidence_required",
      code: "assessment_unavailable",
      reason: "AI assessment is not available for the submitted evidence",
    };
  }

  // Confident "no damage" is the only deterministic AI rejection (damageDetected false + not
  // uncertain + reliable confidence). Any doubt composes to more_evidence_required (P4).
  if (
    aggregate.damageDetected === false &&
    aggregate.uncertain === false &&
    ACCEPTABLE_CONFIDENCE.has(aggregate.confidence)
  ) {
    return {
      passed: false,
      decision: "rejected",
      code: "no_damage_confident",
      reason: "AI detected no crop damage in the submitted evidence",
    };
  }

  // Everything else is an insufficiency path (decision `more_evidence_required`).
  if (aggregate.damageDetected !== true) {
    return {
      passed: false,
      decision: "more_evidence_required",
      code: "damage_unconfirmed",
      reason: "AI could not confirm crop damage from the submitted evidence",
    };
  }
  if (aggregate.uncertain === true) {
    return { passed: false, decision: "more_evidence_required", code: "uncertain", reason: "AI is uncertain about the submitted evidence" };
  }
  if (!ACCEPTABLE_CONFIDENCE.has(aggregate.confidence)) {
    return { passed: false, decision: "more_evidence_required", code: "low_confidence", reason: "AI confidence is too low to support verification" };
  }
  if (Array.isArray(aggregate.inconsistencies) && aggregate.inconsistencies.length > 0) {
    return { passed: false, decision: "more_evidence_required", code: "inconsistent", reason: "Conflicting AI observations prevent verification" };
  }
  if (qualities.length === 0 || !qualities.some((quality) => ACCEPTABLE_QUALITY.has(quality))) {
    return { passed: false, decision: "more_evidence_required", code: "poor_quality", reason: "Evidence image quality is too poor for verification" };
  }
  // Damage-type consistency: both sides come from the SAME frozen vocabulary, so a mismatch is
  // authoritative — EXCEPT when the farmer declared `other` (nothing to compare against).
  if (
    claim.eventType !== "other" &&
    aggregate.damageType &&
    aggregate.damageType !== claim.eventType
  ) {
    return {
      passed: false,
      decision: "more_evidence_required",
      code: "type_mismatch",
      reason: "Reported damage type does not match the claimed event type",
    };
  }

  return { passed: true, decision: "verified", code: "ok", reason: "AI observations confirm crop damage consistent with the claim" };
};

// ADR-020 — required-component gate. Pure. Runs AFTER the frozen rules above have produced a
// candidate outcome, and can only make an APPROVAL (verified / partially_verified) more cautious.
// It can never approve anything the frozen rules rejected, and it never produces a rejection:
//   - a required component that is `unverified` or `failed` asks the farmer for more evidence;
//   - a required component that is pending / requires_review / unavailable / inconclusive HOLDS the
//     claim (disposition "hold", outcome null) until a person or a provider resolves it.
// With the AI "no damage" policy set to `review`, a confident no-damage reading holds the claim for
// a reviewer instead of rejecting it: a language model alone must not cause an adverse decision.
//
// ADR-022 (policy v1.1-safe-ai). These two holds are checked BEFORE the gate switch, so a policy
// without the component gate can still use them (v1-legacy has neither, and v2 has the gate on, so
// the order changes nothing for them):
//   - `aiNoDamageScope: "ai_only"` limits the no-damage hold to a rejection the AI rule itself
//     produced (`candidate.source === "aiCheck"`). A rejection for timeliness, event type or an area
//     outside the parcel is not the model's verdict and stays a rejection.
//   - `technicalFailure: "hold"` turns "the AI assessment is unavailable" (a provider failure, an
//     unreadable answer, an assessment that never completed) into a hold instead of a request for
//     more evidence: the farmer did nothing wrong, the queue retries, and a person checks if it
//     keeps failing.
export const applyComponentGate = ({ candidate, ai = null, components = null, policy = null, assessmentErrorKind = null }) => {
  const decide = (outcome, reason, gate = null) => ({ disposition: "decide", outcome, reason, gate });
  if (!policy || !components) return decide(candidate.outcome, candidate.reason, null);

  const policyRef = { policyId: policy.id, policyHash: policy.hash };
  const fromAiRule = candidate.source === "aiCheck";

  const aiOnlyScope = policySetting(policy, "aiNoDamageScope") === "ai_only";
  if (
    candidate.outcome === "rejected" &&
    ai &&
    ai.code === "no_damage_confident" &&
    policy.aiNoDamage === "review" &&
    (!aiOnlyScope || fromAiRule)
  ) {
    const blocking = [{ component: "photos", outcome: "requires_review", action: "hold", reasonCode: "ai_no_damage_needs_review" }];
    return {
      disposition: "hold",
      outcome: null,
      reason: "AI found no damage in the photographs; a reviewer must confirm before any adverse decision",
      gate: { ...policyRef, applied: true, blocking },
    };
  }

  if (policySetting(policy, "technicalFailure") === "hold" && fromAiRule && ai && ai.code === "assessment_unavailable") {
    const reasonCodes = ["ai_assessment_unavailable", ...(assessmentErrorKind ? [`provider_${assessmentErrorKind}`] : [])];
    const blocking = [{ component: "photos", outcome: "unavailable", action: "hold", reasonCodes }];
    return {
      disposition: "hold",
      outcome: null,
      reason: "The automated photo check is temporarily unavailable; it will be retried or checked by a person",
      gate: { ...policyRef, applied: true, blocking },
    };
  }

  if (!policy.gateEnabled) return decide(candidate.outcome, candidate.reason, { ...policyRef, applied: false, blocking: [] });

  if (candidate.outcome !== "verified" && candidate.outcome !== "partially_verified") {
    return decide(candidate.outcome, candidate.reason, { ...policyRef, applied: true, blocking: [] });
  }

  const blocking = [];
  for (const name of COMPONENT_NAMES) {
    const entry = components[name];
    if (!entry || !entry.required || entry.outcome === "verified") continue;
    const onFailed = (policy.components[name] && policy.components[name].onFailed) || "more_evidence_required";
    const action =
      entry.outcome === "unverified"
        ? "more_evidence_required"
        : entry.outcome === "failed"
          ? onFailed
          : "hold";
    blocking.push({ component: name, outcome: entry.outcome, action, reasonCodes: entry.reasonCodes || [] });
  }

  if (blocking.length === 0) return decide(candidate.outcome, candidate.reason, { ...policyRef, applied: true, blocking });

  const needsFarmer = blocking.filter((item) => item.action === "more_evidence_required");
  if (needsFarmer.length > 0) {
    return decide(
      "more_evidence_required",
      `Required evidence is missing or inconsistent: ${needsFarmer.map((item) => item.component).join(", ")}`,
      { ...policyRef, applied: true, blocking }
    );
  }
  return {
    disposition: "hold",
    outcome: null,
    reason: `Awaiting review or verification of: ${blocking.map((item) => item.component).join(", ")}`,
    gate: { ...policyRef, applied: true, blocking },
  };
};

// E9-S5 (ADR-019 P4/P5/P3) + E9-S9 (Phase 9 overclaim prevention): pure deterministic evaluation.
//
// Inputs:
//   claim              — claim facts: eventType, eventDate, claimedGeometry, claimedAreaAcres,
//                         parcelSnapshot.parcelAreaAcres. Any extra keys are ignored.
//   assessment         — completed ClaimAssessment (Phase 4) or null when there is no stored evidence.
//   overlap            — { status: "unchecked"|"none"|"overlaps_verified"|"overlaps_in_flight",
//                         overlapAreaAcres }.
//   spatial            — (E9-S9, optional) the structured context from claimSpatial.service.js:
//                         { insideParcel, overlapStatus, overlapAreaAcres, overlapWarnings,
//                           partialApproval: { geometry, areaAcres } | null, fullyCovered }.
//                         Absent → legacy sparse mode (overlap.status drives duplicate only).
//   eligibleContext    — (E9-S9, optional) { remainingEligibleAcres, previouslyVerifiedAcres,
//                         inFlightAreaAcres }. Absent → legacy remainingEligible = parcel − claimed.
//   weatherCorrelation — supporting-only; accepted but never gates. Null in Phase 5.
//   evidenceCount      — number of stored evidence images (server-derived, never client-derived).
//   now                — injectable Date/epoch for determinism (defaults to Date.now()).
export const evaluateClaimVerification = ({
  claim,
  assessment,
  overlap,
  spatial,
  eligibleContext,
  weatherCorrelation,
  evidenceCount,
  now,
  components = null,
  policy = null,
}) => {
  const timestamp = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const claimedAreaAcres = Number(claim && claim.claimedAreaAcres) || 0;
  const parcelAreaAcres = Number(claim && claim.parcelSnapshot && claim.parcelSnapshot.parcelAreaAcres) || 0;
  const legacyRemainingEligible = round4(parcelAreaAcres - claimedAreaAcres);
  const inferredRemainingEligible =
    eligibleContext && typeof eligibleContext.remainingEligibleAcres === "number"
      ? round4(eligibleContext.remainingEligibleAcres)
      : legacyRemainingEligible;
  // A supplied policy carries the (hashed) rule values; without one the environment is used, so
  // existing callers behave exactly as before.
  const claimWindowDays = policy && policy.rules ? policy.rules.claimWindowDays : env.claimWindowDays;
  const claimAreaOverageFraction =
    policy && policy.rules ? policy.rules.claimAreaOverageFraction : env.claimAreaOverageFraction;
  const allowedAreaAcres = parcelAreaAcres * (1 + claimAreaOverageFraction);

  // --- 1. timelinessCheck (P2: not future, within CLAIM_WINDOW_DAYS) ---
  // ADR-022: a policy may measure the window at the claim's first submission (the filing time), so
  // the time spent waiting for checks, a resubmission or a review never makes a claim late. Without
  // a recorded first submission, or under the older policies, the decision time is used as before.
  const eventTime = claim && claim.eventDate ? new Date(claim.eventDate).getTime() : NaN;
  const windowMs = claimWindowDays * 24 * 60 * 60 * 1000;
  const firstSubmittedTime =
    claim && claim.firstSubmittedAt ? new Date(claim.firstSubmittedAt).getTime() : NaN;
  const windowReference =
    policySetting(policy, "claimWindowReference") === "firstSubmittedAt" && !Number.isNaN(firstSubmittedTime)
      ? firstSubmittedTime
      : timestamp;
  const timelinessPassed =
    !Number.isNaN(eventTime) &&
    eventTime <= timestamp &&
    eventTime <= windowReference &&
    eventTime >= windowReference - windowMs;
  const timelinessRules = { passed: timelinessPassed };

  // --- 2. eventTypeCheck (frozen vocabulary) ---
  const eventTypePassed = Boolean(claim) && CLAIM_EVENT_TYPES.includes(claim.eventType);
  const eventTypeRules = { passed: eventTypePassed };

  // --- 3. areaCheck (P4/P5: server-derived acreage only; AI never contributes) ---
  const areaPassed = claimedAreaAcres <= allowedAreaAcres;
  const areaRules = { passed: areaPassed, remainingEligible: inferredRemainingEligible };

  // --- 4. spatialCheck (E9-S9: drawn area must be inside the owner's parcel) ---
  const insideParcel = spatial && spatial.insideParcel !== undefined ? spatial.insideParcel : null;
  const spatialEvaluated = insideParcel === true || insideParcel === false;
  const spatialPassed = insideParcel !== false; // unknown (null) never blocks — legacy-safe
  const spatialRules = { passed: spatialPassed, insideParcel };

  // --- 5. overlapCheck (E9-S9: real verified/submitted/processing overlap; legacy unchecked) ---
  const overlapStatus =
    spatial && spatial.overlapStatus
      ? spatial.overlapStatus
      : overlap && overlap.status
        ? overlap.status
        : "unchecked";
  const overlapAreaAcres = Number(
    spatial && typeof spatial.overlapAreaAcres === "number"
      ? spatial.overlapAreaAcres
      : (overlap && overlap.overlapAreaAcres) || 0
  );
  const overlapUnchecked = overlapStatus === "unchecked";
  const partialApproval = eligibleContext && spatial && spatial.partialApproval ? spatial.partialApproval : null;

  // Enriched E9-S9 mode only when the spatial engine + eligibility context are both supplied.
  const enriched = Boolean(spatial && eligibleContext);
  // E9-S9 fully-covered duplicate takes precedence over partial approval.
  const fullyCovered = Boolean(spatial && spatial.fullyCovered);
  const overlapsVerified = overlapStatus === "overlaps_verified";
  const overlapsInFlight = overlapStatus === "overlaps_in_flight";
  const overlapPassed = !overlapsVerified && !overlapsInFlight;
  const overlapRules = { passed: overlapPassed, overlapArea: overlapAreaAcres };

  // --- 5b. remainingCheck (E9-S9: claimed/new area must fit the remaining eligible budget) ---
  const remainingEligibleAcres = inferredRemainingEligible;
  const newAreaAcres = partialApproval && typeof partialApproval.areaAcres === "number"
    ? round4(partialApproval.areaAcres)
    : claimedAreaAcres;
  // Enforced ONLY when the eligibility context is supplied; legacy calls without context keep the
  // frozen E9-S5 behavior (no remaining-exceeded rule). A fully-covered duplicate is adjudicated
  // before this rule in the precedence chain.
  const remainingPassed = enriched ? (overlapsVerified ? true : newAreaAcres <= remainingEligibleAcres) : true;
  const remainingRules = { passed: remainingPassed, remainingEligible: remainingEligibleAcres };

  // --- 6. weatherCheck (P3: supporting-only; absence/absence-of-match never blocks) ---
  const weatherRules = {
    passed: true,
    reason: "Weather is supporting evidence only; its absence never blocks verification",
  };

  // --- 7. aiCheck (P4: AI is evidence, never the decider) ---
  const ai = evaluateAiCheck({ claim, assessment, evidenceCount: Number(evidenceCount) || 0 });

  const reasons = [];
  if (!timelinessPassed) reasons.push("Event date is outside the supported claim window");
  if (!eventTypePassed) reasons.push("Claim event type is not in the supported vocabulary");
  if (!areaPassed) {
    reasons.push(
      `Claimed area (${claimedAreaAcres} acres) exceeds the parcel area allowance (${round4(allowedAreaAcres)} acres)`
    );
  }
  if (insideParcel === false) reasons.push("Claimed area is outside the parcel boundary");
  if (overlapsVerified && !enriched) reasons.push("Claim area overlaps an already verified claim");
  if (overlapsVerified && enriched && fullyCovered) reasons.push("Claimed area duplicates an already verified claim");
  if (overlapsVerified && enriched && !fullyCovered) {
    reasons.push(`Claimed area partially overlaps an already verified claim; only ${round4(newAreaAcres)} acres are new`);
  }
  if (overlapsInFlight) reasons.push("Claim area overlaps a claim still in progress");
  if (!remainingPassed) {
    reasons.push(
      `Claimed area (${newAreaAcres} acres) exceeds the remaining eligible acreage (${remainingEligibleAcres} acres)`
    );
  }
  if (!ai.passed) reasons.push(ai.reason);

  // Crop consistency is informational only this phase (no authoritative crop taxonomy exists).
  if (ai.passed && claim && claim.parcelSnapshot && claim.parcelSnapshot.crop) {
    const crops = uniqueNonEmpty(
      (assessment && assessment.aiImageAssessments || []).map(
        (image) => image.observation && image.observation.cropDetected
      )
    );
    if (crops.length === 1 && crops[0] !== claim.parcelSnapshot.crop) {
      reasons.push(
        `AI reported crop "${crops[0]}" differs from parcel crop "${claim.parcelSnapshot.crop}" — informational only, never blocking`
      );
    }
  }

  // --- Deterministic outcome resolution (strict precedence; first failing block wins) ---
  // `candidateSource` names the rule that produced the candidate outcome (null: every rule passed),
  // so the gate can tell a rejection the AI caused from one it did not (ADR-022).
  let outcome = "verified";
  let reason = "All deterministic verification rules passed";
  let candidateSource = null;
  if (!timelinessPassed) {
    outcome = "rejected";
    reason = "Event date is outside the supported claim window";
    candidateSource = "timelinessCheck";
  } else if (!eventTypePassed) {
    outcome = "rejected";
    reason = "Claim event type is not in the supported vocabulary";
    candidateSource = "eventTypeCheck";
  } else if (!areaPassed) {
    outcome = "out_of_limit";
    reason = "Claimed area exceeds the parcel area allowance";
    candidateSource = "areaCheck";
  } else if (insideParcel === false) {
    outcome = "rejected";
    reason = "Claimed area is outside the parcel boundary";
    candidateSource = "spatialCheck";
  } else if (overlapsVerified && !enriched) {
    // Legacy sparse mode (no spatial facts): any verified overlap is a duplicate (frozen E9-S5).
    outcome = "duplicate_area";
    reason = "Claim area overlaps an already verified claim";
    candidateSource = "overlapCheck";
  } else if (overlapsVerified && enriched && fullyCovered) {
    outcome = "duplicate_area";
    reason = "Claimed area duplicates an already verified claim";
    candidateSource = "overlapCheck";
  } else if (overlapsVerified && enriched && partialApproval && partialApproval.areaAcres > 0) {
    // E9-S9: partial overlap → approve ONLY the non-overlapping remainder if it fits the budget.
    if (newAreaAcres > remainingEligibleAcres) {
      outcome = "out_of_limit";
      reason = `Only ${remainingEligibleAcres} acres remain eligible; the ${newAreaAcres} new acres exceed this`;
      candidateSource = "remainingCheck";
    } else {
      outcome = "partially_verified";
      reason = `Partially verified: ${round4(partialApproval.areaAcres)} acres not previously claimed were approved`;
      candidateSource = "overlapCheck";
    }
  } else if (overlapsInFlight) {
    outcome = "more_evidence_required";
    reason = "Claim area overlaps a claim still in progress";
    candidateSource = "overlapCheck";
  } else if (!remainingPassed) {
    outcome = "out_of_limit";
    reason = "Claimed area exceeds the remaining eligible acreage";
    candidateSource = "remainingCheck";
  } else if (ai.decision === "rejected") {
    outcome = "rejected";
    reason = ai.reason;
    candidateSource = "aiCheck";
  } else if (ai.decision === "more_evidence_required") {
    outcome = "more_evidence_required";
    reason = ai.reason;
    candidateSource = "aiCheck";
  }

  // ADR-020: the component gate may turn an approval into a hold or a request for more evidence.
  const assessmentErrorKind =
    assessment && assessment.error && typeof assessment.error.kind === "string" ? assessment.error.kind : null;
  const gated = applyComponentGate({
    candidate: { outcome, reason, source: candidateSource },
    ai,
    components,
    policy,
    assessmentErrorKind,
  });
  const disposition = gated.disposition;
  outcome = gated.outcome;
  reason = gated.reason;
  if (disposition === "hold") reasons.push(gated.reason);
  else if (gated.gate && gated.gate.blocking.length > 0) reasons.push(gated.reason);

  // E9-S9: approved area/geometry are authoritative server values. Fully verified claims keep the
  // geometry-derived area (P4); partially verified claims approve only the non-overlapping
  // remainder (Turf difference, computed by the spatial service). The remainder is normalized to a
  // plain geometry object (Polygon/MultiPolygon) so it serializes like claimedGeometry.
  const normalizeGeometry = (frag) => {
    if (!frag) return null;
    if (frag.type === "Feature" && frag.geometry) return frag.geometry;
    if (frag.type === "Polygon" || frag.type === "MultiPolygon") return frag;
    return null;
  };
  const approvedGeometry =
    outcome === "verified"
      ? claim.claimedGeometry
      : outcome === "partially_verified" && partialApproval
        ? normalizeGeometry(partialApproval.geometry)
        : null;
  const approvedAreaAcres =
    outcome === "verified"
      ? claimedAreaAcres
      : outcome === "partially_verified" && partialApproval
        ? round4(partialApproval.areaAcres)
        : null;

  const overlapWarnings = spatial && Array.isArray(spatial.overlapWarnings) ? spatial.overlapWarnings : [];

  return {
    outcome,
    reason,
    reasons,
    rules: {
      areaCheck: areaRules,
      overlapCheck: overlapRules,
      spatialCheck: spatialRules,
      remainingCheck: remainingRules,
      aiCheck: { passed: ai.passed, reason: ai.reason },
      weatherCheck: weatherRules,
      eventTypeCheck: eventTypeRules,
      timelinessCheck: timelinessRules,
    },
    approvedGeometry,
    approvedAreaAcres,
    overlapUnchecked,
    // E9-S9 rich decision surface (08_API_Documentation §10.8):
    verifiedAreaAcres: approvedAreaAcres,
    remainingEligible: remainingEligibleAcres,
    remainingEligibleAcres: remainingEligibleAcres,
    previouslyVerifiedAcres:
      eligibleContext && typeof eligibleContext.previouslyVerifiedAcres === "number"
        ? round4(eligibleContext.previouslyVerifiedAcres)
        : 0,
    inFlightAreaAcres:
      eligibleContext && typeof eligibleContext.inFlightAreaAcres === "number"
        ? round4(eligibleContext.inFlightAreaAcres)
        : 0,
    overlapWarnings,
    spatialEvaluated,
    // ADR-020 additions (null/"decide" when no policy is supplied, i.e. the legacy path).
    disposition,
    gate: gated.gate,
    components: components
      ? Object.fromEntries(Object.entries(components).map(([name, entry]) => [name, entry.outcome]))
      : null,
    policy: policy ? { id: policy.id, hash: policy.hash } : null,
    engineVersion: VERIFICATION_ENGINE_VERSION,
    // ADR-022: reported only under a policy whose gate reads it, so decisions made under the frozen
    // policies replay byte-identically (tests/policy.parity.test.js).
    ...(recordsCandidateSource(policy) ? { candidateSource } : {}),
  };
};

export default {
  VERIFICATION_ENGINE_VERSION,
  OVERLAP_STATUSES,
  evaluateClaimVerification,
  applyComponentGate,
};