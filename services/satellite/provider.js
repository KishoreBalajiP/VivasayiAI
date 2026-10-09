// Phase 13.3 — Satellite Provider Adapter Foundation (ISOLATED, production-oriented boundary).
//
// WHAT THIS IS
//   A narrow, provider-agnostic interface over a single, recommended satellite provider
//   (Copernicus Data Space Ecosystem / Sentinel Hub — see PHASE_13_1_SATELLITE_FEASIBILITY_REPORT.md)
//   that: discovers imagery for a validated AOI + bounded window, returns normalized/traceable
//   scene metadata, prepares (and, only when explicitly permitted, executes) a bounded analysis
//   request, reports honestly whether analysis was ACTUALLY executed, and normalizes provider
//   errors / unavailable states.
//
// WHAT THIS IS NOT
//   - NOT wired into claim submission, the deterministic engine, the AI contract, or claim states.
//   - It NEVER persists evidence (see the integration boundary in satelliteAdapter.js).
//   - It NEVER fabricates provider metadata or invents an indicator when data is missing/unusable.
//   - It does NOT silently switch providers, poll without bounds, or download large collections.
//
// REUSE (no duplication)
//   The adapter reuses the Phase 13.2 PoC's *pure, deterministic* primitives — geometry/date
//   validation, scene normalization, bounded HTTP client, NDVI helpers, and the Statistical API
//   request/response contract. Those primitives were already review-verified against the official
//   provider documentation; the adapter adds the production boundary (capabilities, normalized
//   result contract, request correlation, honest processing status) on top. Reusing the PoC does
//   NOT imply the PoC is production-validated: live authenticated processing remains UNVALIDATED
//   until a real authenticated provider response is observed (see the Phase 13.3 report).

import {
  buildStatisticalRequest,
  createHttpClient,
  fetchCdseToken,
  fetchNdviStatistics,
  normalizeScene,
  MAX_SCENES_HARD_CAP,
} from "../../poc/satellite/satellitePoc.js";

import { SatelliteAdapterError, SATELLITE_ERROR_KINDS } from "./errors.js";
import { SATELLITE_PROVIDERS, SATELLITE_ADAPTER_VERSION } from "./config.js";

// --- Provider capability declaration --------------------------------------------------------

// Documented Sentinel-2 L2A / Sentinel-1 GRD product characteristics (ESA/CDSE). These are
// PRODUCT-level facts derived from the collection definition — they do NOT fabricate per-scene
// metadata (per-scene values must come from the provider response or be null).
export const PRODUCT_INFO = Object.freeze({
  "sentinel-2-l2a": Object.freeze({
    productType: "sentinel-2-l2a",
    productLevel: "L2A",
    platformFamily: "Sentinel-2",
    bands: ["B02", "B03", "B04", "B08", "B11", "B12", "SCL"],
    resolutionM: 10,
  }),
  "sentinel-1-grd": Object.freeze({
    productType: "sentinel-1-grd",
    productLevel: "GRD",
    platformFamily: "Sentinel-1",
    bands: ["VV", "VH"],
    resolutionM: 10,
  }),
});

export const DEFAULT_OPTICAL_COLLECTION = "sentinel-2-l2a";
export const DEFAULT_SAR_COLLECTION = "sentinel-1-grd";

// Capabilities are declared per provider so the rest of the system never assumes an operation is
// available just because a request can be constructed.
export const PROVIDER_CAPABILITIES = Object.freeze({
  [SATELLITE_PROVIDERS.CDSE_SENTINEL]: Object.freeze({
    provider: SATELLITE_PROVIDERS.CDSE_SENTINEL,
    discovery: true,
    sarDiscovery: true,
    processing: Object.freeze({
      collection: DEFAULT_OPTICAL_COLLECTION,
      indicator: "NDVI",
      formula: "NDVI = (B08 - B04) / (B08 + B04)",
      bands: Object.freeze({ red: "B04", nir: "B08", mask: "dataMask" }),
      units: "reflectance [0,1] (Sentinel Hub evalscript default; no /10000 rescale)",
      resolutionM: 10,
    }),
    sarProcessing: false, // SAR analysis is a future capability (Phase 13.5)
    anonymousDiscovery: true,
    authenticatedProcessing: true,
  }),
});

export const getProviderCapabilities = (provider) => PROVIDER_CAPABILITIES[provider] || null;

