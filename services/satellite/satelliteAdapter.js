// Phase 13.3 — Satellite Provider Adapter Foundation — orchestration + evidence boundary
// (ISOLATED, production-oriented).
//
// This module ties the provider interface to a bounded, honest analysis run and exposes a
// NON-OPERATIVE `SATELLITE` evidence payload via the Phase 11 foundation.
//
// HARD BOUNDARIES (enforced by design + tests):
//   - It NEVER imports claim models, the deterministic engine, the AI contract, or any route; it
//     cannot change a claim state, approve/reject, compute compensation, or set acreage.
//   - It NEVER persists evidence. `toVerificationEvidence()` returns a plain, validated payload
//     only; persistence (owner-scoped, audited, idempotent) is a future, separately-authorized
//     service on top of services/verificationEvidence.service.js.
//   - It NEVER fabricates data, invents an indicator when imagery is missing/unusable, or claims
//     processing succeeded when it did not. `analysisExecuted` + `processingStatus` are always set.
//   - `liveProcessingValidated` is always false until a real authenticated response is verified.

import crypto from "node:crypto";

import {
  validateAoi,
  validateDateRange,
  fingerprintAoi,
  ndviDelta,
} from "../../poc/satellite/satellitePoc.js";
import {
  EVIDENCE_STATUSES,
  buildVerificationEvidence,
} from "../../utils/verificationEvidence.js";

import {
  SATELLITE_ADAPTER_VERSION,
  SATELLITE_PROVIDERS,
  resolveSatelliteConfig,
  redactSatelliteConfig,
  describeCredentialRequirement,
} from "./config.js";
import { SatelliteAdapterError, SATELLITE_ERROR_KINDS, classifyProviderError } from "./errors.js";
import {
  createSatelliteProvider,
  getProviderCapabilities,
  isSupportedCollection,
  DEFAULT_OPTICAL_COLLECTION,
  DEFAULT_SAR_COLLECTION,
} from "./provider.js";

export { EVIDENCE_STATUSES };

// --- Vocabulary -----------------------------------------------------------------------------

// Outcome vocabulary. Richer than the evidence vocabulary on purpose: it must distinguish
// validation / configuration / provider / auth / quota / malformed / missing / cloud / coverage /
// processing-disabled / credentials-required / analysis-complete / inconclusive.
export const SATELLITE_OUTCOMES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  CONFIG_DISABLED: "CONFIG_DISABLED",
  UNSUPPORTED_PROVIDER: "UNSUPPORTED_PROVIDER",
  UNSUPPORTED_PRODUCT: "UNSUPPORTED_PRODUCT",
  UNSUPPORTED_PROCESSING: "UNSUPPORTED_PROCESSING",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  TIMEOUT: "TIMEOUT",
  IMAGERY_UNAVAILABLE: "IMAGERY_UNAVAILABLE",
  IMAGERY_FOUND: "IMAGERY_FOUND",
  CLOUD_OBSCURED: "CLOUD_OBSCURED",
  INSUFFICIENT_TEMPORAL_COVERAGE: "INSUFFICIENT_TEMPORAL_COVERAGE",
  ANALYSIS_COMPLETE: "ANALYSIS_COMPLETE",
  INCONCLUSIVE: "INCONCLUSIVE",
});

// Honest processing-execution status. This is the field that proves whether processing actually
// ran; it is never inferred from the mere presence of a prepared request.
export const SATELLITE_PROCESSING_STATUS = Object.freeze({
  NOT_ATTEMPTED: "not_attempted",
  DISABLED: "disabled",
  CREDENTIALS_REQUIRED: "credentials_required",
  UNSUPPORTED: "unsupported",
  EXECUTED: "executed",
  INCONCLUSIVE: "inconclusive",
  FAILED: "failed",
});

export const SATELLITE_MODES = Object.freeze({
  BLOCKED: "blocked",
  DISCOVERY: "discovery",
  ANALYSIS: "analysis",
});

