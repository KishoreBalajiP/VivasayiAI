// Phase 13.3 — Satellite Provider Adapter Foundation — public module surface (ISOLATED).
//
// This directory is the ONLY satellite integration surface. It is additive and not referenced by
// any live claim/verification flow. Import from here rather than reaching into the submodules.

export {
  SATELLITE_ADAPTER_VERSION,
  SATELLITE_PROVIDERS,
  resolveSatelliteConfig,
  redactSatelliteConfig,
  describeCredentialRequirement,
} from "./config.js";

export {
  SATELLITE_ERROR_KINDS,
  SatelliteAdapterError,
  classifyProviderError,
  isRetryableKind,
} from "./errors.js";

export {
  PRODUCT_INFO,
  PROVIDER_CAPABILITIES,
  DEFAULT_OPTICAL_COLLECTION,
  DEFAULT_SAR_COLLECTION,
  getProviderCapabilities,
  isSupportedCollection,
  normalizeDiscoveryScene,
  discoverImagery,
  prepareProcessingRequest,
  executeNdviProcessing,
  createSatelliteProvider,
} from "./provider.js";

export {
  SATELLITE_OUTCOMES,
  SATELLITE_PROCESSING_STATUS,
  SATELLITE_MODES,
  EVIDENCE_STATUS_BY_OUTCOME,
  mapOutcomeToEvidenceStatus,
  resolveWindows,
  adapterCapabilities,
  toVerificationEvidence,
  runSatelliteAnalysis,
} from "./satelliteAdapter.js";
