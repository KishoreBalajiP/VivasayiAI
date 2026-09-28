import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as appealService from "../services/appeal.service.js";

// Phase 10 (E9-S10) — Farmer appeal endpoints (08_API_Documentation §10.9). Identity always
// derives from the verified token; ownership flows through claim.service lookups (404 foreign).

const submitAppeal = asyncHandler(async (req, res) => {
  const { appeal, idempotent } = await appealService.createAppealForUser({
    cognitoSub: req.user.id,
    claimId: req.params.claimId,
    reason: req.body.reason,
    statement: req.body.statement,
    requestId: req.requestId ?? null,
  });
  return ApiResponse.success(
    res,
    idempotent ? "Appeal already submitted" : "Appeal submitted",
    { appeal }
  );
});

const getAppeal = asyncHandler(async (req, res) => {
  const appeal = await appealService.getAppealForUser({
    cognitoSub: req.user.id,
    claimId: req.params.claimId,
  });
  if (!appeal) return ApiResponse.success(res, "No appeal for this claim", { appeal: null });
  return ApiResponse.success(res, "Appeal fetched", { appeal });
});

export { submitAppeal, getAppeal };