// One-way, read-only mapping onto the frozen Phase 11 EVIDENCE_STATUSES. VERIFIED is NEVER
// reachable from satellite discovery/analysis this phase.
export const EVIDENCE_STATUS_BY_OUTCOME = Object.freeze({
  [SATELLITE_OUTCOMES.INVALID_INPUT]: "NOT_CHECKED",
  [SATELLITE_OUTCOMES.CONFIG_DISABLED]: "NOT_CHECKED",
  [SATELLITE_OUTCOMES.UNSUPPORTED_PROVIDER]: "NOT_CHECKED",
  [SATELLITE_OUTCOMES.UNSUPPORTED_PRODUCT]: "NOT_CHECKED",
  [SATELLITE_OUTCOMES.UNSUPPORTED_PROCESSING]: "NOT_CHECKED",
  [SATELLITE_OUTCOMES.AUTH_REQUIRED]: "UNAVAILABLE",
  [SATELLITE_OUTCOMES.QUOTA_EXCEEDED]: "UNAVAILABLE",
  [SATELLITE_OUTCOMES.PROVIDER_ERROR]: "UNAVAILABLE",
  [SATELLITE_OUTCOMES.MALFORMED_RESPONSE]: "UNAVAILABLE",
  [SATELLITE_OUTCOMES.TIMEOUT]: "UNAVAILABLE",
  [SATELLITE_OUTCOMES.IMAGERY_UNAVAILABLE]: "UNAVAILABLE",
  [SATELLITE_OUTCOMES.IMAGERY_FOUND]: "PENDING",
  [SATELLITE_OUTCOMES.CLOUD_OBSCURED]: "INSUFFICIENT",
  [SATELLITE_OUTCOMES.INSUFFICIENT_TEMPORAL_COVERAGE]: "INSUFFICIENT",
  [SATELLITE_OUTCOMES.ANALYSIS_COMPLETE]: "AVAILABLE",
  [SATELLITE_OUTCOMES.INCONCLUSIVE]: "INSUFFICIENT",
});

const OUTCOME_BY_ERROR_KIND = Object.freeze({
  [SATELLITE_ERROR_KINDS.CONFIG]: SATELLITE_OUTCOMES.AUTH_REQUIRED,
  [SATELLITE_ERROR_KINDS.VALIDATION]: SATELLITE_OUTCOMES.INVALID_INPUT,
  [SATELLITE_ERROR_KINDS.UNSUPPORTED]: SATELLITE_OUTCOMES.UNSUPPORTED_PROVIDER,
  [SATELLITE_ERROR_KINDS.AUTH]: SATELLITE_OUTCOMES.AUTH_REQUIRED,
  [SATELLITE_ERROR_KINDS.QUOTA]: SATELLITE_OUTCOMES.QUOTA_EXCEEDED,
  [SATELLITE_ERROR_KINDS.TIMEOUT]: SATELLITE_OUTCOMES.TIMEOUT,
  [SATELLITE_ERROR_KINDS.NETWORK]: SATELLITE_OUTCOMES.PROVIDER_ERROR,
  [SATELLITE_ERROR_KINDS.PROVIDER]: SATELLITE_OUTCOMES.PROVIDER_ERROR,
  [SATELLITE_ERROR_KINDS.MALFORMED]: SATELLITE_OUTCOMES.MALFORMED_RESPONSE,
  [SATELLITE_ERROR_KINDS.INTERNAL]: SATELLITE_OUTCOMES.PROVIDER_ERROR,
});

export const mapOutcomeToEvidenceStatus = (outcome) =>
  EVIDENCE_STATUS_BY_OUTCOME[outcome] || "UNAVAILABLE";

const QUALITY_BY_OUTCOME = Object.freeze({
  [SATELLITE_OUTCOMES.ANALYSIS_COMPLETE]: "good",
  [SATELLITE_OUTCOMES.IMAGERY_FOUND]: "discovery_only",
  [SATELLITE_OUTCOMES.CLOUD_OBSCURED]: "insufficient",
  [SATELLITE_OUTCOMES.INSUFFICIENT_TEMPORAL_COVERAGE]: "insufficient",
  [SATELLITE_OUTCOMES.INCONCLUSIVE]: "insufficient",
});

const qualityFor = (outcome) => QUALITY_BY_OUTCOME[outcome] || "unavailable";

// --- Window + geometry helpers --------------------------------------------------------------

