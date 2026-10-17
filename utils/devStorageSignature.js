import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

// ADR-024 (plan A8) — signatures for the dev-only upload receiver (routes/devStorage.js), which stands
// in for S3 presigned URLs in the hermetic e2e harness. A URL grants exactly what an S3 presigned URL
// grants: one method, one object key, one content type (PUT only) and an expiry. The signature is an
// HMAC-SHA256 over those fields with SESSION_JWT_SECRET, so a browser cannot widen it. Nothing here is
// reachable in production: s3.service.js signs receiver URLs only when isDevStorageReceiverEnabled().

const DEV_STORAGE_PATH = "/__dev/storage";

const secret = () => {
  const value = env.sessionJwtSecret;
  if (!value || typeof value !== "string" || value.length < 16) {
    throw new Error("SESSION_JWT_SECRET is not configured (dev storage receiver)");
  }
  return value;
};

const canonical = ({ method, key, contentType, exp }) =>
  ["vivasayi-dev-storage-v1", String(method).toUpperCase(), String(key), String(contentType || ""), String(exp)].join("\n");

export const signDevStorage = ({ method, key, contentType = "", exp }) =>
  createHmac("sha256", secret()).update(canonical({ method, key, contentType, exp })).digest("base64url");

// Object keys the receiver accepts: exactly the layouts the presign paths create (s3.service
// buildObjectKey): `<prefix>/<cognitoSub>/<img_uuid>/image.<ext>` (POST /upload/presign, land documents)
// and `<prefix>/claims/<claimId>/<img_uuid>/image.<ext>` (claim evidence). No other path, no dot
// segments, no encoded separators.
const SEGMENT = /^[A-Za-z0-9_.@:-]{1,128}$/;
export const isAllowedDevStorageKey = (key, prefix = env.uploadStoragePrefix) => {
  if (typeof key !== "string" || key.length === 0 || key.length > 400) return false;
  const parts = key.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || !SEGMENT.test(part))) return false;
  if (parts[0] !== prefix) return false;
  const image = /^image\.(jpg|jpeg|png|webp)$/;
  const upload = /^img_[0-9a-f-]{36}$/;
  if (parts.length === 5 && parts[1] === "claims") return /^[0-9a-f]{24}$/.test(parts[2]) && upload.test(parts[3]) && image.test(parts[4]);
  if (parts.length === 4) return parts[1] !== "claims" && upload.test(parts[2]) && image.test(parts[3]);
  return false;
};

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

// The receiver URL for a PUT (with the signed Content-Type) or a GET.
export const buildDevStorageUrl = ({ baseUrl, method, key, contentType = "", expiresInSeconds, now = Date.now() }) => {
  const exp = Math.floor(now / 1000) + Math.max(1, Math.floor(Number(expiresInSeconds) || 0));
  const sig = signDevStorage({ method, key, contentType: method === "PUT" ? contentType : "", exp });
  const params = new URLSearchParams();
  if (method === "PUT") params.set("ct", contentType);
  params.set("exp", String(exp));
  params.set("sig", sig);
  return `${String(baseUrl).replace(/\/+$/, "")}${DEV_STORAGE_PATH}/${encodeKey(key)}?${params.toString()}`;
};

// Checks a request's signature fields. Returns { ok: true } or { ok: false, reason } (a code only).
export const verifyDevStorage = ({ method, key, contentType = "", exp, sig, now = Date.now() }) => {
  const expiry = Number(exp);
  if (!Number.isInteger(expiry) || typeof sig !== "string" || sig.length === 0) return { ok: false, reason: "missing_signature" };
  if (expiry * 1000 <= now) return { ok: false, reason: "expired" };
  let expected;
  try {
    expected = Buffer.from(signDevStorage({ method, key, contentType: method === "PUT" ? contentType : "", exp: expiry }));
  } catch {
    return { ok: false, reason: "not_configured" };
  }
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
};

export default { signDevStorage, verifyDevStorage, buildDevStorageUrl, isAllowedDevStorageKey, DEV_STORAGE_PATH };
export { DEV_STORAGE_PATH };
