import mongoose from "mongoose";

import LossClaim from "../models/LossClaim.js";
import FarmProfile from "../models/FarmProfile.js";
import ImageRecord from "../models/ImageRecord.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import ApiError from "../utils/ApiError.js";
import { findOwned } from "./claim.service.js";
import { createImageViewUrl } from "./uploadPresign.service.js";
import {
  validateEvidencePayload,
  sanitizeEvidencePayload,
} from "../utils/verificationEvidence.js";
import {
  DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY,
  DEFAULT_OWNERSHIP_VERIFICATION_METHOD,
  OWNERSHIP_FOUNDATION_VERSION,
  OWNERSHIP_INITIAL_STATUS,
  OWNERSHIP_REVIEW_STATUSES,
  OWNERSHIP_SOURCE,
  OWNERSHIP_TERMINAL_STATUSES,
  deriveOwnershipIdempotencyKey,
  ownershipEvidenceFingerprint,
  resolveOwnershipReviewOutcome,
  validateOwnershipDocumentCategory,
  validateOwnershipReviewReason,
  validateOwnershipUploadId,
} from "../utils/ownershipEvidence.js";

// Phase 12 (E12) — Land Ownership evidence service.
//
// The first functional ownership workflow, built strictly on the Phase 11 Verification Evidence
// Foundation (models/VerificationEvidence.js, source = "OWNERSHIP"). It reuses the EXISTING private
// presigned-S3 upload pipeline (services/uploadPresign.service.js) for the document bytes — no new
// storage path, no AI, no new claim lifecycle state — and records an immutable audit trail.
//
// Boundaries (deliberately preserved):
//   - Ownership evidence NEVER changes claim.state, the ClaimAssessment decision, claimed area or
//     parcel geometry, and is NEVER consumed by the deterministic engine (operative: false).
//   - Attaching a document is NOT verification (PENDING). Only an ADMIN manual review can resolve a
//     document, and it is explicitly NON-authoritative — VERIFIED is unreachable (no provider).
//   - Ownership is enforced server-side: reads/writes resolve the caller's claim via
//     { _id, cognitoSub } (foreign/unowned → 404), and the attached document must be a STORED
//     ImageRecord owned by the SAME caller (no cross-user attach, no arbitrary id).

const STATUS_COUNT_KEYS = [
  "NOT_CHECKED",
  "PENDING",
  ...OWNERSHIP_REVIEW_STATUSES,
];

const assertValidClaimId = (claimId) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) {
    throw ApiError.badRequest("Valid claim id is required");
  }
};

const assertValidEvidenceId = (evidenceId) => {
  if (!evidenceId || !mongoose.isValidObjectId(String(evidenceId))) {
    throw ApiError.badRequest("Valid evidence id is required");
  }
};

const assertValidCognitoSub = (cognitoSub) => {
  if (!cognitoSub || typeof cognitoSub !== "string") {
    throw ApiError.unauthorized("Authentication required");
  }
};

const normalizeCategory = (documentCategory) => {
  if (documentCategory === null || documentCategory === undefined || documentCategory === "") {
    return DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY;
  }
  return String(documentCategory).trim();
};

