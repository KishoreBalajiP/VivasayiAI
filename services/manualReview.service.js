import mongoose from "mongoose";
import { createHash } from "node:crypto";
import ApiError from "../utils/ApiError.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import ClaimAudit from "../models/ClaimAudit.js";
import LossClaim from "../models/LossClaim.js";
import AdminAction from "../models/AdminAction.js";
import { env } from "../config/env.js";
import { findOwned } from "./claim.service.js";
import { requestReevaluation } from "./verificationWorker.service.js";

// Extensible manual-review service (Phase 15 Additional Requirement). Operates on existing
// VerificationEvidence rows so a future admin panel can list cases, retrieve evidence, record a
// decision, and view audit history without rewriting the verification engine. No admin UI here.

// VERIFIED is deliberately not a review outcome: it means authoritative, and a person reading a file
// is not an authoritative source (see resolveOwnershipReviewOutcome).
const VALID_REVIEW_STATUSES = ["AVAILABLE", "INSUFFICIENT", "INCONSISTENT", "UNAVAILABLE"];

// Deterministic per-claim key: the same source + reasons always map to the SAME case, so a pipeline
// re-run (resubmit, retry, duplicate trigger) can never pile up duplicate cases or audit rows. A
// different set of reasons is a different question for the reviewer and opens its own case.
// Prefix `rv_` marks the row as a review case (see OWNERSHIP_DOCUMENT_FILTER); max 64 chars.
export const reviewCaseKey = ({ claimId, source, reasons = [] }) => {
  const normalized = [...(Array.isArray(reasons) ? reasons : [String(reasons)])].map(String).sort();
  const digest = createHash("sha1").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
  return `rv_${String(claimId)}_${source}_${digest}`.slice(0, 64);
};

export const createReviewCase = async ({ claimId, cognitoSub, source, reasons = [], evidenceReferences = [], metadata = {}, requestId = null } = {}) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const idempotencyKey = reviewCaseKey({ claimId: claim._id, source, reasons });
  const existing = await VerificationEvidence.findOne({ claimId: claim._id, idempotencyKey });
  if (existing) return existing;

  let row;
  try {
    row = await VerificationEvidence.create({
      claimId: claim._id,
      source,
      status: "PENDING",
      result: {
        requiresReview: true,
        reviewReasons: Array.isArray(reasons) ? reasons : [String(reasons)],
        evidenceReferences: Array.isArray(evidenceReferences) ? evidenceReferences : [],
        reviewHistory: [],
      },
      metadata: { ...(metadata || {}), reviewRequired: true, kind: "review_case" },
      idempotencyKey,
      // ADR-022 (additive): the row is a review case, not evidence, whatever source it is labelled
      // with (a dead AI or document job's case is labelled AI_IMAGE / OWNERSHIP).
      component: "manual_review",
      kind: "review_case",
    });
  } catch (error) {
    // Concurrent duplicate trigger: the winner's row is the case.
    if (error?.code === 11000) {
      return VerificationEvidence.findOne({ claimId: claim._id, idempotencyKey });
    }
    throw error;
  }

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

export const listReviewCases = async ({ claimId = null, reviewerRole = null } = {}) => {
  if (reviewerRole !== "admin") throw ApiError.forbidden("Admin access required");
  const query = { "metadata.kind": "review_case" };
  if (claimId) query.claimId = claimId;
  const rows = await VerificationEvidence.find(query).sort({ createdAt: -1 }).limit(200);
  return rows;
};

export const recordReviewDecision = async ({ claimId = null, evidenceId, actorSub, actorRole, actorEmail = null, decision, reason, requestId = null } = {}) => {
  if (actorRole !== "admin") throw ApiError.forbidden("Admin access required");
  if (!VALID_REVIEW_STATUSES.includes(decision)) throw ApiError.badRequest("Invalid review decision");
  if (!reason || String(reason).trim().length < 10) throw ApiError.badRequest("Review reason too short");

  const row = await VerificationEvidence.findOne({
    _id: evidenceId,
    ...(claimId ? { claimId } : {}),
    "metadata.kind": "review_case",
  });
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

  // Immutable record of WHO decided (the audit row alone has no actor identity). One case, one
  // decision, so the key is deterministic and cannot collide with other action types.
  await AdminAction.create({
    claimId: claim._id,
    action: "manual_review",
    actorSub,
    actorEmail,
    priorState: row.status,
    targetState: decision,
    reason: String(reason).trim().slice(0, 2000),
    idempotencyKey: `mrdecision_${String(updated._id)}`,
    metadata: { reviewCaseId: String(updated._id), component: updated.metadata?.component ?? null },
    requestId,
  }).catch((error) => {
    if (error?.code !== 11000) throw error;
  });

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

  // A resolved review case can unblock a held claim: ask for a fresh decision.
  if (env.claimAutomatedVerificationEnabled) {
    await requestReevaluation({ claimId: claim._id, cognitoSub: claim.cognitoSub });
  }

  return updated;
};

export default { createReviewCase, listReviewCases, recordReviewDecision };