export const isSupportedCollection = (collection) =>
  Object.prototype.hasOwnProperty.call(PRODUCT_INFO, collection);

// --- Scene normalization (provider-neutral, traceable) --------------------------------------

const CLOUD_SOURCES = ["eo:cloud_cover", "s2:cloud_cover", "cloud_cover"];

const pickCloudSource = (properties) => {
  for (const source of CLOUD_SOURCES) {
    if (Number.isFinite(Number(properties?.[source]))) {
      return { source, value: Number(properties[source]) };
    }
  }
  return { source: null, value: null };
};

// Normalize a raw STAC feature into a provider-neutral descriptor that preserves ACTUAL provider
// metadata. Fields the provider did not return are left null — never invented. Reuses the PoC's
// normalizeScene for the shared, already-reviewed field extraction.
export const normalizeDiscoveryScene = (feature, { provider, collection, queryWindow = null } = {}) => {
  const base = normalizeScene(feature, { provider, collection });
  const info = PRODUCT_INFO[collection] || null;
  const cloud = pickCloudSource(feature?.properties || {});
  const rawBbox = feature?.bbox;

  // NOTE: the Phase 13.2 PoC's normalizeScene maps an ABSENT cloud property to 0 (because
  // Number(null) === 0), which would falsely report a scene as cloud-free. The adapter derives the
  // cloud fraction from the raw provider property here so missing metadata stays null — the PoC is
  // left untouched and this latent PoC bug is recorded in the Phase 13.3 report.
  const cloudCoverFraction = Number.isFinite(cloud.value) ? cloud.value / 100 : null;

  return {
    sceneId: base.id,
    provider: provider || null,
    collection: collection || null,
    productType: info?.productType || collection || null,
    productLevel: info?.productLevel || null,
    platformFamily: info?.platformFamily || null,
    platform: base.platform || null,
    acquisitionTime: base.datetime || null,
    spatialCoverage: Array.isArray(rawBbox) && rawBbox.length === 4 ? rawBbox.slice() : null,
    cloudCoverFraction,
    cloudCoverPercent: Number.isFinite(cloud.value) ? cloud.value : null,
    cloudCoverSource: cloud.source,
    bands: info ? [...info.bands] : null,
    spatialResolutionM: info?.resolutionM ?? null,
    instrumentMode: base.instrumentMode || null,
    orbitState: base.orbitState || null,
    queryWindow: queryWindow ? { start: queryWindow.start, end: queryWindow.end } : null,
    sourceMetadata: {
      collection: typeof feature?.collection === "string" ? feature.collection : collection || null,
      stacVersion: typeof feature?.stac_version === "string" ? feature.stac_version : null,
    },
  };
};

// --- Discovery ------------------------------------------------------------------------------

const clampLimit = (limit) => {
  const numeric = Number(limit) || 10;
  return Math.max(1, Math.min(numeric, MAX_SCENES_HARD_CAP));
};

// Search ONE STAC collection for a bounded window. A response body without a `features` array is
// treated as a MALFORMED provider response (distinct from a successful empty result).
const searchStacCollection = async ({ http, config, collection, bbox, window }) => {
  const body = {
    collections: [collection],
    bbox,
    datetime: `${window.start}/${window.end}`,
    limit: clampLimit(config.maxScenes),
  };
  const response = await http.post(`${config.stacUrl}/search`, body, {
    headers: { "Content-Type": "application/json", Accept: "application/geo+json" },
  });
  const features = response?.data?.features;
  if (!Array.isArray(features)) {
    throw new SatelliteAdapterError(
      "Provider returned a response that did not match the documented STAC contract",
      SATELLITE_ERROR_KINDS.MALFORMED,
      { collection }
    );
  }
  return features.map((feature) =>
    normalizeDiscoveryScene(feature, { provider: config.provider, collection, queryWindow: window })
  );
};