// Resolve and validate the caller's analysis window(s): either a single `window` or a pre/post
// pair. Uses the PoC's already-reviewed date-range validator. Never makes a network call.
export const resolveWindows = ({ window, preWindow, postWindow, maxWindowDays, now = new Date() } = {}) => {
  const hasPrePost = Boolean(preWindow?.start && preWindow?.end && postWindow?.start && postWindow?.end);
  if (hasPrePost) {
    const pre = validateDateRange({ ...preWindow, now, maxSpanDays: maxWindowDays });
    const post = validateDateRange({ ...postWindow, now, maxSpanDays: maxWindowDays });
    if (!pre.ok || !post.ok) {
      return { ok: false, reason: pre.ok ? post.reason : pre.reason };
    }
    return {
      ok: true,
      mode: "prepost",
      preWindow: { start: preWindow.start, end: preWindow.end },
      postWindow: { start: postWindow.start, end: postWindow.end },
      windows: [
        { start: preWindow.start, end: preWindow.end },
        { start: postWindow.start, end: postWindow.end },
      ],
    };
  }
  if (window?.start && window?.end) {
    const single = validateDateRange({ ...window, now, maxSpanDays: maxWindowDays });
    if (!single.ok) return { ok: false, reason: single.reason };
    return {
      ok: true,
      mode: "single",
      preWindow: null,
      postWindow: null,
      windows: [{ start: window.start, end: window.end }],
    };
  }
  return { ok: false, reason: "a window or a pre/post window pair is required" };
};

const dedupeScenes = (scenes) => {
  const seen = new Set();
  return scenes.filter((scene) => {
    if (!scene?.sceneId) return true;
    if (seen.has(scene.sceneId)) return false;
    seen.add(scene.sceneId);
    return true;
  });
};

const sortScenes = (scenes) =>
  [...scenes].sort((a, b) => (Date.parse(a.acquisitionTime) || 0) - (Date.parse(b.acquisitionTime) || 0));

const bestObservedAt = (scenes) =>
  scenes.reduce((latest, scene) => {
    const time = Date.parse(scene.acquisitionTime);
    if (!Number.isFinite(time)) return latest;
    return !latest || time > Date.parse(latest) ? scene.acquisitionTime : latest;
  }, null);

// --- Evidence boundary (payload only — no persistence) --------------------------------------

const evidenceFingerprint = ({ collection, windows, sceneIds, indicator, adapterVersion }) => {
  try {
    const canonical = JSON.stringify({
      collection: collection || null,
      windows: windows || [],
      sceneIds: [...(sceneIds || [])].sort(),
      indicator: indicator || null,
      adapterVersion: adapterVersion || null,
    });
    return crypto.createHash("sha1").update(canonical).digest("hex");
  } catch {
    return null;
  }
};

// Build a canonical, NON-OPERATIVE SATELLITE evidence payload through the Phase 11 foundation.
// Returns a plain object; nothing is written anywhere. `operative` is derived and false because
// SATELLITE is a non-operative/future source.
export const toVerificationEvidence = ({
  config,
  outcome,
  aoiMeta = null,
  discovery = null,
  processing = null,
  analysis = null,
  observedAt = null,
  collection = null,
  notes = [],
  correlationId = null,
} = {}) => {
  const status = mapOutcomeToEvidenceStatus(outcome);
  const sceneIds = discovery?.scenes ? discovery.scenes.map((scene) => scene.sceneId) : [];
  const analyzed = Boolean(analysis?.analyzed);

  const metadata = {
    adapterVersion: SATELLITE_ADAPTER_VERSION,
    provider: config?.provider || null,
    collections: collection ? [collection] : null,
    productType: discovery?.productType || null,
    sceneCount: discovery?.sceneCount ?? 0,
    validObservationCount: discovery?.sceneCount ?? 0,
    queryWindows: (discovery?.queryWindows || []).slice(0, 8),
    cloudMaxFraction: config?.cloudMaxFraction ?? null,
    indicator: analyzed ? "NDVI" : null,
    analysisExecuted: analyzed,
    processingStatus: processing?.status || null,
    correlationId,
    // Explicit honesty flag persisted WITH the evidence so no consumer can mistake a foundation
    // record for a live-validated result.
    liveProcessingValidated: false,
  };

  const result = {
    quality: qualityFor(outcome),
    analyzed,
    reason: notes.length ? notes[0] : null,
  };

  return buildVerificationEvidence({
    source: "SATELLITE",
    status,
    confidence: null,
    observedAt: observedAt || null,
    provider: config?.provider || null,
    providerVersion: SATELLITE_ADAPTER_VERSION,
    evidenceVersion: evidenceFingerprint({
      collection,
      windows: discovery?.queryWindows || [],
      sceneIds,
      indicator: analyzed ? "NDVI" : null,
      adapterVersion: SATELLITE_ADAPTER_VERSION,
    }),
    evaluationVersion: "satellite-adapter-ndvi-v1",
    reference: aoiMeta?.fingerprint || null,
    metadata,
    result,
  });
};

