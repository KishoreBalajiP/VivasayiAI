import { env } from "../config/env.js";
import { CLAIM_EVENT_TYPES } from "../models/LossClaim.js";

// E9-S5 (ADR-019) — Deterministic Claim Verification Engine (07_Database_Design §8, 06 §9).
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
//   4. overlapCheck     — overlaps_verified → duplicate_area; overlaps_in_flight   → more_evidence_required
//   5. aiCheck          — insufficient/uncertain → more_evidence_required;
//                         confident no-damage                                    → rejected
//   6. weatherCheck     — supporting-only (P3): absence NEVER blocks              → (never fails)
//   else                                                                          → verified
//
// Phase 5 scope notes (documented deferrals, NOT silent):
//   - Overlap (E9-S3) infrastructure is NOT implemented. The orchestration service always passes
//     `overlap: { status: "unchecked", overlapAreaAcres: 0 }`; the engine then reports
//     `overlapCheck.passed: true`, `overlapArea: 0` and `overlapUnchecked: true`. The overlap
//     branches below are implemented + unit-tested so the frozen P5 semantics are ready, but no
//     production call site can trigger them yet.
//   - `partially_verified` has NO frozen trigger condition → the engine NEVER emits it.
//   - Crop consistency is informational ONLY (no authoritative crop taxonomy exists — a parcel
//     crop "Paddy" must not be treated as a mismatch with AI "rice"). It is recorded in `reasons`
//     and never blocks.
//   - Weather correlation is supporting-only (P3): no thresholds, no rejection, null is accepted.

export const VERIFICATION_ENGINE_VERSION = "1";

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

// E9-S5 (ADR-019 P4/P5/P3): pure deterministic evaluation.
//
// Inputs:
//   claim              — claim facts: eventType, eventDate, claimedGeometry, claimedAreaAcres,
//                         parcelSnapshot.parcelAreaAcres. Any extra keys are ignored.
//   assessment         — completed ClaimAssessment (Phase 4) or null when there is no stored evidence.
//   overlap            — { status: "unchecked"|"none"|"overlaps_verified"|"overlaps_in_flight",
//                         overlapAreaAcres } (orchestration: always "unchecked" in Phase 5).
//   weatherCorrelation — supporting-only; accepted but never gates. Null in Phase 5.
//   evidenceCount      — number of stored evidence images (server-derived, never client-derived).
//   now                — injectable Date/epoch for determinism (defaults to Date.now()).
export const evaluateClaimVerification = ({
  claim,
  assessment,
  overlap,
  weatherCorrelation,
  evidenceCount,
  now,
}) => {
  const timestamp = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const claimedAreaAcres = Number(claim && claim.claimedAreaAcres) || 0;
  const parcelAreaAcres = Number(claim && claim.parcelSnapshot && claim.parcelSnapshot.parcelAreaAcres) || 0;
  const remainingEligible = round4(parcelAreaAcres - claimedAreaAcres);
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
  const areaRules = { passed: areaPassed, remainingEligible };

  // --- 4. overlapCheck (P5: frozen outcome semantics; "unchecked" when infra is absent) ---
  const overlapStatus = overlap && overlap.status ? overlap.status : "unchecked";
  const overlapAreaAcres = Number(overlap && overlap.overlapAreaAcres) || 0;
  const overlapPassed = overlapStatus !== "overlaps_verified" && overlapStatus !== "overlaps_in_flight";
  const overlapUnchecked = overlapStatus === "unchecked";
  const overlapRules = { passed: overlapPassed, overlapArea: overlapAreaAcres };

  // --- 5. weatherCheck (P3: supporting-only; absence/absence-of-match never blocks) ---
  const weatherRules = {
    passed: true,
    reason: "Weather is supporting evidence only; its absence never blocks verification",
  };

  // --- 6. aiCheck (P4: AI is evidence, never the decider) ---
  const ai = evaluateAiCheck({ claim, assessment, evidenceCount: Number(evidenceCount) || 0 });

  const reasons = [];
  if (!timelinessPassed) reasons.push("Event date is outside the supported claim window");
  if (!eventTypePassed) reasons.push("Claim event type is not in the supported vocabulary");
  if (!areaPassed) {
    reasons.push(
      `Claimed area (${claimedAreaAcres} acres) exceeds the parcel area allowance (${round4(allowedAreaAcres)} acres)`
    );
  }
  if (overlapStatus === "overlaps_verified") reasons.push("Claim area overlaps an already verified claim");
  if (overlapStatus === "overlaps_in_flight") reasons.push("Claim area overlaps a claim still in progress");
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
  } else if (overlapStatus === "overlaps_verified") {
    outcome = "duplicate_area";
    reason = "Claim area overlaps an already verified claim";
  } else if (overlapStatus === "overlaps_in_flight") {
    outcome = "more_evidence_required";
    reason = "Claim area overlaps a claim still in progress";
  } else if (ai.decision === "rejected") {
    outcome = "rejected";
    reason = ai.reason;
  } else if (ai.decision === "more_evidence_required") {
    outcome = "more_evidence_required";
    reason = ai.reason;
  }

  const approvedGeometry = outcome === "verified" ? claim.claimedGeometry : null;
  const approvedAreaAcres = outcome === "verified" ? claimedAreaAcres : null;

  return {
    outcome,
    reason,
    reasons,
    rules: {
      areaCheck: areaRules,
      overlapCheck: overlapRules,
      aiCheck: { passed: ai.passed, reason: ai.reason },
      weatherCheck: weatherRules,
      eventTypeCheck: eventTypeRules,
      timelinessCheck: timelinessRules,
    },
    approvedGeometry,
    approvedAreaAcres,
    overlapUnchecked,
    engineVersion: VERIFICATION_ENGINE_VERSION,
  };
};

export default {
  VERIFICATION_ENGINE_VERSION,
  OVERLAP_STATUSES,
  evaluateClaimVerification,
};