import mongoose from "mongoose";
import { createHash } from "node:crypto";
import ApiError from "../utils/ApiError.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { env } from "../config/env.js";
import { applyTransition } from "./claimState.service.js";
import claimAssessmentService from "./claimAssessment.service.js";
import { computeEvidenceVersion } from "./claimAssessment.service.js";
import { buildSpatialContext } from "./claimSpatial.service.js";
import { getForUser as getParcelForUser } from "./parcel.service.js";
import {
  evaluateClaimVerification,
  VERIFICATION_ENGINE_VERSION,
} from "./claimVerificationEngine.service.js";
import { resolvePolicy, policySetting } from "../config/verificationPolicy.js";
import { resolveComponents } from "./verificationComponents.js";
import logger from "../utils/logger.js";
import { findCrossFarmerOverlap } from "./crossFarmerOverlap.service.js";
import { correlationIdFor, countBlockingActiveJobs, enqueue, retryDelayMs } from "./verificationJobs.service.js";

// E9-S5/E9-S6 (ADR-019) — Claim Verification orchestration. Phase 5 shipped it as an internal
// service with no public endpoint; Phase 6 (integration) exposes it through the THIN HTTP surface
// POST /claims/:claimId/verify (08_API_Documentation §10.8) — the controller only forwards
// { claimId, cognitoSub, requestId } and any client-supplied payload is structurally ignored.
// E9-S9 (Phase 9) — Real Overclaim-Prevention Engine: the orchestration now supplies the engine
// with the spatial engine's facts (inside-parcel, verified/in-flight overlap, remaining eligible
// budget). The fundamental invariants above are unchanged: backend calculates, validates, stores.
//
// Consumes a SUBMITTED claim + its Phase 4 ClaimAssessment and runs the pure deterministic engine,
// then persists the decision additively into `claimassessment` and transitions the claim via the
// frozen state machine (submitted → processing → decision). The AI never decides (P4); the engine
// only consumes a COMPLETED assessment whose `evidenceVersion` matches the current stored evidence
// set. Missing/stale assessment with stored evidence is a RETRYABLE internal failure (verify after
// `assessClaimEvidence` completes) — never silently converted into a rejection.
//
// Idempotency & concurrency (mirrors the Phase 4 slot discipline):
//   - An ALREADY-decided claim (decision states) returns its persisted decision without re-running.
//   - Exactly one worker wins the atomic `submitted → processing` CAS; the loser reuses the
//     winner's persisted decision or returns an `inProgress` signal — never a duplicate run.
//   - Deterministic inputs (same claim + same assessment + same overlap signal) ⇒ same outcome, so
//     any race that does resolve converges on the identical persisted decision.
//
// Phase 9 (E9-S9) — overclaim prevention (resolves the Phase 5 deferral):
//   - Overlap IS evaluated every run via services/claimSpatial.service.js (Turf). The engine input
//     is `spatial` + `eligibleContext`; audit metadata now records `overlapEvaluated: true` with
//     the overlap result, remaining eligible budget, and requestId (08_API_Documentation §10.8).
//   - `partially_verified` has a real trigger (partial overlap); the approved geometry/area are
//     the Turf-computed non-overlapping remainder.
//   - No weather integration: `weatherCorrelation` stays null; the weather rule is supporting-only
//     (P3) and cannot reject.
//   - Returns the serialized decision enriched with verifiedAreaAcres / remainingEligible /
//     overlapWarnings / decision (same additive envelope already consumed by claim detail).

const DECIDED_STATES = new Set([
  "verified",
  "partially_verified",
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "more_evidence_required",
]);

const ALLOWED_EVIDENCE_STATUS = ["stored"];

