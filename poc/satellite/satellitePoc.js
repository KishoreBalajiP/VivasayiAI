// Phase 13.2 — Satellite Verification Proof of Concept (ISOLATED, non-production).
//
// WHAT THIS IS
//   A bounded, read-only feasibility PoC that validates the Phase 13.1 architecture findings for
//   Copernicus Sentinel-2 (optical) and Sentinel-1 (SAR) verification. It discovers imagery from
//   the Copernicus Data Space Ecosystem (CDSE) public STAC catalogue and, when OAuth2 client
//   credentials are present, would compute a pre/post NDVI comparison via the Sentinel Hub
//   Statistical API.
//
// WHAT THIS IS NOT (hard boundaries — see PHASE_13_2_SATELLITE_POC_REPORT.md)
//   - NOT wired into claim submission or the verification engine.
//   - NEVER modifies a claim, its status, or any production model/route/service.
//   - NEVER calculates or replaces authoritative area; it reuses services/parcelGeometry.service.js
//     READ-ONLY only to document the synthetic test parcel's approximate extent.
//   - NEVER fabricates provider data: absent/no data is reported as such, never as a negative
//     agricultural finding.
//   - NEVER prints, logs, or persists credentials.
//   - Satellite output is EXPERIMENTAL, SUPPORTING evidence at evidence-level status only. It can
//     never map to a claim lifecycle state.
//
// DATA-FLOW (all optional deps injected for deterministic tests):
//   config -> validate AOI/window -> discover scenes (CDSE STAC) -> [optional] NDVI statistics
//          -> classify outcome -> build proposed SATELLITE evidence payload (not persisted).

import axios from "axios";
import crypto from "node:crypto";

import { validateParcelGeometry } from "../../services/parcelGeometry.service.js";
import {
  EVIDENCE_STATUSES,
  buildVerificationEvidence,
} from "../../utils/verificationEvidence.js";

import { resolvePocConfig, redactPocConfig, POC_PROVIDERS, SATELLITE_POC_VERSION } from "./config.js";

export { resolvePocConfig, redactPocConfig, POC_PROVIDERS, SATELLITE_POC_VERSION };

export const SATELLITE_POC_USER_AGENT = "Vivasayiai-Satellite-PoC/13.2 (non-production feasibility)";
export const DEFAULT_COLLECTION_S2 = "sentinel-2-l2a";
export const DEFAULT_COLLECTION_S1 = "sentinel-1-grd";

// Bounded request budget — the PoC must never perform an unbounded search or download.
export const MAX_WINDOW_SPAN_DAYS = 120;
export const MAX_SCENES_HARD_CAP = 25;

export const POC_MODES = Object.freeze({
  LIVE: "live", // discovery + processing succeeded
  DISCOVERY_ONLY: "discovery-only", // imagery discovered, processing not attempted/available
  BLOCKED: "blocked", // no usable data retrieved
});

// Outcome vocabulary — deliberately richer than the evidence vocabulary because it must
// distinguish discovery / retrieval / quality / coverage / cloud / missing / provider / auth /
// quota / analysis / inconclusive failures (Phase 13.2 requirement).
export const POC_OUTCOMES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  CONFIG_DISABLED: "CONFIG_DISABLED",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  TIMEOUT: "TIMEOUT",
  IMAGERY_UNAVAILABLE: "IMAGERY_UNAVAILABLE",
  IMAGERY_FOUND: "IMAGERY_FOUND",
  CLOUD_OBSCURED: "CLOUD_OBSCURED",
  INSUFFICIENT_TEMPORAL_COVERAGE: "INSUFFICIENT_TEMPORAL_COVERAGE",
  ANALYSIS_COMPLETE: "ANALYSIS_COMPLETE",
  INCONCLUSIVE: "INCONCLUSIVE",
});

