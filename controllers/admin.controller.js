import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as adminService from "../services/admin.service.js";
import * as diagnosticsService from "../services/verificationDiagnostics.service.js";

// Phase 10 (E9-S10) — Admin endpoints (08_API_Documentation §10.10–10.12).
//
// Mounted as /admin behind requireAuth + requireRole("admin") + adminLimiter (app.js + routes).
// The actor identity (req.user.id = cognitoSub, req.user.email) ALWAYS comes from the verified
// session token — never from the request body. The queue/dashboard/investigation views are
// READ-ONLY; `overrideClaim` is the single mutable admin operation and records an immutable
// AdminAction + ClaimAudit on every apply (never silent, with replay protection).

const listQueue = asyncHandler(async (req, res) => {
  const result = await adminService.listReviewQueue({
    actorSub: req.user.id,
    rawFilters: req.query ?? {},
  });
  return ApiResponse.success(res, "Review queue fetched", result);
});

const getDetail = asyncHandler(async (req, res) => {
  const detail = await adminService.getAdminClaimDetail({
    claimId: req.params.claimId,
    actorSub: req.user.id,
  });
  return ApiResponse.success(res, "Claim detail fetched", detail);
});

const overrideClaim = asyncHandler(async (req, res) => {
  const result = await adminService.overrideClaim({
    claimId: req.params.claimId,
    actorSub: req.user.id,
    actorEmail: req.user.email ?? null,
    toState: req.body.toState,
    reason: req.body.reason,
    adminNote: req.body.adminNote,
    approverSub: req.body.approverSub,
    overrideKey: req.body.overrideKey,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(
    res,
    result.idempotent ? "Override already applied" : "Claim overridden",
    result
  );
});

const dashboard = asyncHandler(async (req, res) => {
  const result = await adminService.getDashboard({
    rangeDays: req.query.rangeDays,
  });
  return ApiResponse.success(res, "Dashboard metrics computed", result);
});

const investigation = asyncHandler(async (req, res) => {
  const result = await adminService.getInvestigation({
    rangeDays: req.query.rangeDays,
  });
  return ApiResponse.success(res, "Investigation view computed", result);
});

// ADR-022 (D9) — read-only verification diagnostics: jobs, attempts, error codes, review cases,
// satellite internals and the audit trail, beside the farmer's own progress object.
const verificationDiagnostics = asyncHandler(async (req, res) => {
  const diagnostics = await diagnosticsService.getVerificationDiagnostics({ claimId: req.params.claimId });
  return ApiResponse.success(res, "Verification diagnostics fetched", diagnostics);
});

// ADR-022 (D9) — re-queue the claim's dead jobs (recorded as AdminAction `jobs_requeued` + ClaimAudit).
const requeueJobs = asyncHandler(async (req, res) => {
  const result = await diagnosticsService.requeueClaimJobs({
    claimId: req.params.claimId,
    steps: req.body.steps ?? null,
    reason: req.body.reason,
    actorSub: req.user.id,
    actorEmail: req.user.email ?? null,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(res, result.idempotent ? "No dead jobs to re-queue" : "Verification jobs re-queued", result);
});

export { listQueue, getDetail, overrideClaim, dashboard, investigation, verificationDiagnostics, requeueJobs };