// E9-S9 — load the owner-scoped sibling claims on the same parcel and build the spatial facts
// (services/claimSpatial.service.js). The current claim is EXCLUDED from its own budget.
// - verified / partially_verified siblings reserve their APPROVED geometry+area (assessment
//   authoritative; falls back to the claimed geometry+area when no assessment row exists).
// - submitted / processing (in-flight) siblings reserve their CLAIMED geometry+area; they cannot
//   be cancelled and are never excluded from the budget.
// Returns { spatial, eligibleContext } consumed by the deterministic engine. Never throws: a
// missing parcel/profile/geometry degrades to the frozen legacy "unchecked" spatial facts.
const buildSpatialFacts = async ({ claim, cognitoSub }) => {
  const parcelId = claim.parcelSnapshot ? claim.parcelSnapshot.parcelId : null;
  const parcelAreaAcres = claim.parcelSnapshot ? claim.parcelSnapshot.parcelAreaAcres : 0;

  const siblingClaims = parcelId
    ? await LossClaim.find({
        cognitoSub,
        parcelId,
        _id: { $ne: claim._id },
        state: { $in: ["verified", "partially_verified", "submitted", "processing"] },
      }).lean()
    : [];

  const siblingIds = siblingClaims.map((s) => String(s._id));
  const siblingAssessments =
    siblingIds.length > 0
      ? await ClaimAssessment.find({ claimId: { $in: siblingIds } }).lean()
      : [];
  const assessmentByClaim = new Map(siblingAssessments.map((a) => [String(a.claimId), a]));

  const verifiedSiblings = [];
  const inFlightSiblings = [];
  for (const sibling of siblingClaims) {
    const assessment = assessmentByClaim.get(String(sibling._id)) || null;
    const decided = sibling.state === "verified" || sibling.state === "partially_verified";
    const geometry =
      decided && assessment && assessment.approvedGeometry
        ? assessment.approvedGeometry
        : sibling.claimedGeometry;
    const areaAcres =
      decided && assessment && typeof assessment.approvedAreaAcres === "number"
        ? assessment.approvedAreaAcres
        : sibling.claimedAreaAcres;
    const entry = {
      claimId: String(sibling._id),
      siblingState: sibling.state,
      geometry,
      areaAcres,
    };
    if (decided) verifiedSiblings.push(entry);
    else inFlightSiblings.push(entry);
  }

  let parcelGeometry = null;
  try {
    const parcel = parcelId ? await getParcelForUser(cognitoSub, parcelId) : null;
    parcelGeometry = parcel ? parcel.geometry : null;
  } catch {
    parcelGeometry = null;
  }

  const spatial = buildSpatialContext({
    claimedGeometry: claim.claimedGeometry,
    claimedAreaAcres: claim.claimedAreaAcres,
    parcelGeometry,
    parcelAreaAcres,
    verifiedSiblings,
    inFlightSiblings,
    toleranceMeters: Number(env.claimOverlapToleranceM) || 0,
  });

  return {
    spatial,
    eligibleContext: {
      remainingEligibleAcres: spatial.remainingEligibleAcres,
      previouslyVerifiedAcres: spatial.previouslyVerifiedAcres,
      inFlightAreaAcres: spatial.inFlightAreaAcres,
    },
  };
};

// ADR-020 — what a decision looked like at the time: component outcomes (without the evidence
// references), the evidence rows the engine saw, and the policy. Stored on the assessment and on
// the decision audit row so any decision can be explained from the evidence and policy used.
export const buildDecisionSnapshot = ({ components, policy }) => {
  const summary = {};
  const refs = new Map();
  for (const [name, value] of Object.entries(components)) {
    summary[name] = {
      outcome: value.outcome,
      required: value.required,
      authoritative: value.authoritative,
      actionableBy: value.actionableBy,
      reasonCodes: value.reasonCodes,
    };
    for (const ref of value.evidenceRefs || []) refs.set(ref.id, ref);
  }
  return { components: summary, evidenceRefs: [...refs.values()], policy: { id: policy.id, hash: policy.hash } };
};

export const serializeDecision = ({ claim, assessment, idempotent, inProgress, held }) => ({
  claimId: String(claim._id),
  idempotent,
  inProgress,
  claimState: claim.state,
  outcome: !held && assessment && assessment.state ? assessment.state : null,
  decision: !held && assessment && assessment.state ? assessment.state : null,
  reason: assessment ? assessment.reason : null,
  rules: assessment ? assessment.rules : null,
  approvedGeometry: assessment ? assessment.approvedGeometry : null,
  approvedAreaAcres: assessment ? assessment.approvedAreaAcres : null,
  // E9-S9 — real overclaim-prevention surface (additive; always server-derived).
  verifiedAreaAcres: assessment ? assessment.verifiedAreaAcres : null,
  remainingEligible: assessment ? assessment.remainingEligible : null,
  previouslyVerifiedAcres: assessment ? assessment.previouslyVerifiedAcres : null,
  inFlightAreaAcres: assessment ? assessment.inFlightAreaAcres : null,
  overlapWarnings: assessment ? assessment.overlapWarnings || [] : [],
  spatialEvaluated: assessment ? Boolean(assessment.spatialEvaluated) : false,
  weatherCorrelation: assessment ? assessment.weatherCorrelation || null : null,
  decidedAt: assessment ? assessment.decidedAt : null,
  decidedBy: assessment ? assessment.decidedBy : null,
  claimedAreaAcres: claim.claimedAreaAcres,
  parcelAreaAcres: claim.parcelSnapshot ? claim.parcelSnapshot.parcelAreaAcres : null,
  evidenceVersion: assessment ? assessment.evidenceVersion : null,
  engineVersion: assessment && assessment.verification ? assessment.verification.version : null,
  // ADR-020 (additive). `held`: a required component is unresolved, so no decision exists yet and
  // the claim is still `submitted`. Decisions made before policies existed report policyId "legacy".
  held: Boolean(held) || Boolean(assessment && !assessment.state && assessment.verification && assessment.verification.status === "held"),
  pendingComponents: assessment && assessment.hold && Array.isArray(assessment.hold.blocking)
    ? assessment.hold.blocking.map((item) => ({ component: item.component, outcome: item.outcome, action: item.action }))
    : [],
  components: assessment && assessment.components ? assessment.components : null,
  policyId: assessment && assessment.policy && assessment.policy.id ? assessment.policy.id : "legacy",
  policyHash: assessment && assessment.policy ? assessment.policy.hash || null : null,
});

