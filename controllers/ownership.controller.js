import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as ownershipService from "../services/ownershipEvidence.service.js";
import * as manualReviewService from "../services/manualReview.service.js";

// Phase 12 (E12) — Land Ownership evidence endpoints (08_API_Documentation §10.13).
//
// Farmer routes are mounted under /claims (after requireAuth) and are owner-scoped by the verified
// token (req.user.id = cognitoSub); foreign/unowned resources resolve to 404. Admin routes are
// mounted under /admin behind requireAuth + requireRole("admin") and read actor identity from the
// verified token, never the body. Attaching a document is NOT verification; only an admin manual
// review resolves it, and ownership evidence never changes the claim state or the decision.

const submitOwnershipEvidence = asyncHandler(async (req, res) => {
  const { evidence, idempotent } = await ownershipService.submitOwnershipEvidence({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
    uploadId: req.body.uploadId,
    documentCategory: req.body.documentCategory,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(
    res,
    idempotent ? "Ownership document already attached" : "Ownership document attached",
    { evidence }
  );
});

const listOwnershipEvidence = asyncHandler(async (req, res) => {
  const result = await ownershipService.listOwnershipEvidenceForClaim({
    claimId: req.params.claimId,
    cognitoSub: req.user.id,
  });
  return ApiResponse.success(res, "Ownership evidence fetched", result);
});

const getOwnershipDocumentUrl = asyncHandler(async (req, res) => {
  const result = await ownershipService.getOwnershipEvidenceDocumentUrl({
    claimId: req.params.claimId,
    evidenceId: req.params.evidenceId,
    cognitoSub: req.user.id,
  });
  return ApiResponse.success(res, "Ownership document url generated", result);
});

// --- Admin (behind requireRole("admin")) ---

const adminListOwnershipEvidence = asyncHandler(async (req, res) => {
  const result = await ownershipService.listOwnershipEvidenceForAdmin({
    claimId: req.params.claimId,
  });
  return ApiResponse.success(res, "Ownership evidence fetched", result);
});

const adminReviewOwnershipEvidence = asyncHandler(async (req, res) => {
  const { evidence, idempotent } = await ownershipService.reviewOwnershipEvidence({
    claimId: req.params.claimId,
    evidenceId: req.params.evidenceId,
    actorSub: req.user.id,
    actorRole: req.user.role ?? null,
    actorEmail: req.user.email ?? null,
    status: req.body.status,
    method: req.body.method,
    reason: req.body.reason,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(
    res,
    idempotent ? "Ownership review already recorded" : "Ownership evidence reviewed",
    { evidence }
  );
});

// ADR-020 — automated review cases (opened by the verification pipeline) are listed and resolved
// here. Admin-only: the route sits behind requireRole("admin"), and the role is also checked in the
// service. A decision is a review outcome (never VERIFIED), recorded as an AdminAction + audit row.
const adminListReviewCases = asyncHandler(async (req, res) => {
  const rows = await manualReviewService.listReviewCases({
    claimId: req.params.claimId,
    reviewerRole: req.user.role ?? null,
  });
  const cases = rows.map((row) => ({
    id: String(row._id),
    claimId: String(row.claimId),
    status: row.status,
    reasons: row.result?.reviewReasons ?? [],
    component: row.metadata?.component ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.result?.resolvedAt ?? null,
    history: (row.result?.reviewHistory ?? []).map((entry) => ({
      decision: entry.decision,
      decidedAt: entry.decidedAt,
    })),
  }));
  return ApiResponse.success(res, "Review cases fetched", { cases });
});

const adminDecideReviewCase = asyncHandler(async (req, res) => {
  const updated = await manualReviewService.recordReviewDecision({
    claimId: req.params.claimId,
    evidenceId: req.params.evidenceId,
    actorSub: req.user.id,
    actorRole: req.user.role ?? null,
    actorEmail: req.user.email ?? null,
    decision: req.body.decision,
    reason: req.body.reason,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, "Review case resolved", {
    case: { id: String(updated._id), claimId: String(updated.claimId), status: updated.status },
  });
});

export {
  submitOwnershipEvidence,
  listOwnershipEvidence,
  getOwnershipDocumentUrl,
  adminListOwnershipEvidence,
  adminReviewOwnershipEvidence,
  adminListReviewCases,
  adminDecideReviewCase,
};
