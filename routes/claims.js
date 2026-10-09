import express from "express";
import validate from "../middlewares/validate.js";
import { claimLimiter, evidenceLimiter } from "../middlewares/rateLimit.js";
import {
  claimParams,
  claimEvidenceParams,
  createClaimBody,
  presignUploadBody,
  appealBody,
  ownershipBody,
  ownershipEvidenceParams,
} from "../utils/validation.schemas.js";
import {
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
} from "../controllers/claim.controller.js";
import { submitAppeal, getAppeal } from "../controllers/appeal.controller.js";
import {
  submitOwnershipEvidence,
  listOwnershipEvidence,
  getOwnershipDocumentUrl,
} from "../controllers/ownership.controller.js";

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

// E9-S5/E9-S6 (Phase 6) — deterministic verification gateway. Same ownership/limit conventions
// as the rest of the lifecycle; NO body contract (the client only requests verification — any
// client-supplied result/state/area/AI payload is ignored by the service, P5-20).
router.post("/:claimId/verify", claimLimiter, validate(claimParams, "params"), verifyClaim);

// Phase 10 (E9-S10) — farmer appeal of an eligible engine decision (08 §10.9). Idempotent: an
// active appeal returns as-is. Claim ownership still flows through claim.service lookups.
router.post("/:claimId/appeal", claimLimiter, validate(claimParams, "params"), validate(appealBody), submitAppeal);
router.get("/:claimId/appeal", claimLimiter, validate(claimParams, "params"), getAppeal);

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

// Phase 12 (E12) — Land ownership evidence (08_API_Documentation §10.13). The document bytes use
// the EXISTING private presigned /upload pipeline; these routes attach an owned, stored upload to
// the claim and expose owner-scoped reads. The attach mutation reuses evidenceLimiter (per-user,
// matching the claim-evidence surface); the GETs are unmetered like the other read endpoints.
router.post(
  "/:claimId/ownership",
  evidenceLimiter,
  validate(claimParams, "params"),
  validate(ownershipBody),
  submitOwnershipEvidence
);
router.get("/:claimId/ownership", validate(claimParams, "params"), listOwnershipEvidence);
router.get(
  "/:claimId/ownership/:evidenceId/url",
  validate(ownershipEvidenceParams, "params"),
  getOwnershipDocumentUrl
);

export default router;