const loadDecision = async (claim) => {
  const assessment = await ClaimAssessment.findOne({ claimId: claim._id });
  if (!assessment || !assessment.state) {
    // A decided claim without a persisted decision is an internal inconsistency — never guess.
    throw ApiError.internal("Internal: decided claim is missing its persisted verification decision");
  }
  return serializeDecision({ claim, assessment, idempotent: true, inProgress: false });
};

const failVerification = async ({ claimId, assessment, stage, message, requestId }) => {
  if (assessment) {
    await ClaimAssessment.updateOne(
      { claimId },
      {
        $set: {
          verification: {
            status: "failed",
            version: VERIFICATION_ENGINE_VERSION,
            startedAt: new Date(),
            failedAt: new Date(),
            error: { stage, message },
          },
        },
      }
    );
  }
  await ClaimAudit.create({
    claimId,
    actor: "engine",
    action: "verification_failed",
    fromState: null,
    toState: null,
    reason: message,
    metadata: { stage },
    requestId: requestId || null,
  });
};

// D8: the claim was decided by someone else (an admin override of the held claim) while this run was
// evaluating it. Return that decision; while it is still being written, report progress, never a hold.
const decisionAfterRace = async (claim) => {
  const current = (await LossClaim.findById(claim._id)) || claim;
  const assessment = await ClaimAssessment.findOne({ claimId: claim._id });
  if (DECIDED_STATES.has(current.state) && assessment && assessment.state) {
    return serializeDecision({ claim: current, assessment, idempotent: true, inProgress: false });
  }
  return serializeDecision({ claim: current, assessment, idempotent: false, inProgress: true });
};

// A gate item's reason codes. The engine's AI "no damage" item names its reason in the singular
// `reasonCode`; every other item uses `reasonCodes`.
const reasonCodesOf = (item) =>
  Array.isArray(item.reasonCodes) ? item.reasonCodes : item.reasonCode ? [item.reasonCode] : [];