// Map a PoC outcome to the EXISTING evidence-level status vocabulary (Phase 11). This mapping is
// one-way and read-only: an evidence status is never a claim state.
export const EVIDENCE_STATUS_BY_OUTCOME = Object.freeze({
  [POC_OUTCOMES.INVALID_INPUT]: "NOT_CHECKED",
  [POC_OUTCOMES.CONFIG_DISABLED]: "NOT_CHECKED",
  [POC_OUTCOMES.AUTH_REQUIRED]: "UNAVAILABLE",
  [POC_OUTCOMES.QUOTA_EXCEEDED]: "UNAVAILABLE",
  [POC_OUTCOMES.PROVIDER_ERROR]: "UNAVAILABLE",
  [POC_OUTCOMES.TIMEOUT]: "UNAVAILABLE",
  [POC_OUTCOMES.IMAGERY_UNAVAILABLE]: "UNAVAILABLE",
  [POC_OUTCOMES.IMAGERY_FOUND]: "PENDING",
  [POC_OUTCOMES.CLOUD_OBSCURED]: "INSUFFICIENT",
  [POC_OUTCOMES.INSUFFICIENT_TEMPORAL_COVERAGE]: "INSUFFICIENT",
  [POC_OUTCOMES.ANALYSIS_COMPLETE]: "AVAILABLE",
  [POC_OUTCOMES.INCONCLUSIVE]: "INSUFFICIENT",
});

const OUTCOME_BY_ERROR_KIND = Object.freeze({
  AUTH: POC_OUTCOMES.AUTH_REQUIRED,
  QUOTA: POC_OUTCOMES.QUOTA_EXCEEDED,
  TIMEOUT: POC_OUTCOMES.TIMEOUT,
  NETWORK: POC_OUTCOMES.PROVIDER_ERROR,
  PROVIDER: POC_OUTCOMES.PROVIDER_ERROR,
  CONFIG: POC_OUTCOMES.AUTH_REQUIRED,
});

export const mapOutcomeToEvidenceStatus = (outcome) =>
  EVIDENCE_STATUS_BY_OUTCOME[outcome] || "UNAVAILABLE";

// A structured PoC error carrying a bounded `kind` so callers can classify failures without
// leaking provider internals (e.g. tokens, signed URLs) into results or logs.
export class SatellitePocError extends Error {
  constructor(message, kind = "PROVIDER", details = null) {
    super(message);
    this.name = "SatellitePocError";
    this.kind = kind;
    this.details = details;
  }
}

// --- Pure scientific helpers ---------------------------------------------------------------

// Sentinel-2 NDVI = (NIR - Red) / (NIR + Red) = (B08 - B04) / (B08 + B04). Pure; returns null for
// non-finite inputs or a zero denominator. Values are reflectance (0..1) or any consistent scale.
export const computeNdvi = (red, nir) => {
  const r = Number(red);
  const n = Number(nir);
  if (!Number.isFinite(r) || !Number.isFinite(n)) return null;
  const denominator = n + r;
  if (denominator === 0) return null;
  return (n - r) / denominator;
};

// NDVI from band MEANS (ratio of means). This is a documented approximation of the mean of the
// per-pixel ratios and is only used when the Statistical API returns aggregate band statistics.
export const ndviFromBandMeans = ({ redMean, nirMean } = {}) => computeNdvi(redMean, nirMean);

export const ndviDelta = (before, after) => {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  return after - before;
};

// --- Validation ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

// Validate a bounded [start, end] ISO date range. Rejects unparseable dates, reversed ranges,
// windows ending in the future, and windows longer than MAX_WINDOW_SPAN_DAYS.
export const validateDateRange = ({
  start,
  end,
  now = new Date(),
  maxSpanDays = MAX_WINDOW_SPAN_DAYS,
} = {}) => {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs)) return { ok: false, reason: "start must be a valid ISO date" };
  if (!Number.isFinite(endMs)) return { ok: false, reason: "end must be a valid ISO date" };
  if (startMs > endMs) return { ok: false, reason: "start must not be after end" };
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isFinite(nowMs) && startMs > nowMs) {
    return { ok: false, reason: "range start must not be in the future" };
  }
  const spanDays = (endMs - startMs) / DAY_MS;
  if (spanDays > maxSpanDays) {
    return { ok: false, reason: `range exceeds the ${maxSpanDays}-day PoC bound` };
  }
  return { ok: true, spanDays: Math.round(spanDays) };
};

// Validate a GeoJSON polygon with the EXISTING authoritative geometry validator and derive a
// bounding box + approximate extent. Read-only: never persists and never replaces production area.
export const validateAoi = (geometry) => {
  const result = validateParcelGeometry(geometry);
  if (!result.ok) return { ok: false, reason: result.reason };

  const ring = geometry.coordinates[0];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  // Approximate the extent in metres at the AOI's mean latitude (equirectangular approximation).
  const meanLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const metresPerDegLat = 111320;
  const metresPerDegLon = 111320 * Math.cos(meanLatRad);
  const widthMeters = Math.round((maxLon - minLon) * metresPerDegLon);
  const heightMeters = Math.round((maxLat - minLat) * metresPerDegLat);

  return {
    ok: true,
    acres: result.acres,
    bbox: [minLon, minLat, maxLon, maxLat],
    extentMeters: { width: widthMeters, height: heightMeters },
  };
};

