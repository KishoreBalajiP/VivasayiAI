import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { env, validateEnv, S3_REQUIRED } from "../config/env.js";

// E3 (D-22 Option 1 / D-23): private image storage. Mirrors the S3 client shape already
// used by rag/ingest.js (same region/credentials/bucket). Three hard rules:
//
//  1. S3 configuration is validated LAZILY on first real use, never at import time — the
//     server still boots when E3 storage isn't provisioned, and an upload without storage
//     credentials fails cleanly (sanitized 500), never mid-pipeline. validateEnv(S3_REQUIRED)
//     would otherwise crash every startup on environments that only run text chat.
//  2. No bucket names, object keys, or AWS configuration are ever exposed to clients
//     (15_Security §5). Errors are mapped to the generic "Image storage unavailable".
//  3. Object keys are fully server-generated from the authenticated owner + server upload
//     id — never from any client-supplied filename.
//
// IMAGE_STORAGE_MODE=mock is a dev/test-only seam (documented in .env.example) that swaps
// the real S3 client for an in-memory map so regression suites stay fully deterministic
// (no external AWS dependency). It is server-side environment configuration — a client can
// never influence it, so it cannot be abused to bypass real storage.

const isMock = () => env.imageStorageMode === "mock";

// Dev/test-only seam: in-memory bucket map (bucket -> Map(s3Key -> { buffer, mediaType })).
const mockBuckets = new Map();

let s3Client = null;
const getS3Client = () => {
  if (s3Client) return s3Client;
  validateEnv(S3_REQUIRED);
  s3Client = new S3Client({
    region: env.awsRegion || "us-east-1",
    credentials: {
      accessKeyId: env.awsAccessKeyId,
      secretAccessKey: env.awsSecretAccessKey,
    },
  });
  return s3Client;
};

export const putObject = async ({ key, buffer, mediaType }) => {
  try {
    if (isMock()) {
      if (!mockBuckets.has(env.s3Bucket)) mockBuckets.set(env.s3Bucket, new Map());
      mockBuckets.get(env.s3Bucket).set(key, { buffer, mediaType });
      return;
    }
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: env.s3Bucket,
        Key: key,
        Body: buffer,
        ContentType: mediaType,
      })
    );
  } catch (error) {
    logger.error({ err: error }, "s3.putObject failed");
    throw ApiError.internal("Image storage unavailable");
  }
};

// Returns { buffer, mediaType } or null when the key is absent (mock miss or live 404/403).
export const getObject = async (key) => {
  try {
    if (isMock()) {
      const found = mockBuckets.get(env.s3Bucket)?.get(key);
      return found ? { buffer: found.buffer, mediaType: found.mediaType } : null;
    }
    const response = await getS3Client().send(
      new GetObjectCommand({ Bucket: env.s3Bucket, Key: key })
    );
    const buffer = Buffer.from(await response.Body.transformToByteArray());
    return { buffer, mediaType: response.ContentType };
  } catch (error) {
    logger.error({ err: error }, "s3.getObject failed");
    throw ApiError.internal("Image storage unavailable");
  }
};

// Best-effort delete (used for rollback/cleanup). Never throws — a failed delete leaves an
// orphaned object at worst and must not fail the request that triggered the rollback.
export const deleteObject = async (key) => {
  try {
    if (isMock()) {
      const bucket = mockBuckets.get(env.s3Bucket);
      if (bucket) bucket.delete(key);
      return true;
    }
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key })
    );
    return true;
  } catch (error) {
    logger.warn({ err: error }, "s3.deleteObject best-effort failed");
    return false;
  }
};

// Builds an owner-scoped object key. `dirname` is the server-generated upload id.
export const buildObjectKey = (dirname) =>
  `${env.uploadStoragePrefix}/${dirname}`;

export default { putObject, getObject, deleteObject, buildObjectKey };