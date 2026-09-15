import crypto from "node:crypto";
import axios from "axios";
import logger from "./logger.js";

// E1-S2: Cognito ID-token verification support.
//
// AWS Cognito ID tokens are RS256-signed by a user pool whose public keys are published at
//   https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json
// The token's `iss` claim is that base URL and its `aud` is the app client id. Because the exact
// user pool id is not stored in config (env only carries the custom mapped `cognitoDomain`, which
// is the OAuth domain alias, NOT the token issuer), the JWKS endpoint is derived from the token's
// `iss` claim — but ONLY after strictly constraining `iss` to the AWS Cognito issuer family and
// always fetching over HTTPS with a bounded timeout. Signature verification against the published
// key + RS256-only + audience + expiry (in token.js) is what proves authenticity: a forged or
// wrong-issuer token cannot be signed by a real pool's private key and is rejected.
//
// Keys are cached per-issuer for JWKS_TTL_MS and only fetched on a cold cache or on an unknown
// `kid` (key rotation). Any fetch/key error fails closed (returns null) — never a partial result.

const COGNITO_ISSUER_PATTERN =
  /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/([A-Za-z0-9_-]+)\/?$/;

const JWKS_TTL_MS = 60 * 60 * 1000; // cache signing keys, rotating hourly at most
const FETCH_TIMEOUT_MS = 5000;

// issuer -> { keys: Map<kid, jwk>, fetchedAt: number }
const cache = new Map();

const isCognitoIssuer = (iss) =>
  typeof iss === "string" && COGNITO_ISSUER_PATTERN.test(iss);

const jwksUrl = (iss) => `${iss.replace(/\/+$/, "")}/.well-known/jwks.json`;

// Default HTTPS fetcher via the already-present `axios` dependency. Overridable for offline tests
// only (see _setFetcher); production always uses HTTPS with a bounded timeout.
let httpGet = async (url) => {
  const res = await axios.get(url, { timeout: FETCH_TIMEOUT_MS });
  return res.data;
};

// Test seam — swaps the network fetcher. Never called in production.
const _setFetcher = (fn) => {
  if (typeof fn === "function") httpGet = fn;
};

// Test seam — clears the in-memory JWKS cache.
const _clearCache = () => cache.clear();

const getJwks = async (issuer) => {
  const now = Date.now();
  const cached = cache.get(issuer);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached;
  try {
    const data = await httpGet(jwksUrl(issuer));
    const keys = new Map();
    for (const k of data?.keys || []) {
      if (k && k.kid && k.kty === "RSA" && k.n && k.e) keys.set(k.kid, k);
    }
    const entry = { keys, fetchedAt: now };
    cache.set(issuer, entry);
    return entry;
  } catch (error) {
    logger.warn({ issuer }, "jwks.fetch_failed");
    return null;
  }
};

const getKey = async (issuer, kid) => {
  let entry = await getJwks(issuer);
  if (!entry) return null;

  let jwk = entry.keys.get(kid);
  if (!jwk) {
    // Unknown kid -> the cache may predate a key rotation; refresh once before failing.
    cache.delete(issuer);
    entry = await getJwks(issuer);
    if (!entry) return null;
    jwk = entry.keys.get(kid);
  }
  if (!jwk) return null;

  try {
    return crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return null;
  }
};

export { isCognitoIssuer, jwksUrl, getKey, _setFetcher, _clearCache };
