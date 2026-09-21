import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as claimService from "../services/claim.service.js";
import * as claimEvidenceService from "../services/claimEvidence.service.js";

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
  const claim = await claimService.resubmitForUser({
    cognitoSub: req.user.id,
    claimId: req.params.claimId,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Claim resubmitted", { claim });
});

const presignEvidence = asyncHandler(async (req, res) => {
  const result = await claimEvidenceService.presignEvidence({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    filename: req.body.filename,
    contentType: req.body.contentType,
    size: req.body.size,
  });
  return ApiResponse.success(res, "Evidence presign generated", result);
});

const completeEvidence = asyncHandler(async (req, res) => {
  const evidence = await claimEvidenceService.completeEvidence({
    claimId: req.params.claimId,
    uploadId: req.params.evidenceId,
    cognitoSub: req.user.id,
  });
  return ApiResponse.success(res, "Evidence stored", { evidence });
});

const deleteEvidence = asyncHandler(async (req, res) => {
  const result = await claimEvidenceService.deleteEvidence({
    claimId: req.params.claimId,
    uploadId: req.params.evidenceId,
    cognitoSub: req.user.id,
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

export {
  createClaim,
  listClaims,
  getClaim,
  submitClaim,
  withdrawClaim,
  resubmitClaim,
  presignEvidence,
  completeEvidence,
  deleteEvidence,
  getEvidenceUrl,
};