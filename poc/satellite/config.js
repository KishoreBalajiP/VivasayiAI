// Phase 13.2 — Satellite PoC configuration (ISOLATED, non-production).
//
// This module is deliberately SEPARATE from config/env.js. It never throws at import time (the PoC
// must be importable without credentials), never logs secrets, and is never referenced by the live
// claim/verification flow. Credentials, if any, are read only from the process environment via
// PoC-specific variable names so a live secret can never be confused with a production key.
//
// Primary provider (per PHASE_13_1_SATELLITE_FEASIBILITY_REPORT.md): Copernicus Data Space
// Ecosystem (CDSE). Its public STAC catalogue can be searched anonymously; pixel-level processing
// (Sentinel Hub Statistical API) requires OAuth2 client credentials, which are NOT configured.

export const SATELLITE_POC_VERSION = "13.2.0";

export const POC_PROVIDERS = Object.freeze({
  CDSE: "cdse",
  PLANETARY_COMPUTER: "planetary-computer",
});

const DEFAULT_CDSE_TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const DEFAULT_CDSE_STAC_URL = "https://catalogue.dataspace.copernicus.eu/stac";
const DEFAULT_CDSE_STATISTICS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";
const DEFAULT_PC_STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1";

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const clean = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

// Resolve the PoC configuration from an environment-like object (defaults to process.env).
// Returns a plain object. `hasCdseCredentials` is the single source of truth for whether live
// Sentinel Hub processing may be attempted. Secrets are held but never serialized by the PoC.
export const resolvePocConfig = (env = process.env) => {
  const provider = clean(env.SATELLITE_POC_PROVIDER) || POC_PROVIDERS.CDSE;
  const clientId = clean(env.CDSE_CLIENT_ID) || clean(env.SENTINEL_HUB_CLIENT_ID);
  const clientSecret = clean(env.CDSE_CLIENT_SECRET) || clean(env.SENTINEL_HUB_CLIENT_SECRET);

  return {
    pocVersion: SATELLITE_POC_VERSION,
    provider,
    enabled: toBool(env.SATELLITE_POC_ENABLED, true),
    allowPublicFallback: toBool(env.SATELLITE_POC_ALLOW_PUBLIC_FALLBACK, true),
    requestTimeoutMs: toInt(env.SATELLITE_POC_TIMEOUT_MS, 8000),
    maxRetries: toInt(env.SATELLITE_POC_MAX_RETRIES, 1),
    maxScenes: toInt(env.SATELLITE_POC_MAX_SCENES, 10),
    cloudMaxFraction: toFloat(env.SATELLITE_POC_CLOUD_MAX, 0.3),
    stacUrl: clean(env.SATELLITE_POC_STAC_URL) || DEFAULT_CDSE_STAC_URL,
    tokenUrl:
      clean(env.SATELLITE_POC_TOKEN_URL) ||
      (provider === POC_PROVIDERS.PLANETARY_COMPUTER
        ? null
        : DEFAULT_CDSE_TOKEN_URL),
    statisticsUrl:
      clean(env.SATELLITE_POC_STATISTICS_URL) || DEFAULT_CDSE_STATISTICS_URL,
    fallbackStacUrl: clean(env.SATELLITE_POC_FALLBACK_STAC_URL) || DEFAULT_PC_STAC_URL,
    clientId,
    clientSecret,
    hasCdseCredentials: Boolean(clientId && clientSecret),
  };
};

// Safe, redacted view of the config for logging/reporting. Never includes secret material.
export const redactPocConfig = (config) => ({
  pocVersion: config.pocVersion,
  provider: config.provider,
  enabled: config.enabled,
  allowPublicFallback: config.allowPublicFallback,
  requestTimeoutMs: config.requestTimeoutMs,
  maxRetries: config.maxRetries,
  maxScenes: config.maxScenes,
  cloudMaxFraction: config.cloudMaxFraction,
  stacUrl: config.stacUrl,
  tokenUrl: config.tokenUrl,
  statisticsUrl: config.statisticsUrl,
  fallbackStacUrl: config.fallbackStacUrl,
  hasCdseCredentials: config.hasCdseCredentials,
});

export default resolvePocConfig;
