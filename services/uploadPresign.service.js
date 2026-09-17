import { randomUUID } from "node:crypto";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import ImageRecord from "../models/ImageRecord.js";
import { env } from "../config/env.js";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  EXTENSION_BY_MIME,
  detectImageMime,
} from "../utils/imageFormat.js";
import {
  getSignedPutUrl,
  headObject,
  getObject,
  putObject,
  deleteObject,
  buildObjectKey,
} from "./s3.service.js";
import { normalizeImage } from "./imageProcess.service.js";

// E3 presigned transport (transport-only replacement for multipart POST /upload on images
// that exceed Lambda's synchronous invoke ceiling after base64 expansion):
//
//   client POST /upload/presign { filename?, contentType, size }  (authenticated)
//     → server validates MIME + size, creates ImageRecord status="pending" with a
//       server-generated `img_<uuid>` + owner-scoped key `uploads/<cognitoSub>/<uploadId>/…`,
//       and returns a short-lived presigned PUT for that key.
//   client PUT <presigned URL>                                    (Browser → S3, no API Gateway/Lambda)
//     → the image binary never transits the API.
//   client POST /upload/:uploadId/complete                         (authenticated)
//     → server verifies ownership + object existence/size/content-type via headObject,
//       retrieves the bytes, re-runs the existing magic-byte + sharp validation/normalization
//       pipeline, overwrites the same key with the normalized image, and records status
//       "stored" — the exact end state POST /upload produced before.
//
// POST /upload (multipart) is kept as a deprecated/backward-compat route during migration.
//
// Ownership is scoped by the authenticated cognitoSub at every step (E1-S5 / D-35); the
// client can never supply a key, the uploadId alone is meaningless without owner match, and
// the presigned URL is bound to ONE server-owned key + content type for a few minutes.

const PRESIGN_TTL_SECONDS = 5 * 60; // 5 minutes; TTL is intentionally short-lived.

const toUploadResult = (record) => ({
  uploadId: record.uploadId,
  mediaType: record.mediaType,
  extension: EXTENSION_BY_MIME[record.mediaType],
  size: record.size,
  status: record.status,
  processed: record.processed,
});

// `filename` is metadata only — never used in keys or storage. It is validated purely as an
// input-hygiene guard (no paths, no traversal, no control chars) so a hostile name cannot be
// logged/echoed back unsanitized.
const UNSAFE_FILENAME = /[\\/]|\u0000|\.\./;
const validateFilename = (filename) => {
  if (filename === undefined || filename === null || filename === "") return;
  const name = String(filename).trim();
  if (name.length > 200 || UNSAFE_FILENAME.test(name)) {
    throw ApiError.badRequest("Filename is invalid");
  }
};

export const createPresignedUpload = async ({
  filename,
  contentType,
  size,
  cognitoSub,
  email,
}) => {
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
  const s3Key = buildObjectKey(
    `${cognitoSub}/${uploadId}/image.${EXTENSION_BY_MIME[contentType]}`
  );

  let record;
  try {
    record = await ImageRecord.create({
      cognitoSub,
      userEmail: email ?? null,
      uploadId,
      s3Key,
      mediaType: contentType,
      size,
      status: "pending",
    });
  } catch (error) {
    logger.error({ err: error }, "presign.record_create_failed");
    throw ApiError.internal("Image upload failed");
  }

  const uploadUrl = await getSignedPutUrl({
    key: s3Key,
    mediaType: contentType,
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  });

  logger.info({ uploadId, cognitoSub }, "presign.created");

  // Only the capability the browser needs is returned: the scoped uploadId, the scoped URL
  // and its expiry. The raw s3Key/bucket/config stay server-side (15_Security §5).
  return { uploadId, uploadUrl, expiresIn: PRESIGN_TTL_SECONDS * 1000 };
};

