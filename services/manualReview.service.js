import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import ClaimAudit from "../models/ClaimAudit.js";
import LossClaim from "../models/LossClaim.js";
import { findOwned } from "./claim.service.js";

// Extensible manual-review service (Phase 15 Additional Requirement). Operates on existing
// VerificationEvidence rows so a future admin panel can list cases, retrieve evidence, record a
// decision, and view audit history without rewriting the verification engine. No admin UI here.

const VALID_REVIEW_STATUSES = ["AVAILABLE", "INSUFFICIENT", "INCONSISTENT", "UNAVAILABLE", "VERIFIED"];

export const createReviewCase = async ({ claimId, cognitoSub, source, reasons = [], evidenceReferences = [], metadata = {}, requestId = null } = {}) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const row = await VerificationEvidence.create({
    claimId: claim._id,
    source,
    status: "PENDING",
    result: {
      requiresReview: true,
      reviewReasons: Array.isArray(reasons) ? reasons : [String(reasons)],
      evidenceReferences: Array.isArray(evidenceReferences) ? evidenceReferences : [],
      reviewHistory: [],
    },
    metadata: { ...(metadata || {}), reviewRequired: true },
    idempotencyKey: `review_${String(claimId)}_${source}_${Date.now()}`.slice(0, 64),
  });

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "engine",
    action: "review_required",
    fromState: claim.state,
    toState: claim.state,
    reason: "Automated check requires manual review",
    metadata: { reviewEvidenceId: String(row._id), source, reasons },
    requestId,
  });

  return row;
};

export const listReviewCases = async ({ claimId = null, cognitoSub = null, reviewerRole = "admin" } = {}) => {
  if (reviewerRole !== "admin") throw ApiError.forbidden("Admin access required");
  const query = { "metadata.reviewRequired": true };
  if (claimId) query.claimId = claimId;
  const rows = await VerificationEvidence.find(query).sort({ createdAt: -1 }).limit(200);
  return rows;
};

export const recordReviewDecision = async ({ evidenceId, actorSub, actorRole, decision, reason, requestId = null } = {}) => {
  if (actorRole !== "admin") throw ApiError.forbidden("Admin access required");
  if (!VALID_REVIEW_STATUSES.includes(decision)) throw ApiError.badRequest("Invalid review decision");
  if (!reason || String(reason).trim().length < 10) throw ApiError.badRequest("Review reason too short");

  const row = await VerificationEvidence.findById(evidenceId);
  if (!row) throw ApiError.notFound("Review case not found");
  const claim = await LossClaim.findById(row.claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const currentResult = row.result || {};
  const history = Array.isArray(currentResult.reviewHistory) ? currentResult.reviewHistory : [];
  history.push({
    decision,
    reason: String(reason).trim().slice(0, 2000),
    reviewerSub: actorSub,
    decidedAt: new Date().toISOString(),
  });

  const updated = await VerificationEvidence.findOneAndUpdate(
    { _id: row._id, status: { $in: ["PENDING", "NOT_CHECKED"] } },
    {
      $set: {
        status: decision,
        result: {
          ...currentResult,
          requiresReview: false,
          reviewHistory: history,
          resolvedDecision: decision,
          resolvedAt: new Date().toISOString(),
        },
      },
    },
    { new: true }
  );
  if (!updated) throw ApiError.conflict("Review case already resolved");

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "admin",
    action: "manual_review_resolved",
    fromState: claim.state,
    toState: claim.state,
    reason: String(reason).trim().slice(0, 2000),
    metadata: { evidenceId: String(updated._id), decision },
    requestId,
  });

  return updated;
};

export default { createReviewCase, listReviewCases, recordReviewDecision };