// Discover imagery for the AOI across one or more bounded windows. Returns a NORMALIZED,
// traceable discovery result. Distinguishes an empty successful search (`empty: true`) from an
// API failure (thrown error).
export const discoverImagery = async ({ config, http, aoi, windows, collection, correlationId = null }) => {
  const startedAt = Date.now();
  const scenes = [];
  let requests = 0;

  for (const window of windows) {
    const before = http.stats.count;
    const found = await searchStacCollection({ http, config, collection, bbox: aoi.bbox, window });
    requests += http.stats.count - before;
    scenes.push(...found);
  }

  return {
    provider: config.provider,
    providerVersion: SATELLITE_ADAPTER_VERSION,
    collection,
    productType: PRODUCT_INFO[collection]?.productType || collection,
    spatialCoverage: { bbox: aoi.bbox, crs: "EPSG:4326" },
    queryWindows: windows.map((window) => ({ start: window.start, end: window.end })),
    discoveryTimestamp: new Date().toISOString(),
    correlationId,
    sceneCount: scenes.length,
    empty: scenes.length === 0,
    scenes,
    requestCount: requests,
    durationMs: Date.now() - startedAt,
  };
};

// --- Processing contract (prepare always; execute only when permitted) -----------------------

// Build a BOUNDED, documented Sentinel-2 NDVI processing request descriptor. This PREPARES the
// request shape (reusing the PoC's review-verified Statistical API builder) but does NOT execute
// it. `executed` is always false here — execution is a separate, explicitly gated step.
export const prepareProcessingRequest = ({ config, aoi, window }) => {
  const caps = getProviderCapabilities(config.provider);
  const processing = caps?.processing || null;
  if (!processing) {
    throw new SatelliteAdapterError("Provider does not declare a processing capability", SATELLITE_ERROR_KINDS.UNSUPPORTED);
  }
  const requestShape = buildStatisticalRequest({
    bbox: aoi.bbox,
    start: window.start,
    end: window.end,
    resolution: processing.resolutionM,
  });
  return {
    prepared: true,
    executed: false,
    provider: config.provider,
    collection: processing.collection,
    indicator: processing.indicator,
    formula: processing.formula,
    bands: { ...processing.bands },
    units: processing.units,
    crs: "EPSG:4326",
    window: { start: window.start, end: window.end },
    resolutionM: processing.resolutionM,
    requestShape,
    bounded: {
      singleRequestPerWindow: true,
      maxResolutionM: processing.resolutionM,
      noBulkDownload: true,
    },
  };
};

// Execute a bounded NDVI statistics request. Callers MUST have verified that processing is both
// enabled and credentialed before invoking this. Returns the parsed aggregate statistics.
export const executeNdviProcessing = async ({ config, http, aoi, window }) => {
  const { accessToken, expiresInSeconds } = await fetchCdseToken({ config, http });
  const stats = await fetchNdviStatistics({
    config,
    http,
    accessToken,
    bbox: aoi.bbox,
    start: window.start,
    end: window.end,
  });
  if (!stats?.ok) {
    return { executed: true, ok: false, reason: stats?.reason || "no valid statistics" };
  }
  return {
    executed: true,
    ok: true,
    intervals: stats.intervals,
    redMean: stats.redMean,
    nirMean: stats.nirMean,
    validPixelFraction: stats.validPixelFraction,
    ndvi: stats.ndvi,
    tokenExpiresInSeconds: Number.isFinite(expiresInSeconds) ? expiresInSeconds : null,
  };
};

// --- Provider interface ---------------------------------------------------------------------

// A small provider object exposing exactly the operations the architecture needs. Provider-specific
// transport details stay behind this interface; the orchestrator never touches STAC/Statistical
// request shapes directly.
export const createSatelliteProvider = ({ config, transport } = {}) => {
  if (!config) throw new SatelliteAdapterError("Adapter configuration is required", SATELLITE_ERROR_KINDS.CONFIG);
  const capabilities = getProviderCapabilities(config.provider);
  if (!capabilities) {
    throw new SatelliteAdapterError(`Unsupported satellite provider: ${config.provider}`, SATELLITE_ERROR_KINDS.UNSUPPORTED);
  }
  const http = createHttpClient({
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    transport,
  });

  return {
    name: config.provider,
    capabilities,
    http,
    requestCount: () => http.stats.count,
    discover: ({ aoi, windows, collection, correlationId }) =>
      discoverImagery({ config, http, aoi, windows, collection, correlationId }),
    prepareProcessing: ({ aoi, window }) => prepareProcessingRequest({ config, aoi, window }),
    executeProcessing: ({ aoi, window }) => executeNdviProcessing({ config, http, aoi, window }),
  };
};

export default {
  SATELLITE_PROVIDERS,
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
};