// Best-effort: delete the (invalid/undecodable) raw object and persist the failed state so
// the retry path is a fresh presign (never a confusing half-state). Never throws.
const failAndCleanup = async (record, stage, publicMessage, internalErr) => {
  logger.warn({ uploadId: record.uploadId, err: internalErr }, `presign.${stage}`);
  try {
    await deleteObject(record.s3Key);
  } catch {
    // orphaned object at worst; the failure is already recorded
  }
  try {
    record.status = "failed";
    record.error = { stage, message: String(publicMessage).slice(0, 400) };
    await record.save();
  } catch (saveError) {
    logger.warn(
      { uploadId: record.uploadId, err: saveError },
      "presign.fail_record_save_failed"
    );
  }
};

export const completeUpload = async ({ uploadId, cognitoSub }) => {
  const record = await ImageRecord.findOne({ uploadId, cognitoSub });
  if (!record) {
    throw ApiError.notFound("Image upload not found");
  }

  // Idempotent: an already-completed presign returns its final metadata (safe retry after a
  // dropped response). A concurrently-processing upload must not be disturbed.
  if (record.status === "stored" || record.status === "completed") {
    return toUploadResult(record);
  }
  if (record.status === "processing") {
    throw ApiError.badRequest("Image is already being processed");
  }

  // 1. Server-side verification of the direct-to-S3 upload: existence + size + content type.
  let verified;
  try {
    verified = await headObject(record.s3Key);
  } catch (error) {
    throw error; // sanitized ApiError.internal from s3.service
  }
  if (!verified) {
    throw ApiError.badRequest("Image has not been uploaded");
  }
  if (verified.size > env.imageUploadMaxBytes) {
    await failAndCleanup(record, "complete_size", "Image exceeds the maximum allowed size");
    throw new ApiError(413, "Image exceeds the maximum allowed size");
  }
  const storedMediaType = String(verified.mediaType || "").toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(storedMediaType) || storedMediaType !== record.mediaType) {
    await failAndCleanup(record, "complete_type", "Image content does not match its declared type");
    throw ApiError.badRequest("Image content does not match its declared type");
  }

  record.status = "uploaded";
  await record.save();

  // 2. Retrieve bytes server-side (the image never crosses API Gateway twice) and re-run the
  //    existing validation/normalization pipeline (magic bytes => sharp decode guard, EXIF
  //    strip, orientation, dimension cap, megapixel guard).
  const raw = await getObject(record.s3Key);
  if (!raw) {
    await failAndCleanup(record, "complete_fetch", "Image has not been uploaded");
    throw ApiError.badRequest("Image has not been uploaded");
  }

  const sniffed = detectImageMime(raw.buffer);
  if (!sniffed || sniffed !== record.mediaType) {
    await failAndCleanup(record, "complete_sniff", "Image content does not match its declared type");
    throw ApiError.badRequest("Image content does not match its declared type");
  }

  let normalized;
  try {
    normalized = await normalizeImage({ buffer: raw.buffer, mediaType: record.mediaType });
  } catch (error) {
    const message =
      error instanceof ApiError ? error.message : "Invalid or unsupported image content";
    await failAndCleanup(record, "complete_normalize", message, error);
    throw error instanceof ApiError ? error : ApiError.badRequest(message);
  }

  // 3. The normalized image overwrites the raw object at the same server-owned key, leaving
  //    exactly the object layout POST /upload produced (chatImage.service reads s3Key as-is).
  try {
    await putObject({
      key: record.s3Key,
      buffer: normalized.buffer,
      mediaType: normalized.processed.mediaType,
    });
    record.processed = normalized.processed;
    record.size = verified.size; // server-measured, authoritative
    record.status = "stored";
    record.error = { stage: null, message: null };
    await record.save();
  } catch (error) {
    await failAndCleanup(record, "complete_store", "Image storage unavailable", error);
    throw error; // sanitized ApiError.internal
  }

  logger.info({ uploadId, cognitoSub, size: verified.size }, "presign.completed");
  return toUploadResult(record);
};

export default { createPresignedUpload, completeUpload };