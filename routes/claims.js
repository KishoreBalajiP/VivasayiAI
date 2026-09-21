import express from "express";
import validate from "../middlewares/validate.js";
import { claimLimiter, evidenceLimiter } from "../middlewares/rateLimit.js";
import {
  claimParams,
  claimEvidenceParams,
  createClaimBody,
  presignUploadBody,
} from "../utils/validation.schemas.js";
import {
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
} from "../controllers/claim.controller.js";

// F-49 (ADR-019) — Agricultural Loss Claim endpoints (08_API_Documentation §10).
// Mounted after requireAuth in app.js; all claim endpoints carry the per-user claim/evidence
// limiters documented in 15_Security §5 (08 §10 line: "claimLimiter + evidenceLimiter rate
// limits"). Idempotency keys are enforced on create; submit is naturally idempotent (an
// already-submitted claim returns as-is).

const router = express.Router();

// Claim lifecycle
router.get("/", claimLimiter, listClaims);
router.post("/", claimLimiter, validate(createClaimBody), createClaim);
router.get("/:claimId", claimLimiter, validate(claimParams, "params"), getClaim);
router.post("/:claimId/submit", claimLimiter, validate(claimParams, "params"), submitClaim);
router.post("/:claimId/withdraw", claimLimiter, validate(claimParams, "params"), withdrawClaim);
router.post("/:claimId/resubmit", claimLimiter, validate(claimParams, "params"), resubmitClaim);

// Claim evidence (reuses the existing presigned S3 pipeline)
router.post(
  "/:claimId/evidence/presign",
  evidenceLimiter,
  validate(claimParams, "params"),
  validate(presignUploadBody),
  presignEvidence
);
router.post(
  "/:claimId/evidence/:evidenceId/complete",
  evidenceLimiter,
  validate(claimParams, "params"),
  validate(claimEvidenceParams, "params"),
  completeEvidence
);
router.delete(
  "/:claimId/evidence/:evidenceId",
  evidenceLimiter,
  validate(claimParams, "params"),
  validate(claimEvidenceParams, "params"),
  deleteEvidence
);
router.get(
  "/:claimId/evidence/:evidenceId/url",
  evidenceLimiter,
  validate(claimParams, "params"),
  validate(claimEvidenceParams, "params"),
  getEvidenceUrl
);

export default router;