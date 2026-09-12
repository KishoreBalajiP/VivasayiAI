import { randomUUID } from "node:crypto";
import { EXTENSION_BY_MIME } from "../utils/imageFormat.js";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import ImageRecord from "../models/ImageRecord.js";
import { env } from "../config/env.js";
import { normalizeImage } from "./imageProcess.service.js";
import { putObject, deleteObject, buildObjectKey } from "./s3.service.js";

// E3 (D-22 Option 1 — approved): synchronous transport → validate → normalize → store.
//
// The NORMALIZED image (dimension-capped, EXIF-stripped, re-encoded) is the ONLY thing
// stored — in private S3, never MongoDB (07_Database_Design / 15_Security §5). The original
// upload bytes are released after processing. `size`/`mediaType` in the response remain the
// original (as-received) transport metadata; the `processed` block describes what is stored.
//
// Failure isolation: a failed normalization is a clean 4xx (invalid image before anything is
// written); a failed S3 write leaves no record; a failed record-create (after a successful S3
// write) rolls the orphan object back so we never claim a stored image with no record.
export const receiveUpload = async ({ buffer, size, mimetype, cognitoSub, email }) => {
  const uploadId = `img_${randomUUID()}`;

  // 1. Normalize (decode-safe check + dimension cap + EXIF-strip re-encode). Throws 400 on
  //    corrupt/undecodable content before any storage happens.
  const { buffer: processedBuffer, processed } = await normalizeImage({
    buffer,
    mediaType: mimetype,
  });

  // 2. Store the normalized image. Object key is fully server-generated from the owner's
  //    cognitoSub + server upload id — never derived from any client-supplied filename.
  const objectKey = buildObjectKey(`${cognitoSub}/${uploadId}/image.${EXTENSION_BY_MIME[mimetype]}`);
  await putObject({ key: objectKey, buffer: processedBuffer, mediaType: processed.mediaType });

  // 3. Persist metadata. If this fails after the S3 write, roll back the orphan object so no
  //    object claims to be owned by an image record that does not exist.
  let record;
  try {
    record = await ImageRecord.create({
      cognitoSub,
      userEmail: email ?? null,
      uploadId,
      s3Key: objectKey,
      mediaType: mimetype,
      size,
      processed,
      status: "stored",
    });
  } catch (error) {
    logger.error({ err: error }, "ImageRecord.create failed; rolling back S3 object");
    await deleteObject(objectKey);
    throw ApiError.internal("Image upload failed");
  }

  return {
    uploadId: record.uploadId,
    mediaType: record.mediaType,
    extension: EXTENSION_BY_MIME[record.mediaType],
    size: record.size,
    status: record.status,
    processed: record.processed,
  };
};

export default { receiveUpload };