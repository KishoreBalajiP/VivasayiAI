import express from "express";
import validate from "../middlewares/validate.js";
import { adminLimiter } from "../middlewares/rateLimit.js";
import {
  claimParams,
  overrideBody,
  adminQueueQuery,
  adminDashboardQuery,
  ownershipEvidenceParams,
  ownershipReviewBody,
  reviewCaseParams,
  reviewCaseDecisionBody,
  requeueJobsBody,
} from "../utils/validation.schemas.js";
import {
  listQueue,
  getDetail,
  overrideClaim,
  dashboard,
  investigation,
  verificationDiagnostics,
  requeueJobs,
} from "../controllers/admin.controller.js";
import {
  adminListOwnershipEvidence,
  adminReviewOwnershipEvidence,
  adminListReviewCases,
  adminDecideReviewCase,
} from "../controllers/ownership.controller.js";

// Phase 10 (E9-S10) — Admin exception-workflow endpoints (08_API_Documentation §10.10–10.12).
// Mounted in app.js AFTER requireAuth + requireRole("admin") (see app.js), so everything here is
// admin-only and every handler reads the actor identity from the verified token. The per-admin
// rate limiter (adminLimiter, keyed by req.user.id) applies to all admin routes.

const router = express.Router();

// Read-only review queue: engine decision states needing an exception review + AI-failure cases.
router.use(adminLimiter);
router.get("/claims", validate(adminQueueQuery, "query"), listQueue);

// Full admin claim detail (assessment, appeal, immutable audit, signed evidence URLs, parcel).
router.get("/claims/:claimId", validate(claimParams, "params"), getDetail);

// Admin override — the ONLY mutable admin operation (immutably audited).
router.post("/claims/:claimId/override", validate(claimParams, "params"), validate(overrideBody), overrideClaim);

// Phase 12 (E12) — Land ownership evidence review (08_API_Documentation §10.13, admin-only).
// Read-only list (any claim, with short-lived document URLs) + the single manual-review mutation
// (race-safe, replay-safe, immutably recorded as AdminAction + ClaimAudit). Never changes the
// claim state or its decision.
router.get("/claims/:claimId/ownership", validate(claimParams, "params"), adminListOwnershipEvidence);
router.post(
  "/claims/:claimId/ownership/:evidenceId/review",
  validate(ownershipEvidenceParams, "params"),
  validate(ownershipReviewBody),
  adminReviewOwnershipEvidence
);

// ADR-020 — automated manual-review cases (opened when an automated check cannot complete or a
// signal needs a person). Resolving one is a review outcome, never an authoritative verification.
router.get("/claims/:claimId/review-cases", validate(claimParams, "params"), adminListReviewCases);
router.post(
  "/claims/:claimId/review-cases/:evidenceId/decision",
  validate(reviewCaseParams, "params"),
  validate(reviewCaseDecisionBody),
  adminDecideReviewCase
);

// ADR-022 (D9) — automated verification, reviewer side: read-only diagnostics (jobs, attempts,
// error codes, review cases, satellite internals, audit trail and the farmer's progress side by
// side) and the single recovery action, re-queueing dead jobs (immutably recorded).
router.get("/claims/:claimId/verification-diagnostics", validate(claimParams, "params"), verificationDiagnostics);
router.post("/claims/:claimId/jobs/requeue", validate(claimParams, "params"), validate(requeueJobsBody), requeueJobs);

// Operations dashboard (pure server-side metrics; no third-party analytics).
router.get("/dashboard", validate(adminDashboardQuery, "query"), dashboard);

// Fraud investigation (observation-only).
router.get("/investigation", validate(adminDashboardQuery, "query"), investigation);

export default router;