// --- Orchestration --------------------------------------------------------------------------

const emptyDiscovery = (provider, collection) => ({
  provider,
  providerVersion: SATELLITE_ADAPTER_VERSION,
  collection,
  productType: collection,
  spatialCoverage: null,
  queryWindows: [],
  discoveryTimestamp: new Date().toISOString(),
  correlationId: null,
  sceneCount: 0,
  empty: true,
  scenes: [],
  requestCount: 0,
  durationMs: 0,
});

// Run a bounded satellite analysis. NEVER throws for expected provider/quality failures; those
// become outcomes. NEVER writes anything. Returns a structured, traceable result plus a
// non-operative evidence payload.
export const runSatelliteAnalysis = async ({
  config = resolveSatelliteConfig(),
  aoi,
  window,
  preWindow,
  postWindow,
  requestedProduct = null,
  requestProcessing = true,
  includeSar = false,
  correlationId = null,
  transport,
  now = new Date(),
} = {}) => {
  const startedAt = Date.now();
  const notes = [];

  const finish = (partial = {}) => {
    const outcome = partial.outcome || SATELLITE_OUTCOMES.INCONCLUSIVE;
    const processingInfo = partial.processing || null;
    return {
      adapterVersion: SATELLITE_ADAPTER_VERSION,
      provider: config.provider,
      providerVersion: SATELLITE_ADAPTER_VERSION,
      capabilities: partial.capabilities || getProviderCapabilities(config.provider) || null,
      mode: partial.mode || SATELLITE_MODES.BLOCKED,
      outcome,
      evidenceStatus: mapOutcomeToEvidenceStatus(outcome),
      processingStatus:
        processingInfo?.status || SATELLITE_PROCESSING_STATUS.NOT_ATTEMPTED,
      analysisExecuted: Boolean(partial.analysis?.analyzed),
      aoi: partial.aoi || null,
      requestedProduct: partial.requestedProduct || null,
      discovery: partial.discovery || null,
      processing: processingInfo?.descriptor || null,
      analysis: partial.analysis || null,
      observedAt: partial.observedAt || null,
      correlationId: correlationId || null,
      requestCount: partial.requestCount ?? 0,
      durationMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      // Hard honesty flag: never true until a real authenticated response is verified.
      liveProcessingValidated: false,
      notes,
      evidence:
        partial.evidence ||
        toVerificationEvidence({
          config,
          outcome,
          aoiMeta: partial.aoi,
          discovery: partial.discovery,
          processing: processingInfo,
          analysis: partial.analysis,
          observedAt: partial.observedAt,
          collection: partial.discovery?.collection || null,
          notes,
          correlationId,
        }),
    };
  };

  // 0) Configuration gate.
  if (!config.enabled) {
    notes.push("Satellite adapter is disabled by configuration.");
    return finish({ outcome: SATELLITE_OUTCOMES.CONFIG_DISABLED });
  }

  const capabilities = getProviderCapabilities(config.provider);
  if (!capabilities) {
    notes.push(`Unsupported satellite provider: ${config.provider}`);
    return finish({ outcome: SATELLITE_OUTCOMES.UNSUPPORTED_PROVIDER });
  }

  // 1) Product selection.
  const product = requestedProduct || capabilities.processing.collection || DEFAULT_OPTICAL_COLLECTION;
  if (!isSupportedCollection(product)) {
    notes.push(`Unsupported satellite product: ${product}`);
    return finish({
      outcome: SATELLITE_OUTCOMES.UNSUPPORTED_PRODUCT,
      capabilities,
      requestedProduct: product,
    });
  }
  const canProcess = Boolean(capabilities.processing && capabilities.processing.collection === product);
  if (requestProcessing && !canProcess) {
    notes.push(`Processing is not supported for product ${product}.`);
    return finish({
      outcome: SATELLITE_OUTCOMES.UNSUPPORTED_PROCESSING,
      capabilities,
      requestedProduct: product,
    });
  }

  // 2) Validate AOI (reuses the authoritative geometry validator, read-only).
  const aoiValidation = validateAoi(aoi);
  if (!aoiValidation.ok) {
    notes.push("AOI rejected by the authoritative geometry validator.");
    return finish({
      outcome: SATELLITE_OUTCOMES.INVALID_INPUT,
      capabilities,
      requestedProduct: product,
      message: aoiValidation.reason,
    });
  }
  const aoiMeta = {
    acres: aoiValidation.acres,
    bbox: aoiValidation.bbox,
    extentMeters: aoiValidation.extentMeters,
    fingerprint: fingerprintAoi(aoi),
    crs: "EPSG:4326",
  };

  // 3) Validate window(s).
  const windowCheck = resolveWindows({
    window,
    preWindow,
    postWindow,
    maxWindowDays: config.maxWindowDays,
    now,
  });
  if (!windowCheck.ok) {
    notes.push("Analysis window rejected by the bounded date-range validator.");
    return finish({
      outcome: SATELLITE_OUTCOMES.INVALID_INPUT,
      capabilities,
      requestedProduct: product,
      aoi: aoiMeta,
      message: windowCheck.reason,
    });
  }

  // 4) Provider instance.
  let provider;
  try {
    provider = createSatelliteProvider({ config, transport });
  } catch (error) {
    const kind = classifyProviderError(error);
    notes.push(`Provider initialization failed (${kind}).`);
    return finish({
      outcome: OUTCOME_BY_ERROR_KIND[kind] || SATELLITE_OUTCOMES.PROVIDER_ERROR,
      capabilities,
      requestedProduct: product,
      aoi: aoiMeta,
    });
  }

  // 5) Discover optical imagery (one bounded request per window).
  const opticalScenes = [];
  let discoveryMeta = null;
  try {
    for (const w of windowCheck.windows) {
      const result = await provider.discover({
        aoi: aoiMeta,
        windows: [w],
        collection: product,
        correlationId,
      });
      opticalScenes.push(...result.scenes);
      if (!discoveryMeta) {
        discoveryMeta = result;
      } else {
        discoveryMeta.requestCount += result.requestCount;
        discoveryMeta.durationMs += result.durationMs;
        discoveryMeta.queryWindows.push(...result.queryWindows);
        discoveryMeta.discoveryTimestamp = result.discoveryTimestamp;
      }
    }
  } catch (error) {
    const kind = classifyProviderError(error);
    notes.push(`Optical discovery failed (${kind}); no imagery was retrieved.`);
    return finish({
      outcome: OUTCOME_BY_ERROR_KIND[kind] || SATELLITE_OUTCOMES.PROVIDER_ERROR,
      capabilities,
      requestedProduct: product,
      aoi: aoiMeta,
      requestCount: provider.requestCount(),
      discovery: { ...emptyDiscovery(config.provider, product) },
    });
  }

  const discovery = {
    ...discoveryMeta,
    sceneCount: opticalScenes.length,
  };

  // 6) SAR discovery (best-effort, cloud-independent mitigation; never blocks optical).
  if (includeSar && capabilities.sarDiscovery && product !== DEFAULT_SAR_COLLECTION) {
    try {
      const sarResult = await provider.discover({
        aoi: aoiMeta,
        windows: windowCheck.windows,
        collection: DEFAULT_SAR_COLLECTION,
        correlationId,
      });
      discovery.sar = {
        collection: DEFAULT_SAR_COLLECTION,
        sceneCount: sarResult.sceneCount,
        empty: sarResult.empty,
        scenes: sarResult.scenes,
      };
      discovery.requestCount += sarResult.requestCount;
    } catch (error) {
      const kind = classifyProviderError(error);
      notes.push(`SAR discovery failed (${kind}); SAR is optional and does not block optical.`);
      discovery.sar = { collection: DEFAULT_SAR_COLLECTION, sceneCount: 0, empty: true, scenes: [] };
    }
  }

  const requestCountAfterDiscovery = provider.requestCount();

  // 7) Empty (successful) search vs API failure, and cloud quality.
  if (discovery.sceneCount === 0) {
    notes.push("Provider returned no imagery for the AOI/window(s).");
    return finish({
      outcome: SATELLITE_OUTCOMES.IMAGERY_UNAVAILABLE,
      mode: SATELLITE_MODES.DISCOVERY,
      capabilities,
      requestedProduct: product,
      aoi: aoiMeta,
      requestCount: requestCountAfterDiscovery,
      discovery,
    });
  }

  const sorted = sortScenes(dedupeScenes(opticalScenes));
  const allCloudy =
    sorted.every((scene) => !Number.isFinite(scene.cloudCoverFraction) || scene.cloudCoverFraction > config.cloudMaxFraction) &&
    sorted.some((scene) => Number.isFinite(scene.cloudCoverFraction));

  if (allCloudy) {
    notes.push("All returned optical scenes exceed the cloud threshold; analysis is not attempted.");
    return finish({
      outcome: SATELLITE_OUTCOMES.CLOUD_OBSCURED,
      mode: SATELLITE_MODES.DISCOVERY,
      capabilities,
      requestedProduct: product,
      aoi: aoiMeta,
      requestCount: requestCountAfterDiscovery,
      discovery,
      observedAt: bestObservedAt(sorted),
    });
  }

  // 8) Pre/post coverage requirement.
  const prepost = windowCheck.mode === "prepost";
  if (prepost) {
    const preCount = opticalScenes.filter(
      (scene) => scene.queryWindow?.start === windowCheck.preWindow.start
    ).length;
    const postCount = opticalScenes.filter(
      (scene) => scene.queryWindow?.start === windowCheck.postWindow.start
    ).length;
    if (preCount === 0 || postCount === 0) {
      notes.push("Insufficient temporal coverage for a pre/post comparison.");
      return finish({
        outcome: SATELLITE_OUTCOMES.INSUFFICIENT_TEMPORAL_COVERAGE,
        mode: SATELLITE_MODES.DISCOVERY,
        capabilities,
        requestedProduct: product,
        aoi: aoiMeta,
        requestCount: requestCountAfterDiscovery,
        discovery,
        observedAt: bestObservedAt(sorted),
      });
    }
  }

  // 9) Processing gate — prepare always; execute only when explicitly enabled AND credentialed.
  const processing = { status: SATELLITE_PROCESSING_STATUS.NOT_ATTEMPTED, descriptor: null };
  if (!requestProcessing) {
    processing.status = SATELLITE_PROCESSING_STATUS.NOT_ATTEMPTED;
    notes.push("Imagery discovered; processing was not requested.");
  } else if (!config.processingEnabled) {
    processing.status = SATELLITE_PROCESSING_STATUS.DISABLED;
    notes.push("Imagery discovered; live processing is disabled (SATELLITE_PROCESSING_ENABLED is off).");
  } else if (!config.hasCredentials) {
    processing.status = SATELLITE_PROCESSING_STATUS.CREDENTIALS_REQUIRED;
    notes.push("Imagery discovered; live processing requires configured CDSE credentials.");
  } else {
    processing.descriptor = provider.prepareProcessing({ aoi: aoiMeta, window: windowCheck.postWindow || windowCheck.windows[0] });
    try {
      const requests = await executeProcessing({
        provider,
        config,
        aoi: aoiMeta,
        windowCheck,
      });
      if (!requests.ok) {
        processing.status = SATELLITE_PROCESSING_STATUS.INCONCLUSIVE;
        notes.push("Processing returned no usable statistics (inconclusive).");
        return finish({
          outcome: SATELLITE_OUTCOMES.INCONCLUSIVE,
          mode: SATELLITE_MODES.DISCOVERY,
          capabilities,
          requestedProduct: product,
          aoi: aoiMeta,
          requestCount: provider.requestCount(),
          discovery,
          processing,
          observedAt: bestObservedAt(sorted),
        });
      }
      processing.status = SATELLITE_PROCESSING_STATUS.EXECUTED;
      return finish({
        outcome: SATELLITE_OUTCOMES.ANALYSIS_COMPLETE,
        mode: SATELLITE_MODES.ANALYSIS,
        capabilities,
        requestedProduct: product,
        aoi: aoiMeta,
        requestCount: provider.requestCount(),
        discovery,
        processing,
        analysis: requests.analysis,
        observedAt: bestObservedAt(sorted),
      });
    } catch (error) {
      const kind = classifyProviderError(error);
      notes.push(`Processing failed (${kind}); imagery was discovered but no indicator was produced.`);
      processing.status =
        kind === SATELLITE_ERROR_KINDS.AUTH || kind === SATELLITE_ERROR_KINDS.QUOTA
          ? SATELLITE_PROCESSING_STATUS.FAILED
          : SATELLITE_PROCESSING_STATUS.INCONCLUSIVE;
      return finish({
        outcome: OUTCOME_BY_ERROR_KIND[kind] || SATELLITE_OUTCOMES.INCONCLUSIVE,
        mode: SATELLITE_MODES.DISCOVERY,
        capabilities,
        requestedProduct: product,
        aoi: aoiMeta,
        requestCount: provider.requestCount(),
        discovery,
        processing,
        observedAt: bestObservedAt(sorted),
      });
    }
  }

  // 10) Discovery-only terminal (processing not executed).
  return finish({
    outcome: SATELLITE_OUTCOMES.IMAGERY_FOUND,
    mode: SATELLITE_MODES.DISCOVERY,
    capabilities,
    requestedProduct: product,
    aoi: aoiMeta,
    requestCount: requestCountAfterDiscovery,
    discovery,
    processing,
    observedAt: bestObservedAt(sorted),
  });
};