// A stable, non-PII fingerprint of the AOI used as a traceable evidence reference.
export const fingerprintAoi = (geometry) => {
  try {
    return crypto.createHash("sha1").update(JSON.stringify(geometry)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
};

// --- HTTP boundary with bounded retries -----------------------------------------------------

// Classify a thrown HTTP/transport error into a bounded, provider-agnostic kind.
export const classifyHttpError = (error) => {
  if (!error) return "PROVIDER";
  const code = error.code || error.cause?.code;
  const message = String(error.message || "");
  if (code === "ECONNABORTED" || code === "ETIMEDOUT" || /timeout/i.test(message)) return "TIMEOUT";
  const status = error.response?.status ?? error.status;
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "QUOTA";
  if (typeof status === "number" && status >= 500) return "PROVIDER";
  if (typeof status === "number" && status >= 400) return "PROVIDER";
  if (
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN" ||
    !error.response
  ) {
    return "NETWORK";
  }
  return "PROVIDER";
};

const isRetryableError = (error) => {
  const kind = classifyHttpError(error);
  if (kind === "TIMEOUT" || kind === "NETWORK") return true;
  const status = error?.response?.status ?? error?.status;
  return typeof status === "number" && status >= 500;
};

const toPocError = (error) => {
  if (error instanceof SatellitePocError) return error;
  const kind = classifyHttpError(error);
  return new SatellitePocError(`Satellite provider request failed (${kind})`, kind);
};

const buildAxiosTransport = (timeoutMs) => {
  const client = axios.create({
    timeout: timeoutMs,
    headers: { "User-Agent": SATELLITE_POC_USER_AGENT },
  });
  return {
    get: (url, options) => client.get(url, options).then((r) => ({ status: r.status, data: r.data })),
    post: (url, data, options) =>
      client.post(url, data, options).then((r) => ({ status: r.status, data: r.data })),
  };
};

// Wrap a transport with an explicit timeout policy and a BOUNDED retry count (retries only on
// timeout/network/5xx). Returns { get, post, stats }. `stats.attempts` counts real HTTP attempts.
export const createHttpClient = ({ timeoutMs = 8000, maxRetries = 1, transport } = {}) => {
  const attempts = { count: 0 };
  const base = transport || buildAxiosTransport(timeoutMs);
  const retries = Math.max(0, Math.min(Number(maxRetries) || 0, 3));

  const call = async (method, ...args) => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      attempts.count += 1;
      try {
        return await base[method](...args);
      } catch (error) {
        lastError = error;
        if (attempt < retries && isRetryableError(error)) continue;
        throw toPocError(error);
      }
    }
    throw toPocError(lastError);
  };

  return {
    get: (...args) => call("get", ...args),
    post: (...args) => call("post", ...args),
    stats: attempts,
  };
};

// --- Provider operations --------------------------------------------------------------------

// CDSE Sentinel Hub OAuth2 client-credentials token. Requires configured credentials; throws a
// CONFIG-kind error otherwise so no network call is made without credentials.
export const fetchCdseToken = async ({ config, http }) => {
  if (!config.clientId || !config.clientSecret) {
    throw new SatellitePocError("CDSE credentials are not configured", "CONFIG");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  }).toString();
  const response = await http.post(config.tokenUrl, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const token = response?.data?.access_token;
  if (!token) throw new SatellitePocError("CDSE token endpoint returned no access token", "AUTH");
  return { accessToken: token, expiresInSeconds: Number(response?.data?.expires_in) || null };
};

const pick = (object, keys) => {
  if (!object) return null;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
};