// ADR-020 — a required component is unresolved, so there is NO decision yet. The claim is left in
// `submitted` (no lock is held, the farmer can still withdraw) and the reason is recorded on the
// assessment. The audit row is written only when the SITUATION changes (different blockers or a
// changed evidence row), so a poller or a retry cannot flood the audit trail.
const persistHold = async ({ claim, assessment, evaluation, snapshot, fingerprint, now, requestId }) => {
  // Reason codes are normalised (see reasonCodesOf) so the stored hold always carries the reason.
  // The hold fingerprint uses only component and outcome, so this cannot make a hold look "new".
  const blocking = evaluation.gate.blocking.map((item) => ({
    component: item.component,
    outcome: item.outcome,
    action: item.action,
    reasonCodes: reasonCodesOf(item),
  }));
  const holdFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        blocking: blocking.map((item) => [item.component, item.outcome]),
        refs: snapshot.evidenceRefs.map((ref) => [ref.id, ref.status, String(ref.updatedAt)]),
        policy: snapshot.policy.hash,
      })
    )
    .digest("hex")
    .slice(0, 24);

  const previous = assessment && assessment.hold ? assessment.hold : null;
  const changed = !previous || previous.fingerprint !== holdFingerprint;
  const hold = {
    since: previous && previous.since ? previous.since : now,
    fingerprint: holdFingerprint,
    blocking,
    lastEvaluatedAt: now,
  };
  const write = {
    components: snapshot.components,
    policy: snapshot.policy,
    evidenceRefs: snapshot.evidenceRefs,
    hold,
    reason: evaluation.reason,
    // A hold means "no decision yet". After a resubmission the assessment still carries the
    // previous round's decision, which must not be shown as current. That decision stays on the
    // append-only ClaimAudit trail.
    state: null,
    decidedAt: null,
    approvedGeometry: null,
    approvedAreaAcres: null,
    verifiedAreaAcres: null,
    verification: {
      status: "held",
      version: evaluation.engineVersion,
      startedAt: previous && previous.since ? previous.since : now,
      completedAt: null,
      failedAt: null,
      error: null,
    },
  };

  // D8: an admin may decide a held claim while this run is evaluating it. The hold is therefore only
  // written over "no decision" or a decision from an EARLIER round (made before the latest
  // submission); a decision of this round always has decidedAt >= submittedAt, so it is never
  // overwritten. A claim without submittedAt has no round boundary and keeps the old behaviour.
  const holdFilter = claim.submittedAt
    ? { claimId: claim._id, $or: [{ state: null }, { decidedAt: null }, { decidedAt: { $lt: claim.submittedAt } }] }
    : { claimId: claim._id };
  let written = true;
  if (assessment) {
    written = (await ClaimAssessment.updateOne(holdFilter, { $set: write })).matchedCount > 0;
  } else {
    try {
      await ClaimAssessment.create({
        claimId: claim._id,
        status: "pending",
        version: null,
        model: null,
        evidenceVersion: fingerprint,
        aiImageAssessments: [],
        aiAggregate: null,
        ...write,
      });
    } catch (error) {
      if (error?.code === 11000) written = (await ClaimAssessment.updateOne(holdFilter, { $set: write })).matchedCount > 0;
      else throw error;
    }
  }
  // The decision won (the hold was refused), or it moved the claim while the hold was being written
  // (a decision, or the farmer withdrew it): report what is there now. No hold audit row is written
  // for a claim that is no longer held.
  const current = await LossClaim.findById(claim._id).select("state").lean();
  if (!written || (current && (DECIDED_STATES.has(current.state) || current.state === "withdrawn"))) {
    return decisionAfterRace(claim);
  }

  if (changed) {
    await ClaimAudit.create({
      claimId: claim._id,
      actor: "engine",
      action: "verification_held",
      fromState: "submitted",
      toState: "submitted",
      reason: evaluation.reason,
      metadata: {
        policyId: snapshot.policy.id,
        policyHash: snapshot.policy.hash,
        blocking,
        evidenceRefs: snapshot.evidenceRefs,
        engineVersion: evaluation.engineVersion,
      },
      requestId: requestId || null,
    });
  }

  const fresh = await ClaimAssessment.findOne({ claimId: claim._id });
  return serializeDecision({ claim, assessment: fresh, idempotent: false, inProgress: false, held: true });
};

// Engine-only release of a claim stuck in `processing` back to `submitted` so verification can be
// retried. It is NOT a farmer or admin transition, which is why it is not in the state machine's
// ALLOWED table: it only undoes the engine's own `submitted -> processing` lock, and only while the
// claim is still locked. Audited, so the move is never silent.
export const releaseProcessingSlot = async ({ claimId, reason, requestId = null }) => {
  const released = await LossClaim.findOneAndUpdate(
    { _id: claimId, state: "processing" },
    { $set: { state: "submitted", processedAt: null } },
    { new: true }
  );
  if (!released) return false;
  await ClaimAudit.create({
    claimId,
    actor: "engine",
    action: "verification_released",
    fromState: "processing",
    toState: "submitted",
    reason,
    metadata: { reason: "engine_lock_released" },
    requestId: requestId || null,
  });
  return true;
};

// ADR-022: the claim window is measured at the FIRST submission when the policy says so. Claims
// submitted before `firstSubmittedAt` existed fall back to the earliest `submitted` audit row, then
// to `submittedAt` (which a resubmission overwrites, so it is only the last resort).
const firstSubmittedAtFor = async (claim) => {
  if (claim.firstSubmittedAt) return claim.firstSubmittedAt;
  const audit = await ClaimAudit.findOne({ claimId: claim._id, action: "submitted" }).sort({ createdAt: 1 }).select("createdAt").lean();
  return (audit && audit.createdAt) || claim.submittedAt || null;
};

const claimFactsFor = async ({ claim, policy }) => {
  const facts = claim.toObject();
  if (policySetting(policy, "claimWindowReference") === "firstSubmittedAt") {
    facts.firstSubmittedAt = await firstSubmittedAtFor(claim);
  }
  return facts;
};

