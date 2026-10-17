import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as claimService from "../services/claim.service.js";
import * as claimEvidenceService from "../services/claimEvidence.service.js";
import claimVerificationService from "../services/claimVerification.service.js";
import * as verificationEvidenceService from "../services/verificationEvidence.service.js";
import * as landDocumentExaminationService from "../services/landDocumentExamination.service.js";
import * as officialLandRecordService from "../services/officialLandRecord.service.js";
import * as satelliteVerificationService from "../services/satelliteVerification.service.js";
import { drain, ensurePlan } from "../services/verificationJobs.service.js";
import * as claimProgressService from "../services/claimProgress.service.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";

// F-49 (ADR-019) — claim lifecycle + claim-scoped evidence (08_API_Documentation §10).
// Identity always derives from the verified token (req.user.id = cognitoSub), never from the
// body; foreign/unowned resources resolve to 404, and farmer transitions go through the
// centralized state machine in services.

const createClaim = asyncHandler(async (req, res) => {
  const { claim, idempotent } = await claimService.createForUser({
    cognitoSub: req.user.id,
    ...req.body,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, idempotent ? "Claim already exists" : "Claim created", { claim });
});

const listClaims = asyncHandler(async (req, res) => {
  const claims = await claimService.listForUser(req.user.id);
  return ApiResponse.success(res, "Claims fetched", { claims });
});

const getClaim = asyncHandler(async (req, res) => {
  const claim = await claimService.getForUser(req.user.id, req.params.claimId);
  if (!claim) throw ApiError.notFound("Claim not found");
  return ApiResponse.success(res, "Claim fetched", { claim });
});

const submitClaim = asyncHandler(async (req, res) => {
  const { claim, idempotent } = await claimService.submitForUser({
    cognitoSub: req.user.id,
    claimId: req.params.claimId,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, idempotent ? "Claim already submitted" : "Claim submitted", { claim });
});

const withdrawClaim = asyncHandler(async (req, res) => {
  const claim = await claimService.withdrawForUser({
    cognitoSub: req.user.id,
    claimId: req.params.claimId,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Claim withdrawn", { claim });
});

const resubmitClaim = asyncHandler(async (req, res) => {
  const { claim, idempotent } = await claimService.resubmitForUser({
    cognitoSub: req.user.id,
    claimId: req.params.claimId,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, idempotent ? "Claim already resubmitted" : "Claim resubmitted", { claim });
});

// A drain that fails inside a request must not fail the request (the queue retries the work), but
// it is never silent either.
const logDrainFailure = (req, where) => (error) =>
  logger.warn({ claimId: req.params.claimId, requestId: req.requestId ?? null, where, err: error?.message }, "verification.drain_failed");

// A status read also advances ONE queued step (ADR-021), so polling makes progress even when no
// scheduled worker is attached. Ownership is checked FIRST: a read of someone else's claim is a 404
// and runs nothing (no provider call, no attempt used on the owner's jobs).
const drainOneStepOnRead = async (req, where) => {
  if (!(env.claimAutomatedVerificationEnabled && env.claimVerificationDrainOnRead)) return;
  const owned = await claimService.findOwned(req.user.id, req.params.claimId);
  if (!owned) throw ApiError.notFound("Claim not found");
  await drain({ claimId: owned._id, maxJobs: 1, deadline: Date.now() + env.claimVerificationReadDrainBudgetMs, requestId: req.requestId ?? null }).catch(
    logDrainFailure(req, where)
  );
};

// E9-S5/E9-S6 (ADR-019, Phase 6 integration) — POST /claims/:claimId/verify.
// Thin endpoint over the Phase 5 internal `verifyClaim` orchestration. The CLIENT only requests
// verification; the server loads the authoritative claim/evidence/assessment, runs the pure
// deterministic engine, persists the decision, and advances the state via the frozen machine.
// Only { claimId, cognitoSub, requestId } are read — ANY client-supplied result/state/area/AI
// payload is structurally ignored (P5-20 preserve). Idempotent + concurrency-safe (CAS).
//
// ADR-022: ownership is checked BEFORE anything runs, so another user's call is a 404 that drains
// nothing. A submitted claim's plan is ensured (recovering a plan an earlier request could not
// write), its due steps run within the request budget, and the claim is decided only when none of
// its blocking steps is still queued or running (verifyClaimWhenReady); otherwise the response says
// "in progress". The farmer UI no longer calls this endpoint; the queue decides on its own.
const verifyClaim = asyncHandler(async (req, res) => {
  const owned = await claimService.findOwned(req.user.id, req.params.claimId);
  if (!owned) throw ApiError.notFound("Claim not found");
  // ADR-021: run this claim's queued steps first (bounded by the request budget), so the decision
  // below sees the evidence they produce. Nothing is queued when automated verification is off.
  if (env.claimAutomatedVerificationEnabled) {
    if (owned.state === "submitted") {
      await ensurePlan({ claimId: owned._id, cognitoSub: req.user.id, requestId: req.requestId ?? null, trigger: "verify" }).catch((error) =>
        logger.warn({ claimId: String(owned._id), requestId: req.requestId ?? null, err: error?.message, code: "PLAN_ENQUEUE_FAILED" }, "verification.plan_failed")
      );
    }
    await drain({
      claimId: owned._id,
      deadline: Date.now() + env.claimVerificationRequestBudgetMs,
      requestId: req.requestId ?? null,
    }).catch(logDrainFailure(req, "verify"));
  }
  const verification = await claimVerificationService.verifyClaimWhenReady({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    requestId: req.requestId ?? null,
  });
  // Farmer audience (ADR-022): the policy id stays, its hash is an internal detail (reviewers read it in
  // the verification diagnostics).
  const farmerVerification = { ...verification, policyHash: null };
  const message = verification.inProgress
    ? "Claim verification in progress"
    : verification.idempotent
      ? "Verification decision already exists"
      : verification.claimState === "verified"
        ? "Claim verified"
        : "Claim verification completed";
  return ApiResponse.success(res, message, { verification: farmerVerification });
});

const presignEvidence = asyncHandler(async (req, res) => {
  const result = await claimEvidenceService.presignEvidence({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    filename: req.body.filename,
    contentType: req.body.contentType,
    size: req.body.size,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Evidence presign generated", result);
});

const completeEvidence = asyncHandler(async (req, res) => {
  const evidence = await claimEvidenceService.completeEvidence({
    claimId: req.params.claimId,
    uploadId: req.params.evidenceId,
    cognitoSub: req.user.id,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Evidence stored", { evidence });
});

const deleteEvidence = asyncHandler(async (req, res) => {
  const result = await claimEvidenceService.deleteEvidence({
    claimId: req.params.claimId,
    uploadId: req.params.evidenceId,
    cognitoSub: req.user.id,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Evidence deleted", result);
});

const getEvidenceUrl = asyncHandler(async (req, res) => {
  const result = await claimEvidenceService.getEvidenceUrl({
    claimId: req.params.claimId,
    uploadId: req.params.evidenceId,
    cognitoSub: req.user.id,
  });
  return ApiResponse.success(res, "Evidence url generated", result);
});

// Phase 15 — farmer-facing verification summary (owner-scoped). ADR-022: the evidence rows are the
// FARMER projection (no review cases, results or internal fields), and the progress-v1 object is
// included for clients that read this endpoint instead of /progress.
const getClaimVerification = asyncHandler(async (req, res) => {
  await drainOneStepOnRead(req, "verification_read");
  const view = await verificationEvidenceService.getVerificationEvidenceView({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    audience: "farmer",
  });
  const claim = await claimService.getForUser(req.user.id, req.params.claimId);
  const progress = await claimProgressService.getClaimProgressForUser({ claimId: req.params.claimId, cognitoSub: req.user.id });
  return ApiResponse.success(res, "Verification summary fetched", {
    verification: view,
    claim,
    progress,
  });
});

// ADR-022 (plan A6) — GET /claims/:claimId/progress: the farmer progress contract (progress-v1),
// built from persisted state only. Owner-scoped (404 for anyone else, before any queued step runs).
const getClaimProgress = asyncHandler(async (req, res) => {
  await drainOneStepOnRead(req, "progress_read");
  const progress = await claimProgressService.getClaimProgressForUser({ claimId: req.params.claimId, cognitoSub: req.user.id });
  return ApiResponse.success(res, "Claim progress fetched", { progress });
});

const examineClaimLandDocuments = asyncHandler(async (req, res) => {
  const result = await landDocumentExaminationService.examineOwnershipDocumentsForClaim({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Land documents examined", result);
});

const runClaimSatelliteVerification = asyncHandler(async (req, res) => {
  const claim = await claimService.getForUser(req.user.id, req.params.claimId);
  if (!claim) throw ApiError.notFound("Claim not found");
  // Windows, area of interest and persistence are decided by the service, so this endpoint and the
  // queued step always analyse the same land the same way.
  const result = await satelliteVerificationService.runSatelliteVerificationForClaim({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    claim,
  });
  // Only the evidence summary is returned: not the scenes, request shape or provider diagnostics.
  const summary = result.recorded
    ? {
        recorded: true,
        evidence: result.persisted.evidence,
        idempotent: result.persisted.idempotent,
        outcome: result.run.outcome,
        analysisOutcome: (result.run.analysis && result.run.analysis.analysisOutcome) || null,
      }
    : { recorded: false, skipped: result.skipped, retryAfter: result.rescheduleAt };
  return ApiResponse.success(res, "Satellite verification processed", summary);
});

const verifyClaimOfficialLandRecords = asyncHandler(async (req, res) => {
  const result = await officialLandRecordService.verifyOfficialLandRecordForClaim({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    // Deliberately no request-body input: the provider is queried with the stored AI extraction.
  });
  return ApiResponse.success(res, "Official land record verification processed", result);
});

export {
  createClaim,
  listClaims,
  getClaim,
  submitClaim,
  withdrawClaim,
  resubmitClaim,
  verifyClaim,
  presignEvidence,
  completeEvidence,
  deleteEvidence,
  getEvidenceUrl,
  getClaimVerification,
  getClaimProgress,
  examineClaimLandDocuments,
  runClaimSatelliteVerification,
  verifyClaimOfficialLandRecords,
};