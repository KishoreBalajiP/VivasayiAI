import { randomUUID } from "node:crypto";

import ClaimEvidence from "../models/ClaimEvidence.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import { findOwned } from "./claim.service.js";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  EXTENSION_BY_MIME,
  detectImageMime,
} from "../utils/imageFormat.js";
import {
  buildObjectKey,
  getSignedPutUrl,
  getSignedGetUrl,
  headObject,
  getObject,
  putObject,
  deleteObject,
} from "./s3.service.js";
import { normalizeImage } from "./imageProcess.service.js";

// F-49 (ADR-019) — claim-scoped evidence lifecycle (07_Database_Design §7). Reuses the existing
// presigned-S3 pipeline end to end (s3.service + imageProcess.service) rather than duplicating
// upload logic. Ownership flows through the claim: every operation first resolves the caller's
// claim via { _id, cognitoSub } (404 for foreign), then requires the evidence to belong to it.
//
// Evidence is only MUTABLE while a claim is draft / submitted / more_evidence_required;
// terminal-state mutation is rejected (07 §7 state guard). Signed GET is owner-scoped with a
// short TTL (contract: owner/admin only; admin arrives with the admin phase).

const PRESIGN_TTL_SECONDS = 5 * 60; // 5 minutes — short-lived, matches /upload/presign.

const EVIDENCE_MUTABLE_STATES = ["draft", "submitted", "more_evidence_required"];

const assertEvidenceMutable = (claim) => {
  if (!EVIDENCE_MUTABLE_STATES.includes(claim.state)) {
    throw ApiError.conflict(
      "Evidence can only be modified while the claim is draft, submitted, or requires more evidence"
    );
  }
};

const serializeEvidence = (evidence) => ({
  uploadId: evidence.uploadId,
  mediaType: evidence.mediaType,
  size: evidence.size,
  width: evidence.width,
  height: evidence.height,
  status: evidence.status,
  uploadedAt: evidence.uploadedAt,
  createdAt: evidence.createdAt,
  updatedAt: evidence.updatedAt,
});

const UNSAFE_FILENAME = /[\\/]|\u0000|\.\./;
const validateFilename = (filename) => {
  if (filename === undefined || filename === null || filename === "") return;
  const name = String(filename).trim();
  if (name.length > 200 || UNSAFE_FILENAME.test(name)) {
    throw ApiError.badRequest("Filename is invalid");
  }
};

// Best-effort: drop the orphaned raw object and mark the record failed so the retry path is a
// fresh presign (never a half-state). Never throws.
const failEvidence = async (evidence, message) => {
  try {
    await deleteObject(evidence.s3Key);
  } catch {
    // orphaned object at worst
  }
  try {
    evidence.status = "failed";
    await evidence.save();
  } catch {
    // failure already surfaced to the caller
  }
  return ApiError.badRequest(message);
};

export const presignEvidence = async ({
  claimId,
  cognitoSub,
  filename,
  contentType,
  size,
}) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");
  assertEvidenceMutable(claim);

  if (claim.evidence.length >= env.claimEvidenceMaxImages) {
    throw ApiError.badRequest("Evidence limit reached for this claim");
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.has(contentType)) {
    throw ApiError.badRequest("Unsupported image type");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw ApiError.badRequest("File size is required");
  }
  if (size > env.imageUploadMaxBytes) {
    throw new ApiError(413, "Image exceeds the maximum allowed size");
  }
  validateFilename(filename);

  const uploadId = `img_${randomUUID()}`;
  // Owner-scoped key inside the upload namespace: uploads/claims/<claimId>/<uploadId>/image.<ext>.
  const s3Key = buildObjectKey(
    `claims/${claim._id}/${uploadId}/image.${EXTENSION_BY_MIME[contentType]}`
  );

  const evidence = await ClaimEvidence.create({
    claimId: claim._id,
    uploadId,
    s3Key,
    mediaType: contentType,
    size,
    status: "pending",
  });

  claim.evidence.push(evidence._id);
  await claim.save();

  const uploadUrl = await getSignedPutUrl({
    key: s3Key,
    mediaType: contentType,
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  });

  // Only the capability the browser needs is returned: the scoped uploadId, the scoped URL and
  // its expiry. The s3Key/bucket stay server-side.
  return { uploadId, uploadUrl, expiresIn: PRESIGN_TTL_SECONDS * 1000 };
};

