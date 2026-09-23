import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

// Returns { size, mediaType } for an existing object, or null when the key is absent. Used by
// the presigned-upload completion step to verify the object server-side (existence, size,
// content type) instead of trusting browser claims.
export const headObject = async (key) => {
  try {
    if (isMock()) {
      const found = mockBuckets.get(env.s3Bucket)?.get(key);
      return found ? { size: found.buffer.length, mediaType: found.mediaType } : null;
    }
    const response = await getS3Client().send(
      new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key })
    );
    const size = Number(response.ContentLength);
    return { size: Number.isFinite(size) ? size : 0, mediaType: response.ContentType };
  } catch (error) {
    if (
      error?.name === "NotFound" ||
      error?.name === "NoSuchKey" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    logger.error({ err: error }, "s3.headObject failed");
    throw ApiError.internal("Image storage unavailable");
  }
};

// Generates a short-lived presigned PUT URL for the given server-owned key. The image then
// travels directly Browser → S3 (never through API Gateway/Lambda), so Lambda's 6MB
// synchronous invoke ceiling no longer applies to the binary. The Content-Type is signed
// into the URL: the client MUST send that exact header on the PUT or S3 rejects it.
//
// The capability the URL grants is deliberately narrow: one object (the exact server-owned
// key), one method (PUT), one content type, one expiry. Ownership/verification still happens
// server-side in the complete step — a presigned URL alone grants nothing on this bucket.
export const getSignedPutUrl = async ({ key, mediaType, expiresInSeconds }) => {
  try {
    if (isMock()) {
      // Dev/test-only deterministic stand-in (no real AWS). The frontend never consumes this
      // in tests — suites simulate the browser's PUT via the mock bucket directly.
      return `https://mock-bucket.local/${key}?X-Amz-Mock=1&Expires=${expiresInSeconds}`;
    }
    const command = new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      ContentType: mediaType,
    });
    return await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
  } catch (error) {
    logger.error({ err: error }, "s3.getSignedPutUrl failed");
    throw ApiError.internal("Image storage unavailable");
  }
};

// Generates a short-lived presigned GET URL for an OWNED image object (chat-history
// reconstruction). The URL is minted on demand by the backend after ownership verification —
// it is never persisted and never stored on any document, and the bucket/object stays
// private (the URL is scoped to exactly one server-owned key, one method GET, one expiry).
export const getSignedGetUrl = async ({ key, expiresInSeconds }) => {
  try {
    if (isMock()) {
      // Dev/test-only deterministic stand-in (no real AWS). `expiresInSeconds` mirrors the
      // real handler so regression suites can assert the TTL contract.
      return `https://mock-bucket.local/${key}?X-Amz-Mock=1&Expires=${expiresInSeconds}`;
    }
    const command = new GetObjectCommand({ Bucket: env.s3Bucket, Key: key });
    return await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
  } catch (error) {
    logger.error({ err: error }, "s3.getSignedGetUrl failed");
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

export default {
  putObject,
  getObject,
  headObject,
  deleteObject,
  getSignedPutUrl,
  getSignedGetUrl,
  buildObjectKey,
};