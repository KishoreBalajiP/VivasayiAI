// Phase 13.3 — Satellite Provider Adapter error vocabulary (ISOLATED).
//
// A small, bounded classification surface so callers can reason about failures WITHOUT leaking
// provider internals (tokens, signed URLs, response bodies) into results, logs, or evidence.
// Reuses the Phase 13.2 PoC's HTTP classifier where possible instead of duplicating it.

import { SatellitePocError, classifyHttpError } from "../../poc/satellite/satellitePoc.js";

export const SATELLITE_ERROR_KINDS = Object.freeze({
  CONFIG: "CONFIG", // incomplete/missing configuration (e.g. credentials)
  VALIDATION: "VALIDATION", // invalid caller input (geometry, dates, product)
  UNSUPPORTED: "UNSUPPORTED", // recognised request the provider/product cannot fulfil
  AUTH: "AUTH", // 401/403 — authentication/authorization failure
  QUOTA: "QUOTA", // 429 — rate/quota exhausted
  TIMEOUT: "TIMEOUT", // request timed out
  NETWORK: "NETWORK", // connection/DNS failure
  PROVIDER: "PROVIDER", // 4xx/5xx from the provider
  MALFORMED: "MALFORMED", // response shape did not match the documented contract
  INTERNAL: "INTERNAL", // unexpected adapter failure
});

export class SatelliteAdapterError extends Error {
  constructor(message, kind = SATELLITE_ERROR_KINDS.PROVIDER, details = null) {
    super(message);
    this.name = "SatelliteAdapterError";
    this.kind = kind;
    this.details = details;
  }
}

// Normalize both adapter errors and the reused PoC error kinds into the adapter vocabulary.
export const classifyProviderError = (error) => {
  if (error instanceof SatelliteAdapterError) return error.kind;
  if (error instanceof SatellitePocError) {
    return Object.prototype.hasOwnProperty.call(SATELLITE_ERROR_KINDS, error.kind)
      ? error.kind
      : SATELLITE_ERROR_KINDS.PROVIDER;
  }
  const kind = classifyHttpError(error);
  return Object.prototype.hasOwnProperty.call(SATELLITE_ERROR_KINDS, kind)
    ? kind
    : SATELLITE_ERROR_KINDS.PROVIDER;
};

// Only transient, provider-side conditions are retryable. AUTH / QUOTA / VALIDATION / CONFIG /
// UNSUPPORTED / MALFORMED are NEVER retried (requirements §4/§6/§9).
export const isRetryableKind = (kind) =>
  [SATELLITE_ERROR_KINDS.TIMEOUT, SATELLITE_ERROR_KINDS.NETWORK, SATELLITE_ERROR_KINDS.PROVIDER].includes(kind);

export default {
  SATELLITE_ERROR_KINDS,
  SatelliteAdapterError,
  classifyProviderError,
  isRetryableKind,
};