// Safe, source-neutral view. NEVER exposes storage internals (an s3Key/signed URL is never stored
// on the row; signed URLs are minted on demand and returned separately).
const serializeOwnershipRow = (doc) => {
  const record = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(record._id),
    claimId: String(record.claimId),
    source: OWNERSHIP_SOURCE,
    status: record.status,
    reference: record.reference ?? null, // the stored document's uploadId (opaque, non-secret)
    metadata: record.metadata || {},
    result: record.result ?? null,
    provider: record.provider ?? null,
    providerVersion: record.providerVersion ?? null,
    evidenceVersion: record.evidenceVersion ?? null,
    evaluationVersion: record.evaluationVersion ?? null,
    observedAt: record.observedAt ?? null,
    operative: false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

const buildSummary = (rows) => {
  const statusCounts = {};
  for (const key of STATUS_COUNT_KEYS) statusCounts[key] = 0;
  for (const row of rows) statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
  return {
    total: rows.length,
    pending: statusCounts.PENDING || 0,
    reviewed: rows.filter((row) => OWNERSHIP_TERMINAL_STATUSES.includes(row.status)).length,
    statusCounts,
    // No authoritative ownership provider is configured this phase — surfaced so clients never
    // interpret a manual review as an authoritative/legal verification.
    authoritative: false,
    verificationAvailable: false,
  };
};

// Attach a previously uploaded (stored) private document to a claim the caller owns.
export const submitOwnershipEvidence = async ({
  claimId,
  cognitoSub,
  uploadId,
  documentCategory = null,
  requestId = null,
} = {}) => {
  assertValidClaimId(claimId);
  assertValidCognitoSub(cognitoSub);

  const refCheck = validateOwnershipUploadId(uploadId);
  if (!refCheck.ok) throw ApiError.badRequest(refCheck.reason);
  const reference = String(uploadId).trim();

  const categoryCheck = validateOwnershipDocumentCategory(documentCategory);
  if (!categoryCheck.ok) throw ApiError.badRequest(categoryCheck.reason);
  const category = normalizeCategory(documentCategory);

  // Authority: the claim must belong to the caller.
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  // Relationship: the claim's parcel must exist on THIS caller's own farm profile.
  const profile = await FarmProfile.findOne({ cognitoSub });
  const parcel = (profile?.parcels || []).find((entry) => entry.parcelId === claim.parcelId);
  if (!parcel) throw ApiError.notFound("Parcel not found for this claim");

  // The document must be a STORED private upload owned by the SAME caller. This blocks attaching
  // another user's uploadId and rejects unknown/one-off ids (no resource-existence disclosure).
  const image = await ImageRecord.findOne({ uploadId: reference, cognitoSub });
  if (!image || image.status !== "stored") {
    throw ApiError.notFound("Ownership document not found");
  }

  const idempotencyKey = deriveOwnershipIdempotencyKey(reference);
  const existing = await VerificationEvidence.findOne({ claimId: claim._id, idempotencyKey });
  if (existing) return { evidence: serializeOwnershipRow(existing), idempotent: true };

  const metadata = {
    parcelId: claim.parcelId,
    documentCategory: category,
    mediaType: image.mediaType,
    size: image.size,
  };
  const metadataCheck = validateEvidencePayload(metadata, "Ownership document metadata");
  if (!metadataCheck.ok) throw ApiError.badRequest(metadataCheck.reason);

  const observedAt = image.uploadedAt || image.updatedAt || image.createdAt || null;

  let created;
  try {
    created = await VerificationEvidence.create({
      claimId: claim._id,
      source: OWNERSHIP_SOURCE,
      status: OWNERSHIP_INITIAL_STATUS,
      confidence: null,
      observedAt,
      provider: null,
      providerVersion: null,
      evidenceVersion: ownershipEvidenceFingerprint({
        uploadId: reference,
        mediaType: image.mediaType,
        size: image.size,
      }),
      evaluationVersion: OWNERSHIP_FOUNDATION_VERSION,
      reference,
      metadata: sanitizeEvidencePayload(metadata),
      result: null,
      idempotencyKey,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await VerificationEvidence.findOne({ claimId: claim._id, idempotencyKey });
      if (raced) return { evidence: serializeOwnershipRow(raced), idempotent: true };
    }
    throw error;
  }

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "farmer",
    action: "ownership_evidence_submitted",
    fromState: claim.state,
    toState: claim.state,
    reason: "Land ownership supporting document attached",
    metadata: {
      evidenceId: created._id,
      uploadId: reference,
      parcelId: claim.parcelId,
      documentCategory: category,
      mediaType: image.mediaType,
      size: image.size,
    },
    requestId,
  });

  return { evidence: serializeOwnershipRow(created), idempotent: false };
};

// Owner-scoped list of a claim's attached ownership documents.
export const listOwnershipEvidenceForClaim = async ({ claimId, cognitoSub } = {}) => {
  assertValidClaimId(claimId);
  assertValidCognitoSub(cognitoSub);

  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const rows = await VerificationEvidence.find({
    claimId: claim._id,
    source: OWNERSHIP_SOURCE,
  }).sort({ createdAt: 1 });

  return {
    claimId: String(claim._id),
    foundationVersion: OWNERSHIP_FOUNDATION_VERSION,
    evidence: rows.map(serializeOwnershipRow),
    summary: buildSummary(rows),
  };
};

// Owner-scoped, short-lived signed URL for one owned ownership document.
export const getOwnershipEvidenceDocumentUrl = async ({ claimId, evidenceId, cognitoSub } = {}) => {
  assertValidClaimId(claimId);
  assertValidEvidenceId(evidenceId);
  assertValidCognitoSub(cognitoSub);

  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const row = await VerificationEvidence.findOne({
    _id: evidenceId,
    claimId: claim._id,
    source: OWNERSHIP_SOURCE,
  });
  if (!row) throw ApiError.notFound("Ownership evidence not found");

  // Reuses the existing owner-scoped private-storage signer; it enforces { uploadId, cognitoSub }.
  return createImageViewUrl({ uploadId: row.reference, cognitoSub });
};