// Normalize a STAC feature into a small, safe scene descriptor. Raw feature bodies are never
// retained (they can be large and contain asset URLs the PoC must not store).
export const normalizeScene = (feature, { provider, collection } = {}) => {
  const properties = feature?.properties || {};
  // Providers report cloud cover as a percentage (0..100); normalise to a 0..1 fraction so the
  // configured threshold is provider-agnostic.
  const rawCloud = pick(properties, ["eo:cloud_cover", "s2:cloud_cover", "cloud_cover"]);
  const cloudCover = Number.isFinite(Number(rawCloud)) ? Number(rawCloud) / 100 : null;
  return {
    id: feature?.id || null,
    collection: collection || null,
    provider: provider || null,
    datetime: properties.datetime || null,
    cloudCover,
    platform: properties.platform || null,
    instrumentMode: pick(properties, ["sar:instrument_mode", "s1:instrument_mode"]),
    orbitState: pick(properties, ["sat:orbit_state", "s1:orbit_state"]),
  };
};

// Search a STAC `/search` endpoint. `endpoint` is a full URL; `extra` allows provider-specific
// body fields. Bounded by `limit`.
export const searchScenes = async ({
  http,
  endpoint,
  provider,
  collection,
  bbox,
  start,
  end,
  limit = 10,
  extra = {},
}) => {
  const body = {
    collections: [collection],
    bbox,
    datetime: `${start}/${end}`,
    limit: Math.min(Math.max(1, Number(limit) || 10), MAX_SCENES_HARD_CAP),
    ...extra,
  };
  const response = await http.post(endpoint, body, {
    headers: { "Content-Type": "application/json", Accept: "application/geo+json" },
  });
  const features = Array.isArray(response?.data?.features) ? response.data.features : [];
  return features.map((feature) => normalizeScene(feature, { provider, collection }));
};

// Sentinel Hub Statistical API request body (documented shape). Deferred from live execution when
// credentials are absent. Kept small and bounded (explicit resolution + time range).
export const buildStatisticalRequest = ({ bbox, start, end, maxCloudCoverage = 30, resolution = 10 }) => ({
  input: {
    bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
    data: [
      {
        type: DEFAULT_COLLECTION_S2,
        dataFilter: { maxCloudCoverage, timeRange: { from: start, to: end } },
      },
    ],
  },
  aggregation: {
    timeRange: { from: start, to: end },
    aggregationInterval: { of: "P1D" },
    resx: resolution,
    resy: resolution,
    evalscript: [
      "//VERSION=3",
      "function setup() { return { input: ['B04','B08','dataMask'], output: { bands: 3, sampleType: 'FLOAT32' } }; }",
      "function evaluatePixel(s) { return [s.B04, s.B08, s.dataMask]; }",
    ].join("\n"),
  },
  calculations: { default: {} },
});

// Parse a Sentinel Hub Statistical API response into aggregate band means + a valid-pixel
// fraction. Defensive: accepts the documented `outputs.default.bands` shape and tolerates missing
// intervals by ignoring them.
export const parseStatisticalResponse = (response) => {
  const data = Array.isArray(response?.data) ? response.data : [];
  const intervals = [];
  for (const entry of data) {
    const bands = entry?.outputs?.default?.bands || entry?.bands;
    if (!bands) continue;
    const red = bands.B0?.stats?.mean;
    const nir = bands.B1?.stats?.mean;
    const mask = bands.B2?.stats?.mean;
    if (Number.isFinite(red) && Number.isFinite(nir)) {
      intervals.push({ red, nir, validFraction: Number.isFinite(mask) ? mask : null });
    }
  }
  if (intervals.length === 0) {
    return { ok: false, reason: "no valid band statistics in Statistical API response" };
  }
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const redMean = mean(intervals.map((entry) => entry.red));
  const nirMean = mean(intervals.map((entry) => entry.nir));
  const validFractions = intervals
    .map((entry) => entry.validFraction)
    .filter((value) => Number.isFinite(value));
  return {
    ok: true,
    intervals: intervals.length,
    redMean,
    nirMean,
    validPixelFraction: validFractions.length ? mean(validFractions) : null,
    ndvi: ndviFromBandMeans({ redMean, nirMean }),
  };
};