export const completeEvidence = async ({ claimId, uploadId, cognitoSub }) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");
  assertEvidenceMutable(claim);

  // uploadId (`img_<uuid>`) is NOT the Mongo _id — it is the server-generated upload key.
  const evidence = await ClaimEvidence.findOne({ uploadId, claimId: claim._id });
  if (!evidence) throw ApiError.notFound("Evidence not found");

  // Idempotent: an already-completed presign returns its final metadata (safe retry).
  if (evidence.status === "stored" || evidence.status === "completed") {
    return serializeEvidence(evidence);
  }
  if (evidence.status === "processing") {
    throw ApiError.badRequest("Evidence is already being processed");
  }

  // Server-side verification of the direct-to-S3 upload (existence + size + content type).
  const verified = await headObject(evidence.s3Key);
  if (!verified) {
    throw ApiError.badRequest("Evidence has not been uploaded");
  }
  if (verified.size > env.imageUploadMaxBytes) {
    throw await failEvidence(evidence, "Image exceeds the maximum allowed size");
  }
  const storedMediaType = String(verified.mediaType || "").toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(storedMediaType) || storedMediaType !== evidence.mediaType) {
    throw await failEvidence(evidence, "Image content does not match its declared type");
  }

  const raw = await getObject(evidence.s3Key);
  if (!raw) {
    throw ApiError.badRequest("Evidence has not been uploaded");
  }

  const sniffed = detectImageMime(raw.buffer);
  if (!sniffed || sniffed !== evidence.mediaType) {
    throw await failEvidence(evidence, "Image content does not match its declared type");
  }

  let normalized;
  try {
    normalized = await normalizeImage({ buffer: raw.buffer, mediaType: evidence.mediaType });
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Invalid or unsupported image content";
    throw await failEvidence(evidence, message);
  }

  try {
    await putObject({
      key: evidence.s3Key,
      buffer: normalized.buffer,
      mediaType: normalized.processed.mediaType,
    });
  } catch (error) {
    throw error; // sanitized ApiError.internal from s3.service
  }

  evidence.width = normalized.processed.width;
  evidence.height = normalized.processed.height;
  evidence.size = verified.size; // server-measured, authoritative
  evidence.uploadedAt = new Date();
  evidence.status = "stored";
  await evidence.save();

  return serializeEvidence(evidence);
};

export const deleteEvidence = async ({ claimId, uploadId, cognitoSub }) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");
  assertEvidenceMutable(claim);

  const evidence = await ClaimEvidence.findOne({ uploadId, claimId: claim._id });
  if (!evidence) throw ApiError.notFound("Evidence not found");

  // Best-effort object cleanup — a failed delete leaves an orphan at worst, never fails the op.
  await deleteObject(evidence.s3Key);
  claim.evidence.pull(evidence._id);
  await claim.save();
  await ClaimEvidence.deleteOne({ _id: evidence._id });

  return { removed: true };
};

export const getEvidenceUrl = async ({ claimId, uploadId, cognitoSub }) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const evidence = await ClaimEvidence.findOne({ uploadId, claimId: claim._id });
  if (!evidence) throw ApiError.notFound("Evidence not found");
  if (evidence.status !== "stored") {
    throw ApiError.badRequest("Evidence has not been stored yet");
  }

  const url = await getSignedGetUrl({
    key: evidence.s3Key,
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  });
  return { url, expiresIn: PRESIGN_TTL_SECONDS * 1000 };
};

export default {
  presignEvidence,
  completeEvidence,
  deleteEvidence,
  getEvidenceUrl,
};