// Admin-only: list every ownership document for ANY claim (review context), with best-effort
// short-lived signed URLs for rendering. Read-only.
export const listOwnershipEvidenceForAdmin = async ({ claimId } = {}) => {
  assertValidClaimId(claimId);

  const claim = await LossClaim.findById(claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const rows = await VerificationEvidence.find({
    claimId: claim._id,
    source: OWNERSHIP_SOURCE,
  }).sort({ createdAt: 1 });

  const evidence = [];
  for (const row of rows) {
    let documentUrl = null;
    if (row.reference) {
      try {
        const signed = await createImageViewUrl({
          uploadId: row.reference,
          cognitoSub: claim.cognitoSub,
        });
        documentUrl = { signedUrl: signed.signedUrl, expiresIn: signed.expiresIn };
      } catch {
        documentUrl = null; // best-effort: a failed sign never fails the whole list
      }
    }
    evidence.push({ ...serializeOwnershipRow(row), documentUrl });
  }

  return {
    claimId: String(claim._id),
    foundationVersion: OWNERSHIP_FOUNDATION_VERSION,
    evidence,
    summary: buildSummary(rows),
  };
};

// Admin-only: resolve ONE ownership document from PENDING → terminal review outcome. This is the
// ONLY path that can move a document past PENDING; it is role-gated (requireRole("admin") at the
// route + a defensive role check here), race-safe (CAS), replay-safe (idempotent on identical
// replay) and immutably audited (AdminAction + ClaimAudit). It NEVER touches claim state/decision.
export const reviewOwnershipEvidence = async ({
  claimId,
  evidenceId,
  actorSub,
  actorRole,
  actorEmail = null,
  status,
  method = DEFAULT_OWNERSHIP_VERIFICATION_METHOD,
  reason,
  requestId = null,
} = {}) => {
  assertValidClaimId(claimId);
  assertValidEvidenceId(evidenceId);
  if (actorRole !== "admin" || !actorSub) {
    throw ApiError.forbidden("Admin access required");
  }

  const reasonCheck = validateOwnershipReviewReason(reason);
  if (!reasonCheck.ok) throw ApiError.badRequest(reasonCheck.reason);

  const outcome = resolveOwnershipReviewOutcome({ status, method });
  if (!outcome.ok) throw ApiError.badRequest(outcome.reason);

  const claim = await LossClaim.findById(claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const current = await VerificationEvidence.findOne({
    _id: evidenceId,
    claimId: claim._id,
    source: OWNERSHIP_SOURCE,
  });
  if (!current) throw ApiError.notFound("Ownership evidence not found");

  const trimmedReason = reason.trim();

  // Replay-safe: an already-reviewed document returns unchanged when the outcome is identical.
  if (OWNERSHIP_TERMINAL_STATUSES.includes(current.status)) {
    if (current.status === status && current.result?.verificationMethod === outcome.method) {
      return { evidence: serializeOwnershipRow(current), idempotent: true };
    }
    throw ApiError.conflict("Ownership evidence has already been reviewed");
  }

  const reviewedAt = new Date();
  const result = {
    verificationMethod: outcome.method,
    authoritative: outcome.authoritative,
    reviewedByRole: "admin",
    reviewedAt: reviewedAt.toISOString(),
    reason: trimmedReason,
  };
  const resultCheck = validateEvidencePayload(result, "Ownership review result");
  if (!resultCheck.ok) throw ApiError.badRequest(resultCheck.reason);

  // Race-safe compare-and-swap: only a PENDING/NOT_CHECKED row may transition to a terminal
  // outcome, so two concurrent reviews can never both apply (and never both create an AdminAction).
  const updated = await VerificationEvidence.findOneAndUpdate(
    {
      _id: current._id,
      claimId: claim._id,
      source: OWNERSHIP_SOURCE,
      status: { $in: ["PENDING", "NOT_CHECKED"] },
    },
    {
      $set: {
        status,
        result: sanitizeEvidencePayload(result),
        provider: "admin-manual-review",
        providerVersion: OWNERSHIP_FOUNDATION_VERSION,
        evaluationVersion: OWNERSHIP_FOUNDATION_VERSION,
      },
    },
    { new: true }
  );

  if (!updated) {
    const raced = await VerificationEvidence.findById(current._id);
    if (raced && OWNERSHIP_TERMINAL_STATUSES.includes(raced.status) && raced.status === status) {
      return { evidence: serializeOwnershipRow(raced), idempotent: true };
    }
    throw ApiError.conflict("Ownership evidence has already been reviewed");
  }

  const adminAction = await AdminAction.create({
    claimId: claim._id,
    action: "manual_review",
    actorSub,
    actorEmail,
    priorState: current.status,
    targetState: status,
    reason: trimmedReason,
    // Deterministic per-document key: the `{claimId, idempotencyKey}` unique index would otherwise
    // collide across multiple reviews on the same claim (AdminAction defaults the key to null, and
    // a sparse index still indexes explicit nulls). One document ⇒ one review action.
    idempotencyKey: `ownreview_${String(updated._id)}`,
    metadata: {
      ownershipEvidenceId: String(updated._id),
      uploadId: updated.reference,
      method: outcome.method,
      authoritative: outcome.authoritative,
    },
    requestId,
  });

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "admin",
    action: "ownership_evidence_reviewed",
    fromState: claim.state,
    toState: claim.state,
    reason: `Ownership evidence reviewed (${current.status} → ${status})`,
    metadata: {
      evidenceId: updated._id,
      uploadId: updated.reference,
      fromStatus: current.status,
      toStatus: status,
      method: outcome.method,
      authoritative: outcome.authoritative,
      adminActionId: adminAction._id,
    },
    requestId,
  });

  return { evidence: serializeOwnershipRow(updated), idempotent: false };
};

export default {
  submitOwnershipEvidence,
  listOwnershipEvidenceForClaim,
  getOwnershipEvidenceDocumentUrl,
  listOwnershipEvidenceForAdmin,
  reviewOwnershipEvidence,
};