// ADR-022 (`reviewCaseOnHold`). Only the AI "no damage" hold opens its own review case: a technical
// hold already gets one from the queue when its job dies, so each cause has exactly one case. The
// case key is deterministic, so re-evaluating a held claim never opens a second one. Returns true
// only when a NEW case was created.
const AI_NO_DAMAGE_REVIEW = "ai_no_damage_needs_review";
const openReviewCaseForHold = async ({ claim, cognitoSub, policy, evaluation, requestId }) => {
  if (!policySetting(policy, "reviewCaseOnHold")) return false;
  const blocking = evaluation && evaluation.gate && Array.isArray(evaluation.gate.blocking) ? evaluation.gate.blocking : [];
  if (!blocking.some((item) => reasonCodesOf(item).includes(AI_NO_DAMAGE_REVIEW))) return false;
  const { createReviewCase, reviewCaseKey } = await import("./manualReview.service.js");
  const reasons = [AI_NO_DAMAGE_REVIEW];
  const key = reviewCaseKey({ claimId: claim._id, source: "AI_IMAGE", reasons });
  if (await VerificationEvidence.exists({ claimId: claim._id, idempotencyKey: key })) return false;
  // Withdrawn (or decided) while this run evaluated it: nobody needs to review it any more.
  if (!(await LossClaim.exists({ _id: claim._id, state: "submitted" }))) return false;
  await createReviewCase({
    claimId: claim._id,
    cognitoSub,
    source: "AI_IMAGE",
    reasons,
    metadata: { component: "manual_review", failedComponent: "photos", reviewReason: AI_NO_DAMAGE_REVIEW },
    requestId: requestId || null,
  });
  return true;
};

// ADR-022 (D2: a technical failure is retried, then reviewed). Under a technical hold, a photo check
// that just failed here is handed to the queue: one ai_assessment job per claim (idempotent) retries
// it after the first backoff delay and, if it keeps failing, dies into a review case. When it
// succeeds, its executor asks the engine to re-evaluate the hold. Without it, a claim whose photos
// changed after its last queued check (the late-evidence plan could not be written, or a farmer's
// verify call came first) would stay held with nothing retrying it and no case for a person.
const queuePhotoCheckRetry = async ({ claim, cognitoSub, requestId }) => {
  if (!env.claimAutomatedVerificationEnabled) return;
  try {
    await enqueue({
      claimId: claim._id,
      cognitoSub,
      step: "ai_assessment",
      runAt: new Date(Date.now() + retryDelayMs({ attempts: 1 })),
      requestId: requestId || null,
      correlationId: correlationIdFor(claim._id, claim.submissionRound || 0),
    });
  } catch (error) {
    // The hold is still recorded; the reconcile sweep and the next verify call are the safety net.
    logger.warn({ claimId: String(claim._id), err: error?.message, code: "PLAN_ENQUEUE_FAILED" }, "verification.photo_check_retry_not_queued");
  }
};

