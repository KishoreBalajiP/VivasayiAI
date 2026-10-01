import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
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

export const serializeDecision = ({ claim, assessment, idempotent, inProgress }) => ({
  claimId: String(claim._id),
  idempotent,
  inProgress,
  claimState: claim.state,
  outcome: assessment && assessment.state ? assessment.state : null,
  decision: assessment && assessment.state ? assessment.state : null,
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
  let assessment = await ClaimAssessment.findOne({ claimId: claim._id });

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
    if (needsAssessment) {
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
        throw error;
      }
      assessment = await ClaimAssessment.findOne({ claimId: claim._id });
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
  }

  // ---- E9-S9: real overlap-prevention facts (owner-scoped siblings + Turf spatial engine) ----
  const { spatial, eligibleContext } = await buildSpatialFacts({ claim, cognitoSub });

  // ---- pure deterministic evaluation (no DB/network/LLM) ----
  const now = new Date();
  const evaluation = evaluateClaimVerification({
    claim: claim.toObject(),
    assessment: assessment ? assessment.toObject() : null,
    overlap: { status: spatial.overlapStatus, overlapAreaAcres: spatial.overlapAreaAcres },
    spatial,
    eligibleContext,
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