// Execute the prepared processing for a single window or a pre/post pair. Always bounded.
const executeProcessing = async ({ provider, config, aoi, windowCheck }) => {
  if (windowCheck.mode === "prepost") {
    const before = await provider.executeProcessing({ aoi, window: windowCheck.preWindow });
    const after = await provider.executeProcessing({ aoi, window: windowCheck.postWindow });
    if (!before.ok || !after.ok) {
      return { ok: false, reason: !before.ok ? before.reason : after.reason };
    }
    return {
      ok: true,
      analysis: {
        analyzed: true,
        indicator: "NDVI",
        method: "ratio-of-band-means",
        before: { ndvi: before.ndvi, validPixelFraction: before.validPixelFraction, intervals: before.intervals },
        after: { ndvi: after.ndvi, validPixelFraction: after.validPixelFraction, intervals: after.intervals },
        deltaNdvi: ndviDelta(before.ndvi, after.ndvi),
      },
    };
  }
  const single = await provider.executeProcessing({ aoi, window: windowCheck.windows[0] });
  if (!single.ok) return { ok: false, reason: single.reason };
  return {
    ok: true,
    analysis: {
      analyzed: true,
      indicator: "NDVI",
      method: "ratio-of-band-means",
      before: null,
      after: { ndvi: single.ndvi, validPixelFraction: single.validPixelFraction, intervals: single.intervals },
      deltaNdvi: null,
    },
  };
};

// Introspection helper: the declared capabilities for the default (or given) provider.
export const adapterCapabilities = (provider = SATELLITE_PROVIDERS.CDSE_SENTINEL) =>
  getProviderCapabilities(provider);

export default {
  SATELLITE_ADAPTER_VERSION,
  SATELLITE_OUTCOMES,
  SATELLITE_PROCESSING_STATUS,
  SATELLITE_MODES,
  EVIDENCE_STATUS_BY_OUTCOME,
  mapOutcomeToEvidenceStatus,
  resolveWindows,
  resolveSatelliteConfig,
  redactSatelliteConfig,
  describeCredentialRequirement,
  getProviderCapabilities,
  adapterCapabilities,
  toVerificationEvidence,
  runSatelliteAnalysis,
};