export const verifyClaim = async ({ claimId, cognitoSub, requestId }) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) {
    throw ApiError.badRequest("Valid claim id is required");
  }
  if (!cognitoSub || typeof cognitoSub !== "string") {
    throw ApiError.unauthorized("Authentication required");
  }

  const claim = await LossClaim.findOne({ _id: String(claimId), cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found"); // IDOR-safe: foreign claims → 404

  // Already decided → return the persisted decision (idempotent; no re-run, no extra audit).
  if (DECIDED_STATES.has(claim.state)) {
    return loadDecision(claim);
  }

  if (claim.state === "withdrawn") {
    throw ApiError.conflict("Withdrawn claims are not verified");
  }

  // In-flight: reuse the winner's persisted decision, or report progress (never duplicate).
  if (claim.state === "processing") {
  const assessment = await ClaimAssessment.findOne({ claimId: claim._id });

    if (
      assessment &&
      assessment.state &&
      assessment.verification &&
      assessment.verification.status === "completed"
    ) {
      return serializeDecision({ claim, assessment, idempotent: true, inProgress: false });
    }
    return serializeDecision({ claim, assessment: assessment || null, idempotent: false, inProgress: true });
  }

  if (claim.state !== "submitted") {
    throw ApiError.conflict("Claim must be submitted before verification");
  }

  // ---- evidence / assessment gate (read-only; the claim has not been transitioned yet) ----
  const evidenceDocs = await ClaimEvidence.find({
    claimId: claim._id,
    status: { $in: ALLOWED_EVIDENCE_STATUS },
  })
    .sort({ uploadedAt: 1 })
    .lean();

  const fingerprint = computeEvidenceVersion(evidenceDocs);
  let assessment = await ClaimAssessment.findOne({ claimId: claim._id });

  // ADR-020/022: the policy is resolved once, up front, because it also decides how a failed AI
  // assessment is handled below.
  const policy = resolvePolicy();
  // `technicalFailure: "hold"` (v1.1): a provider failure is never re-run inline and never surfaces
  // as an error or a request for more evidence. The queue owns the retries; the engine holds.
  const technicalHold = policySetting(policy, "technicalFailure") === "hold";

  // Auto-trigger the AI evidence assessment when the caller has stored evidence but no
  // matching completed assessment exists. The assessment service is concurrency-safe (atomic
  // CAS) and idempotent: concurrent /verify requests share the slot, and a re-run with the
  // same evidence fingerprint returns the cached completed assessment. Before this auto-trigger
  // the production flow required the (untested, never deployed) public /assess endpoint, so
  // every /verify against a real claim failed with 500 "assessment missing or stale".
  if (evidenceDocs.length > 0) {
    const needsAssessment =
      !assessment ||
      assessment.status !== "completed" ||
      assessment.evidenceVersion !== fingerprint;
    // Under a technical hold an assessment that already FAILED for this exact evidence set is not
    // re-run here: the engine would only call the provider that has just failed. The queue retries it.
    const failedForThisEvidence =
      technicalHold && assessment && assessment.status === "failed" && assessment.evidenceVersion === fingerprint;
    if (needsAssessment && !failedForThisEvidence) {
      try {
        await claimAssessmentService.assessClaimEvidence({
          claimId: claim._id,
          cognitoSub,
          requestId,
        });
      } catch (error) {
        // Surface assessment failure as a retryable internal error WITHOUT advancing the claim.
        // The claim stays in `submitted` so the farmer can retry once the AI provider recovers.
        await failVerification({
          claimId: claim._id,
          assessment,
          stage: "assessment",
          message:
            error && error.message
              ? `Claim evidence assessment could not be completed (${error.message}); verification is retryable after the assessment completes`
              : "Claim evidence assessment could not be completed; verification is retryable after the assessment completes",
          requestId,
        }).catch(() => {});
        // v1.1: continue to the engine, which holds the claim with the photo check `unavailable`.
        if (!technicalHold) throw error;
        logger.warn({ claimId: String(claim._id), kind: error?.kind || null, code: error?.code || null }, "verification.technical_hold");
        await queuePhotoCheckRetry({ claim, cognitoSub, requestId });
      }
      assessment = await ClaimAssessment.findOne({ claimId: claim._id });
      // Another run is assessing these photos right now, or finished on a different evidence set
      // (the photos changed meanwhile): report progress and decide nothing on someone else's result.
      if (
        technicalHold &&
        assessment &&
        (assessment.status === "processing" ||
          (assessment.status === "completed" && assessment.evidenceVersion !== fingerprint))
      ) {
        return serializeDecision({ claim, assessment, idempotent: false, inProgress: true });
      }
      if (
        !technicalHold &&
        (!assessment ||
          assessment.status !== "completed" ||
          assessment.evidenceVersion !== fingerprint)
      ) {
        const message =
          "Claim evidence assessment is missing or stale; verification is retryable after the assessment completes";
        await failVerification({
          claimId: claim._id,
          assessment,
          stage: "assessment",
          message,
          requestId,
        });
        throw ApiError.internal(message);
      }
    }
  }

  // ---- E9-S9: real overlap-prevention facts (owner-scoped siblings + Turf spatial engine) ----
  const { spatial, eligibleContext } = await buildSpatialFacts({ claim, cognitoSub });

  // ---- ADR-020: per-component evidence status (pure, from the rows already stored) ----
  const claimFacts = await claimFactsFor({ claim, policy });
  const crossOverlap = await findCrossFarmerOverlap({ claim, cognitoSub, thresholds: policy.crossFarmer });
  if (crossOverlap.flagged) {
    // Admin-only trail (farmers never read ClaimAudit); written once per distinct set of matches.
    const already = await ClaimAudit.exists({
      claimId: claim._id,
      action: "cross_farmer_overlap_flagged",
      "metadata.matchKey": crossOverlap.matchKey,
    });
    if (!already) {
      await ClaimAudit.create({
        claimId: claim._id,
        actor: "engine",
        action: "cross_farmer_overlap_flagged",
        fromState: claim.state,
        toState: claim.state,
        reason: "Claimed area overlaps another farmer's claim; flagged for review, not a duplicate verdict",
        metadata: {
          matchKey: crossOverlap.matchKey,
          matchCount: crossOverlap.matchCount,
          maxOverlapAcres: crossOverlap.maxOverlapAcres,
          maxShare: crossOverlap.maxShare,
          matches: crossOverlap.matches,
        },
        requestId: requestId || null,
      });
    }
  }
  // ---- pure deterministic evaluation (no DB/network/LLM) over the evidence rows stored now ----
  const now = new Date();
  const evaluateStoredEvidence = async () => {
    const evidenceRows = await VerificationEvidence.find({ claimId: claim._id }).lean();
    const components = resolveComponents({
      claim: claimFacts,
      assessment: assessment ? assessment.toObject() : null,
      spatial,
      crossOverlap,
      evidenceRows,
      evidenceCount: evidenceDocs.length,
      policy,
    });
    const snapshot = buildDecisionSnapshot({ components, policy });
    const evaluation = evaluateClaimVerification({
      claim: claimFacts,
      assessment: assessment ? assessment.toObject() : null,
      overlap: { status: spatial.overlapStatus, overlapAreaAcres: spatial.overlapAreaAcres },
      spatial,
      eligibleContext,
      weatherCorrelation: null,
      evidenceCount: evidenceDocs.length,
      now,
      components,
      policy,
    });
    return { snapshot, evaluation };
  };
  let { snapshot, evaluation } = await evaluateStoredEvidence();

  // ADR-022: a hold that needs a reviewer opens its review case BEFORE the hold is recorded, and the
  // claim is evaluated once more so the recorded hold already includes the case. Otherwise the next
  // evaluation would see a "new" evidence row and write a second, identical hold audit row.
  if (evaluation.disposition === "hold") {
    // A failure to open the case must not lose the hold; the next evaluation retries it.
    const opened = await openReviewCaseForHold({ claim, cognitoSub, policy, evaluation, requestId }).catch((error) => {
      logger.warn({ claimId: String(claim._id), err: error?.message }, "verification.review_case_failed");
      return false;
    });
    if (opened) ({ snapshot, evaluation } = await evaluateStoredEvidence());
  }

  // A required component is unresolved: record why and leave the claim in `submitted`.
  if (evaluation.disposition === "hold") {
    return persistHold({ claim, assessment, evaluation, snapshot, fingerprint, now, requestId });
  }

  // ---- concurrency guard: exactly one worker runs the decision (atomic submitted → processing) ----
  applyTransition({ claim, toState: "processing" }); // validate via the frozen machine
  const slot = await LossClaim.findOneAndUpdate(
    { _id: claim._id, state: "submitted" },
    { $set: { state: "processing", processedAt: now } },
    { new: true }
  );
  if (!slot) {
    const raced = await LossClaim.findById(claim._id);
    if (raced && DECIDED_STATES.has(raced.state)) {
      return loadDecision(raced);
    }
    const racedAssessment = await ClaimAssessment.findOne({ claimId: claim._id });
    if (
      raced &&
      racedAssessment &&
      racedAssessment.state &&
      racedAssessment.verification &&
      racedAssessment.verification.status === "completed"
    ) {
      return serializeDecision({
        claim: raced,
        assessment: racedAssessment,
        idempotent: true,
        inProgress: false,
      });
    }
    return serializeDecision({
      claim: raced || claim,
      assessment: racedAssessment || null,
      idempotent: false,
      inProgress: true,
    });
  }

  try {
    await ClaimAudit.create({
      claimId: claim._id,
      actor: "engine",
      action: "verification_started",
      fromState: "submitted",
      toState: "processing",
      reason: null,
      metadata: {
        evidenceVersion: fingerprint,
        imageCount: evidenceDocs.length,
        overlapEvaluated: evaluation.spatialEvaluated,
        overlapStatus: spatial.overlapStatus,
        overlapAreaAcres: spatial.overlapAreaAcres,
        insideParcel: spatial.insideParcel,
        remainingEligible: evaluation.remainingEligible,
        previouslyVerifiedAcres: evaluation.previouslyVerifiedAcres,
        inFlightAreaAcres: evaluation.inFlightAreaAcres,
        engineVersion: evaluation.engineVersion,
      },
      requestId: requestId || null,
    });

    if (assessment) {
      await ClaimAssessment.updateOne(
        { claimId: claim._id },
        {
          $set: {
            verification: {
              status: "verifying",
              version: evaluation.engineVersion,
              startedAt: now,
              completedAt: null,
              failedAt: null,
              error: null,
            },
          },
        }
      );
    }

    const decisionWrite = {
      state: evaluation.outcome,
      reason: evaluation.reason,
      decidedAt: now,
      decidedBy: "engine",
      approvedGeometry: evaluation.approvedGeometry,
      approvedAreaAcres: evaluation.approvedAreaAcres,
      verifiedAreaAcres: evaluation.verifiedAreaAcres,
      remainingEligible: evaluation.remainingEligible,
      previouslyVerifiedAcres: evaluation.previouslyVerifiedAcres,
      inFlightAreaAcres: evaluation.inFlightAreaAcres,
      overlapWarnings: evaluation.overlapWarnings,
      spatialEvaluated: evaluation.spatialEvaluated,
      rules: evaluation.rules,
      weatherCorrelation: null,
      components: snapshot.components,
      policy: snapshot.policy,
      evidenceRefs: snapshot.evidenceRefs,
      hold: null,
      verification: {
        status: "completed",
        version: evaluation.engineVersion,
        startedAt: now,
        completedAt: now,
        failedAt: null,
        error: null,
      },
    };

    if (assessment) {
      await ClaimAssessment.updateOne({ claimId: claim._id }, { $set: decisionWrite });
    } else {
      // No assessment row (no stored evidence): the decision still gets its own claimassessment
      // row so claim detail can surface the deterministic reason (unique claimId, 1:1).
      try {
        await ClaimAssessment.create({
          claimId: claim._id,
          status: "pending",
          version: null,
          model: null,
          evidenceVersion: fingerprint,
          aiImageAssessments: [],
          aiAggregate: null,
          ...decisionWrite,
        });
      } catch (error) {
        if (error?.code === 11000) {
          await ClaimAssessment.updateOne({ claimId: claim._id }, { $set: decisionWrite });
        } else {
          throw error;
        }
      }
    }

    // Atomically persist the decision transition (validated by the frozen machine).
    applyTransition({ claim: slot, toState: evaluation.outcome });
    const finished = await LossClaim.findOneAndUpdate(
      { _id: claim._id, state: "processing" },
      { $set: { state: evaluation.outcome, processedAt: now, decidedAt: now } },
      { new: true }
    );
    if (!finished) {
      throw ApiError.internal("Internal: verification slot was lost while persisting the decision");
    }

    await ClaimAudit.create({
      claimId: claim._id,
      actor: "engine",
      action: evaluation.outcome,
      fromState: "processing",
      toState: evaluation.outcome,
      reason: evaluation.reason,
      metadata: {
        policyId: snapshot.policy.id,
        policyHash: snapshot.policy.hash,
        componentOutcomes: Object.fromEntries(Object.entries(snapshot.components).map(([name, value]) => [name, value.outcome])),
        evidenceRefs: snapshot.evidenceRefs,
        evidenceVersion: fingerprint,
        imageCount: evidenceDocs.length,
        overlapEvaluated: evaluation.spatialEvaluated,
        overlapStatus: spatial.overlapStatus,
        overlapAreaAcres: spatial.overlapAreaAcres,
        insideParcel: spatial.insideParcel,
        remainingEligible: evaluation.remainingEligible,
        previouslyVerifiedAcres: evaluation.previouslyVerifiedAcres,
        inFlightAreaAcres: evaluation.inFlightAreaAcres,
        engineVersion: evaluation.engineVersion,
      },
      requestId: requestId || null,
    });

    const finalAssessment = await ClaimAssessment.findOne({ claimId: claim._id });
    return serializeDecision({
      claim: finished,
      assessment: finalAssessment,
      idempotent: false,
      inProgress: false,
    });
  } catch (error) {
    // Best-effort rollback (no farmer-visible state machine route covers engine rollback): if the
    // claim is still in `processing`, return it to `submitted` so a retry is possible; the failure
    // is persisted on the assessment + audited. Never fabricate a decision from a failed run.
    if (assessment) {
      await ClaimAssessment.updateOne(
        { claimId: claim._id },
        {
          $set: {
            verification: {
              status: "failed",
              version: VERIFICATION_ENGINE_VERSION,
              startedAt: now,
              failedAt: new Date(),
              error: { stage: "processing", message: error && error.message ? error.message : "Claim verification failed" },
            },
          },
        }
      ).catch(() => {});
    }
    await releaseProcessingSlot({ claimId: claim._id, reason: "Verification failed; the claim was returned for a retry", requestId }).catch(() => {});
    await ClaimAudit.create({
      claimId: claim._id,
      actor: "engine",
      action: "verification_failed",
      fromState: null,
      toState: null,
      reason: error && error.message ? error.message : "Claim verification failed",
      metadata: { stage: "processing" },
      requestId: requestId || null,
    }).catch(() => {});
    throw error;
  }
};

// ADR-022 (plan A6) — POST /claims/:id/verify. The queue owns the checks; this endpoint (kept for
// reviewers and older clients) must not decide a claim on partial evidence while one of its blocking
// steps is still queued or running. It then reports "in progress" and decides nothing; the engine job
// decides once those steps finish. Decided, withdrawn and `processing` claims, and every claim while
// automated verification is off, go through verifyClaim unchanged.
export const verifyClaimWhenReady = async ({ claimId, cognitoSub, requestId }) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) {
    throw ApiError.badRequest("Valid claim id is required");
  }
  if (!cognitoSub || typeof cognitoSub !== "string") {
    throw ApiError.unauthorized("Authentication required");
  }
  if (env.claimAutomatedVerificationEnabled) {
    const claim = await LossClaim.findOne({ _id: String(claimId), cognitoSub });
    if (!claim) throw ApiError.notFound("Claim not found");
    if (claim.state === "submitted" && (await countBlockingActiveJobs(claim._id, resolvePolicy())) > 0) {
      const assessment = await ClaimAssessment.findOne({ claimId: claim._id });
      return serializeDecision({ claim, assessment, idempotent: false, inProgress: true });
    }
  }
  return verifyClaim({ claimId, cognitoSub, requestId });
};

export default { verifyClaim, verifyClaimWhenReady, serializeDecision, releaseProcessingSlot };