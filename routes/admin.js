import express from "express";
import validate from "../middlewares/validate.js";
import { adminLimiter } from "../middlewares/rateLimit.js";
import {
  claimParams,
  overrideBody,
  adminQueueQuery,
  adminDashboardQuery,
} from "../utils/validation.schemas.js";
import {
  listQueue,
  getDetail,
  overrideClaim,
  dashboard,
  investigation,
} from "../controllers/admin.controller.js";

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

// Operations dashboard (pure server-side metrics; no third-party analytics).
router.get("/dashboard", validate(adminDashboardQuery, "query"), dashboard);

// Fraud investigation (observation-only).
router.get("/investigation", validate(adminDashboardQuery, "query"), investigation);

export default router;