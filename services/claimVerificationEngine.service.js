import { env } from "../config/env.js";
import { CLAIM_EVENT_TYPES } from "../models/LossClaim.js";

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

const evaluateAiCheck = ({ claim, assessment, evidenceCount }) => {
  const aggregate = assessment && assessment.aiAggregate ? assessment.aiAggregate : null;
  const imageCount = aggregate && typeof aggregate.imageCount === "number" ? aggregate.imageCount : 0;
  const images = assessment && Array.isArray(assessment.aiImageAssessments)
    ? assessment.aiImageAssessments
    : [];
  const qualities = images
    .map((image) => image.observation && image.observation.imageQuality)
    .filter(Boolean);

  if (!evidenceCount || evidenceCount <= 0) {
    return { passed: false, decision: "more_evidence_required", reason: "No stored evidence to assess" };
  }
  if (!assessment || assessment.status !== "completed" || !aggregate || imageCount <= 0) {
    return {
      passed: false,
      decision: "more_evidence_required",
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
      reason: "AI detected no crop damage in the submitted evidence",
    };
  }

  // Everything else is an insufficiency path (decision `more_evidence_required`).
  if (aggregate.damageDetected !== true) {
    return {
      passed: false,
      decision: "more_evidence_required",
      reason: "AI could not confirm crop damage from the submitted evidence",
    };
  }
  if (aggregate.uncertain === true) {
    return { passed: false, decision: "more_evidence_required", reason: "AI is uncertain about the submitted evidence" };
  }
  if (!ACCEPTABLE_CONFIDENCE.has(aggregate.confidence)) {
    return { passed: false, decision: "more_evidence_required", reason: "AI confidence is too low to support verification" };
  }
  if (Array.isArray(aggregate.inconsistencies) && aggregate.inconsistencies.length > 0) {
    return { passed: false, decision: "more_evidence_required", reason: "Conflicting AI observations prevent verification" };
  }
  if (qualities.length === 0 || !qualities.some((quality) => ACCEPTABLE_QUALITY.has(quality))) {
    return { passed: false, decision: "more_evidence_required", reason: "Evidence image quality is too poor for verification" };
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
      reason: "Reported damage type does not match the claimed event type",
    };
  }

  return { passed: true, decision: "verified", reason: "AI observations confirm crop damage consistent with the claim" };
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
}) => {
  const timestamp = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const claimedAreaAcres = Number(claim && claim.claimedAreaAcres) || 0;
  const parcelAreaAcres = Number(claim && claim.parcelSnapshot && claim.parcelSnapshot.parcelAreaAcres) || 0;
  const legacyRemainingEligible = round4(parcelAreaAcres - claimedAreaAcres);
  const inferredRemainingEligible =
    eligibleContext && typeof eligibleContext.remainingEligibleAcres === "number"
      ? round4(eligibleContext.remainingEligibleAcres)
      : legacyRemainingEligible;
  const allowedAreaAcres = parcelAreaAcres * (1 + env.claimAreaOverageFraction);

  // --- 1. timelinessCheck (P2: not future, within CLAIM_WINDOW_DAYS) ---
  const eventTime = claim && claim.eventDate ? new Date(claim.eventDate).getTime() : NaN;
  const windowMs = env.claimWindowDays * 24 * 60 * 60 * 1000;
  const timelinessPassed =
    !Number.isNaN(eventTime) &&
    eventTime <= timestamp &&
    eventTime >= timestamp - windowMs;
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
  let outcome = "verified";
  let reason = "All deterministic verification rules passed";
  if (!timelinessPassed) {
    outcome = "rejected";
    reason = "Event date is outside the supported claim window";
  } else if (!eventTypePassed) {
    outcome = "rejected";
    reason = "Claim event type is not in the supported vocabulary";
  } else if (!areaPassed) {
    outcome = "out_of_limit";
    reason = "Claimed area exceeds the parcel area allowance";
  } else if (insideParcel === false) {
    outcome = "rejected";
    reason = "Claimed area is outside the parcel boundary";
  } else if (overlapsVerified && !enriched) {
    // Legacy sparse mode (no spatial facts): any verified overlap is a duplicate (frozen E9-S5).
    outcome = "duplicate_area";
    reason = "Claim area overlaps an already verified claim";
  } else if (overlapsVerified && enriched && fullyCovered) {
    outcome = "duplicate_area";
    reason = "Claimed area duplicates an already verified claim";
  } else if (overlapsVerified && enriched && partialApproval && partialApproval.areaAcres > 0) {
    // E9-S9: partial overlap → approve ONLY the non-overlapping remainder if it fits the budget.
    if (newAreaAcres > remainingEligibleAcres) {
      outcome = "out_of_limit";
      reason = `Only ${remainingEligibleAcres} acres remain eligible; the ${newAreaAcres} new acres exceed this`;
    } else {
      outcome = "partially_verified";
      reason = `Partially verified: ${round4(partialApproval.areaAcres)} acres not previously claimed were approved`;
    }
  } else if (overlapsInFlight) {
    outcome = "more_evidence_required";
    reason = "Claim area overlaps a claim still in progress";
  } else if (!remainingPassed) {
    outcome = "out_of_limit";
    reason = "Claimed area exceeds the remaining eligible acreage";
  } else if (ai.decision === "rejected") {
    outcome = "rejected";
    reason = ai.reason;
  } else if (ai.decision === "more_evidence_required") {
    outcome = "more_evidence_required";
    reason = ai.reason;
  }

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
    engineVersion: VERIFICATION_ENGINE_VERSION,
  };
};

export default {
  VERIFICATION_ENGINE_VERSION,
  OVERLAP_STATUSES,
  evaluateClaimVerification,
};