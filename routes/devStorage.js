import express, { Router } from "express";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { env } from "../config/env.js";
import { getObject, putObject } from "../services/s3.service.js";
import { isAllowedDevStorageKey, verifyDevStorage } from "../utils/devStorageSignature.js";

// ADR-024 (plan A8) — DEV-ONLY stand-in for S3 presigned URLs, used by the hermetic e2e harness so a
// real browser can upload claim photos and land documents with no AWS account.
//
//   PUT /__dev/storage/<key>?ct=<content-type>&exp=<unix s>&sig=<hmac>   store the raw body
//   GET /__dev/storage/<key>?exp=<unix s>&sig=<hmac>                     read it back
//
// It is mounted by app.js through a dynamic import ONLY when isDevStorageReceiverEnabled() (mock
// storage, not production, not Lambda, DEV_STORAGE_RECEIVER=true), before express.json and the auth
// middleware: like S3, the signed URL itself is the capability. The contract mirrors S3's: the
// signature binds method, key, content type and expiry; the request's Content-Type must equal the
// signed one; the body may not exceed the upload limit; only the key layouts the presign endpoints
// create are accepted. Objects go to the mock bucket (services/s3.service.js), file-backed when
// IMAGE_STORAGE_MOCK_DIR is set so a separate worker process can read them.

const router = Router();

const objectKey = (req) => {
  const raw = req.params.key;
  return Array.isArray(raw) ? raw.join("/") : String(raw || "");
};

// Same refusal for every failure (signature, expiry, key, content type): a probe learns nothing.
const refuse = (req, reason) => {
  logger.warn({ requestId: req.requestId ?? null, method: req.method, reason }, "dev_storage.refused");
  return ApiError.forbidden("Upload link is not valid");
};

const authorise = (req, { method, contentType = "" }) => {
  const key = objectKey(req);
  if (!isAllowedDevStorageKey(key)) throw refuse(req, "key_not_allowed");
  const check = verifyDevStorage({ method, key, contentType, exp: req.query.exp, sig: req.query.sig });
  if (!check.ok) throw refuse(req, check.reason);
  return key;
};

router.put(
  "/*key",
  express.raw({ type: () => true, limit: env.imageUploadMaxBytes }),
  async (req, res) => {
    const signedType = typeof req.query.ct === "string" ? req.query.ct : "";
    const key = authorise(req, { method: "PUT", contentType: signedType });
    // As with S3, the Content-Type header must be exactly the one the URL was signed for.
    if (!signedType || req.get("content-type") !== signedType) throw refuse(req, "content_type_mismatch");
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length === 0) throw ApiError.badRequest("Upload body is empty");
    await putObject({ key, buffer: body, mediaType: signedType });
    res.status(200).end();
  }
);

router.get("/*key", async (req, res) => {
  const key = authorise(req, { method: "GET" });
  const found = await getObject(key);
  if (!found) throw ApiError.notFound("Object not found");
  // helmet's default (same-origin) would stop the frontend on another origin from showing the image.
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", "private, no-store");
  res.type(found.mediaType || "application/octet-stream");
  res.status(200).send(found.buffer);
});

export default router;