export const fetchNdviStatistics = async ({ config, http, accessToken, bbox, start, end }) => {
  const body = buildStatisticalRequest({ bbox, start, end });
  const response = await http.post(config.statisticsUrl, body, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  return parseStatisticalResponse(response);
};

// --- Evidence contract compatibility --------------------------------------------------------

// Build a PROPOSED canonical SATELLITE evidence payload (source=SATELLITE, operative=false) via
// the Phase 11 foundation. Never persisted by the PoC; demonstrates the future integration shape.
export const buildSatelliteEvidencePayload = ({
  config,
  outcome,
  aoiMeta = null,
  observedAt = null,
  metadata = {},
  result = null,
  confidence = null,
} = {}) => {
  const status = mapOutcomeToEvidenceStatus(outcome);
  const evidence = buildVerificationEvidence({
    source: "SATELLITE",
    status,
    confidence,
    observedAt,
    provider: config?.provider || null,
    providerVersion: config?.pocVersion || null,
    evidenceVersion: SATELLITE_POC_VERSION,
    evaluationVersion: "poc-ndvi-v1",
    reference: aoiMeta?.fingerprint || null,
    metadata: {
      poc: true,
      outcome,
      provider: config?.provider || null,
      collections: metadata.collections || null,
      sceneCount: metadata.sceneCount ?? null,
      ...metadata.metadata,
    },
    result,
  });
  return evidence;
};

// --- Orchestration --------------------------------------------------------------------------

const safeSceneSort = (scenes) =>
  [...scenes].sort((a, b) => (Date.parse(a.datetime) || 0) - (Date.parse(b.datetime) || 0));

// Remove duplicate scenes by provider id (windows can overlap); keep the first occurrence.
const dedupeScenes = (scenes) => {
  const seen = new Set();
  return scenes.filter((scene) => {
    if (!scene?.id) return true;
    if (seen.has(scene.id)) return false;
    seen.add(scene.id);
    return true;
  });
};

const leastCloudy = (scenes) => {
  const withCloud = scenes.filter((scene) => Number.isFinite(scene.cloudCover));
  const pool = withCloud.length ? withCloud : scenes;
  return pool.reduce(
    (best, scene) => (!best || (scene.cloudCover ?? Infinity) < (best.cloudCover ?? Infinity) ? scene : best),
    null
  );
};

// Run the bounded PoC. Returns a structured result; it NEVER throws for expected provider/quality
// failures (those become outcomes) and NEVER writes anything.
export const runPoc = async ({
  config = resolvePocConfig(),
  aoi,
  eventDate = null,
  preWindow,
  postWindow,
  transport,
} = {}) => {
  const http = createHttpClient({
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    transport,
  });
  const startedAt = Date.now();
  const notes = [];

  const finish = (partial) => {
    const outcome = partial.outcome || POC_OUTCOMES.INCONCLUSIVE;
    const evidenceStatus = mapOutcomeToEvidenceStatus(outcome);
    const aoiMeta = partial.aoi || null;
    const result = {
      ...partial,
      outcome,
      evidenceStatus,
      pocVersion: SATELLITE_POC_VERSION,
      provider: config.provider,
      config: redactPocConfig(config),
      requestCount: http.stats.count,
      durationMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      notes,
      evidencePayload: buildSatelliteEvidencePayload({
        config,
        outcome,
        aoiMeta,
        observedAt: partial.observedAt || null,
        metadata: {
          collections: partial.collections || null,
          sceneCount: partial.sceneCount ?? null,
          metadata: {
            opticalSceneCount: partial.optical?.scenes?.length ?? 0,
            sarSceneCount: partial.sar?.scenes?.length ?? 0,
          },
        },
        result: partial.evidenceResult || null,
      }),
    };
    return result;
  };

  if (!config.enabled) {
    notes.push("Satellite PoC is disabled by configuration.");
    return finish({ outcome: POC_OUTCOMES.CONFIG_DISABLED, mode: POC_MODES.BLOCKED });
  }

  // 1) Validate AOI.
  const aoiValidation = validateAoi(aoi);
  if (!aoiValidation.ok) {
    notes.push("AOI rejected by the existing geometry validator.");
    return finish({ outcome: POC_OUTCOMES.INVALID_INPUT, mode: POC_MODES.BLOCKED, message: aoiValidation.reason });
  }
  const aoiMeta = {
    acres: aoiValidation.acres,
    bbox: aoiValidation.bbox,
    extentMeters: aoiValidation.extentMeters,
    fingerprint: fingerprintAoi(aoi),
  };

  // 2) Validate windows.
  const preCheck = validateDateRange(preWindow);
  const postCheck = validateDateRange(postWindow);
  if (!preCheck.ok || !postCheck.ok) {
    notes.push("Pre/post window rejected by the PoC date-range validator.");
    return finish({
      outcome: POC_OUTCOMES.INVALID_INPUT,
      mode: POC_MODES.BLOCKED,
      aoi: aoiMeta,
      message: preCheck.ok ? postCheck.reason : preCheck.reason,
    });
  }

  const unionStart = preWindow.start;
  const unionEnd = postWindow.end;
  const searchEndpoint = `${config.stacUrl}/search`;

  // 3) Discover optical scenes (primary provider) for the pre and post windows SEPARATELY so a
  // pre/post comparison has scenes on both sides. Bounded: one request per window.
  const opticalScenes = [];
  try {
    for (const window of [preWindow, postWindow]) {
      const scenes = await searchScenes({
        http,
        endpoint: searchEndpoint,
        provider: config.provider,
        collection: DEFAULT_COLLECTION_S2,
        bbox: aoiMeta.bbox,
        start: window.start,
        end: window.end,
        limit: config.maxScenes,
      });
      opticalScenes.push(...scenes);
    }
  } catch (error) {
    const kind = error instanceof SatellitePocError ? error.kind : classifyHttpError(error);
    notes.push(`Optical discovery failed (${kind}); no imagery was retrieved.`);
    return finish({
      outcome: OUTCOME_BY_ERROR_KIND[kind] || POC_OUTCOMES.PROVIDER_ERROR,
      mode: POC_MODES.BLOCKED,
      aoi: aoiMeta,
      collections: [DEFAULT_COLLECTION_S2],
      optical: { scenes: [] },
      sar: { scenes: [] },
    });
  }

  // 4) Discover SAR scenes (best-effort — SAR is an optical-cloud mitigation, not a dependency).
  let sarScenes = [];
  try {
    sarScenes = await searchScenes({
      http,
      endpoint: searchEndpoint,
      provider: config.provider,
      collection: DEFAULT_COLLECTION_S1,
      bbox: aoiMeta.bbox,
      start: unionStart,
      end: unionEnd,
      limit: config.maxScenes,
    });
  } catch (error) {
    const kind = error instanceof SatellitePocError ? error.kind : classifyHttpError(error);
    notes.push(`SAR discovery failed (${kind}); SAR is optional and does not block optical analysis.`);
  }

  const collections = [DEFAULT_COLLECTION_S2, DEFAULT_COLLECTION_S1];

  if (opticalScenes.length === 0) {
    notes.push("No optical scenes were returned for the AOI/windows.");
    return finish({
      outcome: POC_OUTCOMES.IMAGERY_UNAVAILABLE,
      mode: POC_MODES.BLOCKED,
      aoi: aoiMeta,
      collections,
      sceneCount: 0,
      optical: { scenes: [] },
      sar: { scenes: dedupeScenes(sarScenes) },
    });
  }

  const sorted = safeSceneSort(dedupeScenes(opticalScenes));
  const eventMs = eventDate ? Date.parse(eventDate) : null;
  const preScenes = Number.isFinite(eventMs) ? sorted.filter((s) => Date.parse(s.datetime) < eventMs) : [];
  const postScenes = Number.isFinite(eventMs) ? sorted.filter((s) => Date.parse(s.datetime) >= eventMs) : [];

  const allCloudy =
    sorted.every((scene) => !Number.isFinite(scene.cloudCover) || scene.cloudCover > config.cloudMaxFraction) &&
    sorted.some((scene) => Number.isFinite(scene.cloudCover));

  const baseOptical = {
    scenes: sorted,
    preScenes,
    postScenes,
    bestPre: leastCloudy(preScenes),
    bestPost: leastCloudy(postScenes),
    cloudMaxFraction: config.cloudMaxFraction,
    analysis: null,
  };

  // 5) Cloud-obscured: imagery exists but is not usable for a change analysis. This is NEVER a
  //    negative agricultural finding — only an insufficient-data signal.
  if (allCloudy) {
    notes.push("All returned optical scenes exceed the cloud threshold; analysis is not attempted.");
    return finish({
      outcome: POC_OUTCOMES.CLOUD_OBSCURED,
      mode: POC_MODES.DISCOVERY_ONLY,
      aoi: aoiMeta,
      collections,
      sceneCount: sorted.length,
      optical: baseOptical,
      sar: { scenes: dedupeScenes(sarScenes) },
      evidenceResult: { cloudObscured: true, analyzed: false },
    });
  }

  // 6) Temporal coverage: a pre/post comparison needs at least one scene on each side.
  if (!Number.isFinite(eventMs) || preScenes.length === 0 || postScenes.length === 0) {
    notes.push("Insufficient temporal coverage for a pre/post comparison.");
    return finish({
      outcome: POC_OUTCOMES.INSUFFICIENT_TEMPORAL_COVERAGE,
      mode: POC_MODES.DISCOVERY_ONLY,
      aoi: aoiMeta,
      collections,
      sceneCount: sorted.length,
      optical: baseOptical,
      sar: { scenes: dedupeScenes(sarScenes) },
      evidenceResult: { insufficientTemporalCoverage: true, analyzed: false },
    });
  }

  // 7) Processing (NDVI statistics) requires CDSE Sentinel Hub credentials.
  if (!config.hasCdseCredentials) {
    notes.push(
      "Sentinel Hub processing credentials are not configured; live NDVI statistics were not retrieved. Imagery discovery succeeded."
    );
    return finish({
      outcome: POC_OUTCOMES.IMAGERY_FOUND,
      mode: POC_MODES.DISCOVERY_ONLY,
      aoi: aoiMeta,
      collections,
      sceneCount: sorted.length,
      observedAt: baseOptical.bestPost?.datetime || null,
      optical: baseOptical,
      sar: { scenes: dedupeScenes(sarScenes) },
      evidenceResult: { analyzed: false, reason: "processing-credentials-absent" },
    });
  }

  // 8) Live processing attempt (only reached when credentials exist).
  try {
    const { accessToken } = await fetchCdseToken({ config, http });
    const preStats = await fetchNdviStatistics({
      config,
      http,
      accessToken,
      bbox: aoiMeta.bbox,
      start: preWindow.start,
      end: preWindow.end,
    });
    const postStats = await fetchNdviStatistics({
      config,
      http,
      accessToken,
      bbox: aoiMeta.bbox,
      start: postWindow.start,
      end: postWindow.end,
    });
    if (!preStats.ok || !postStats.ok) {
      notes.push("Processing succeeded but returned no valid statistics (inconclusive).");
      return finish({
        outcome: POC_OUTCOMES.INCONCLUSIVE,
        mode: POC_MODES.DISCOVERY_ONLY,
        aoi: aoiMeta,
        collections,
        sceneCount: sorted.length,
        optical: baseOptical,
        sar: { scenes: dedupeScenes(sarScenes) },
        evidenceResult: { analyzed: false, reason: "no-valid-statistics" },
      });
    }
    const delta = ndviDelta(preStats.ndvi, postStats.ndvi);
    const analysis = { before: preStats, after: postStats, deltaNdvi: delta };
    return finish({
      outcome: POC_OUTCOMES.ANALYSIS_COMPLETE,
      mode: POC_MODES.LIVE,
      aoi: aoiMeta,
      collections,
      sceneCount: sorted.length,
      observedAt: baseOptical.bestPost?.datetime || null,
      optical: { ...baseOptical, analysis },
      sar: { scenes: dedupeScenes(sarScenes) },
      confidence: null,
      evidenceResult: {
        analyzed: true,
        indicator: "NDVI",
        method: "ratio-of-band-means",
        before: preStats.ndvi,
        after: postStats.ndvi,
        delta,
      },
    });
  } catch (error) {
    const kind = error instanceof SatellitePocError ? error.kind : classifyHttpError(error);
    notes.push(`Processing failed (${kind}); imagery was discovered but NDVI could not be computed.`);
    return finish({
      outcome: POC_OUTCOMES.INCONCLUSIVE,
      mode: POC_MODES.DISCOVERY_ONLY,
      aoi: aoiMeta,
      collections,
      sceneCount: sorted.length,
      optical: baseOptical,
      sar: { scenes: dedupeScenes(sarScenes) },
      evidenceResult: { analyzed: false, reason: `processing-${kind.toLowerCase()}` },
    });
  }
};

export default {
  SATELLITE_POC_VERSION,
  runPoc,
  validateAoi,
  validateDateRange,
  computeNdvi,
  ndviFromBandMeans,
  ndviDelta,
  buildStatisticalRequest,
  parseStatisticalResponse,
  buildSatelliteEvidencePayload,
  classifyHttpError,
  mapOutcomeToEvidenceStatus,
  createHttpClient,
  searchScenes,
  fetchCdseToken,
  POC_OUTCOMES,
  POC_MODES,
  EVIDENCE_STATUSES,
};
