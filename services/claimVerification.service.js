import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { applyTransition } from "./claimState.service.js";
import { computeEvidenceVersion } from "./claimAssessment.service.js";
import {
  evaluateClaimVerification,
  VERIFICATION_ENGINE_VERSION,
} from "./claimVerificationEngine.service.js";

// E9-S5 (ADR-019) — Claim Verification orchestration (internal service, NO public endpoint; §18).
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
// Phase 5 scope (documented deferrals, never pretended):
//   - Overlap (E9-S3) is NOT evaluated: the engine input is always `{ status: "unchecked",
//     overlapAreaAcres: 0 }`; audit metadata records `overlapEvaluated: false`.
//   - `partially_verified` has no frozen trigger → the orchestration NEVER emits it.
//   - No weather integration: `weatherCorrelation` stays null; the weather rule is supporting-only
//     (P3) and cannot reject.
//   - Returns the serialized decision (same additive shape already exposed via claim detail).

const DECIDED_STATES = new Set([
  "verified",
  "partially_verified",
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "more_evidence_required",
]);

const ALLOWED_EVIDENCE_STATUS = ["stored"];

export const serializeDecision = ({ claim, assessment, idempotent, inProgress }) => ({
  claimId: String(claim._id),
  idempotent,
  inProgress,
  claimState: claim.state,
  outcome: assessment && assessment.state ? assessment.state : null,
  reason: assessment ? assessment.reason : null,
  rules: assessment ? assessment.rules : null,
  approvedGeometry: assessment ? assessment.approvedGeometry : null,
  approvedAreaAcres: assessment ? assessment.approvedAreaAcres : null,
  weatherCorrelation: assessment ? assessment.weatherCorrelation || null : null,
  decidedAt: assessment ? assessment.decidedAt : null,
  decidedBy: assessment ? assessment.decidedBy : null,
  claimedAreaAcres: claim.claimedAreaAcres,
  parcelAreaAcres: claim.parcelSnapshot ? claim.parcelSnapshot.parcelAreaAcres : null,
  evidenceVersion: assessment ? assessment.evidenceVersion : null,
  engineVersion: assessment && assessment.verification ? assessment.verification.version : null,
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
  const assessment = await ClaimAssessment.findOne({ claimId: claim._id });

  if (evidenceDocs.length > 0) {
    if (
      !assessment ||
      assessment.status !== "completed" ||
      assessment.evidenceVersion !== fingerprint
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

  // ---- pure deterministic evaluation (no DB/network/LLM) ----
  const now = new Date();
  const evaluation = evaluateClaimVerification({
    claim: claim.toObject(),
    assessment: assessment ? assessment.toObject() : null,
    overlap: { status: "unchecked", overlapAreaAcres: 0 },
    weatherCorrelation: null,
    evidenceCount: evidenceDocs.length,
    now,
  });

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
        overlapEvaluated: false,
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
      rules: evaluation.rules,
      weatherCorrelation: null,
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
        evidenceVersion: fingerprint,
        imageCount: evidenceDocs.length,
        overlapEvaluated: false,
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
    await LossClaim.updateOne(
      { _id: claim._id, state: "processing" },
      { $set: { state: "submitted", processedAt: null } }
    ).catch(() => {});
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

export default { verifyClaim, serializeDecision };