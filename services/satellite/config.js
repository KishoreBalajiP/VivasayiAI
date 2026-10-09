// Phase 13.3 — Satellite Provider Adapter Foundation configuration (ISOLATED).
//
// This module is deliberately SEPARATE from config/env.js so the adapter can be imported without
// credentials and without side effects, and so the PoC / adapter / production configuration
// boundaries stay explicit. It NEVER throws at import time, NEVER logs secrets, and is NOT
// referenced by any live claim/verification flow.
//
// Credential variables intentionally reuse the names already established by the Phase 13.2 PoC
// (`CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET`, with the `SENTINEL_HUB_*` aliases) so operators never
// have to provision the same secret twice. Non-secret knobs use `SATELLITE_*` names and fall back
// to the PoC's `SATELLITE_POC_*` names where one already exists.

export const SATELLITE_ADAPTER_VERSION = "13.3.0";

// Provider identifiers. Kept deliberately small — no generic framework, no multiple providers
// without a demonstrated requirement (Phase 13.1: CDSE is the recommended initial provider).
export const SATELLITE_PROVIDERS = Object.freeze({
  CDSE_SENTINEL: "cdse-sentinel",
});

const DEFAULT_STAC_URL = "https://catalogue.dataspace.copernicus.eu/stac";
const DEFAULT_TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const DEFAULT_STATISTICS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics";

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

// First non-empty value across a list of candidate env keys (primary name, then PoC alias).
const pickEnv = (env, keys) => {
  for (const key of keys) {
    const value = clean(env[key]);
    if (value) return value;
  }
  return null;
};

const pickInt = (env, keys, fallback) => {
  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== null && clean(env[key])) {
      return toInt(env[key], fallback);
    }
  }
  return fallback;
};

const pickFloat = (env, keys, fallback) => {
  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== null && clean(env[key])) {
      return toFloat(env[key], fallback);
    }
  }
  return fallback;
};

const pickBool = (env, keys, fallback) => {
  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== null && clean(env[key])) {
      return toBool(env[key], fallback);
    }
  }
  return fallback;
};

// Resolve adapter configuration from an environment-like object (defaults to process.env).
//
// `hasCredentials` is the single source of truth for whether authenticated processing MAY be
// attempted. `processingEnabled` is a SECOND, independent gate: live processing requires BOTH an
// explicit opt-in AND credentials. This guarantees the adapter never silently executes a
// billable/provider call just because a secret happens to be present.
export const resolveSatelliteConfig = (env = process.env) => {
  const provider = pickEnv(env, ["SATELLITE_PROVIDER", "SATELLITE_POC_PROVIDER"]) || SATELLITE_PROVIDERS.CDSE_SENTINEL;
  const clientId = clean(env.CDSE_CLIENT_ID) || clean(env.SENTINEL_HUB_CLIENT_ID);
  const clientSecret = clean(env.CDSE_CLIENT_SECRET) || clean(env.SENTINEL_HUB_CLIENT_SECRET);

  return {
    adapterVersion: SATELLITE_ADAPTER_VERSION,
    provider,
    // Enabled = the adapter may run AT ALL (discovery included). Defaults to true (read-only,
    // anonymous discovery is free); flipping it off disables the adapter entirely.
    enabled: pickBool(env, ["SATELLITE_ENABLED", "SATELLITE_POC_ENABLED"], true),
    // Live authenticated processing is OFF unless explicitly requested AND credentials exist.
    processingEnabled: pickBool(env, ["SATELLITE_PROCESSING_ENABLED"], false),
    requestTimeoutMs: pickInt(env, ["SATELLITE_REQUEST_TIMEOUT_MS", "SATELLITE_POC_TIMEOUT_MS"], 8000),
    maxRetries: pickInt(env, ["SATELLITE_MAX_RETRIES", "SATELLITE_POC_MAX_RETRIES"], 1),
    maxScenes: pickInt(env, ["SATELLITE_MAX_SCENES", "SATELLITE_POC_MAX_SCENES"], 10),
    cloudMaxFraction: pickFloat(env, ["SATELLITE_CLOUD_MAX", "SATELLITE_POC_CLOUD_MAX"], 0.3),
    maxWindowDays: pickInt(env, ["SATELLITE_MAX_WINDOW_DAYS", "SATELLITE_POC_MAX_WINDOW_DAYS"], 120),
    stacUrl: pickEnv(env, ["SATELLITE_STAC_URL", "SATELLITE_POC_STAC_URL"]) || DEFAULT_STAC_URL,
    tokenUrl: pickEnv(env, ["SATELLITE_TOKEN_URL", "SATELLITE_POC_TOKEN_URL"]) || DEFAULT_TOKEN_URL,
    statisticsUrl:
      pickEnv(env, ["SATELLITE_STATISTICS_URL", "SATELLITE_POC_STATISTICS_URL"]) || DEFAULT_STATISTICS_URL,
    clientId,
    clientSecret,
    hasCredentials: Boolean(clientId && clientSecret),
  };
};

// Safe, redacted view for logging/reporting/evidence traceability. Never includes secret material
// and never includes the raw client secret — only whether credentials are present.
export const redactSatelliteConfig = (config = {}) => ({
  adapterVersion: config.adapterVersion,
  provider: config.provider,
  enabled: config.enabled,
  processingEnabled: config.processingEnabled,
  requestTimeoutMs: config.requestTimeoutMs,
  maxRetries: config.maxRetries,
  maxScenes: config.maxScenes,
  cloudMaxFraction: config.cloudMaxFraction,
  maxWindowDays: config.maxWindowDays,
  stacUrl: config.stacUrl,
  tokenUrl: config.tokenUrl,
  statisticsUrl: config.statisticsUrl,
  hasCredentials: config.hasCredentials,
});

// A credential-requirement summary suitable for an operator-facing "configuration required"
// outcome. Contains no secret values.
export const describeCredentialRequirement = () => ({
  required: ["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"],
  aliases: ["SENTINEL_HUB_CLIENT_ID", "SENTINEL_HUB_CLIENT_SECRET"],
  processingOptIn: "SATELLITE_PROCESSING_ENABLED",
});

export default resolveSatelliteConfig;
