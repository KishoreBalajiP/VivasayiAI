// Phase 13.3 — Satellite Provider Adapter Foundation focused unit tests (ISOLATED).
//
// Fully OFFLINE and deterministic: every provider interaction goes through an injected transport.
// A mocked provider success proves the adapter's OWN logic only — it is NOT proof that any live
// provider works. Live authenticated processing remains UNVALIDATED (see
// PHASE_13_3_SATELLITE_ADAPTER_REPORT.md). No database, no network, no credentials.

import { describe, it, expect, vi } from "vitest";

import {
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
  createSatelliteProvider,
  normalizeDiscoveryScene,
} from "../services/satellite/index.js";
import satelliteAdapter from "../services/satellite/satelliteAdapter.js";
import * as satelliteIndex from "../services/satellite/index.js";
import { EVIDENCE_STATUSES } from "../utils/verificationEvidence.js";
import { CLAIM_STATES } from "../models/LossClaim.js";
import TEST_PARCEL from "../poc/satellite/testPolygon.js";
import pocSatellite from "../poc/satellite/satellitePoc.js";

// --- fixtures -------------------------------------------------------------------------------

const STAC_URL = "https://catalogue.test/stac";
const TOKEN_URL = "https://token.test/oauth";
const STATS_URL = "https://stats.test/api/v1/statistics";
const S2 = "sentinel-2-l2a";
const S1 = "sentinel-1-grd";

const baseConfig = (overrides = {}) => ({
  adapterVersion: SATELLITE_ADAPTER_VERSION,
  provider: "cdse-sentinel",
  enabled: true,
  processingEnabled: false,
  requestTimeoutMs: 1000,
  maxRetries: 0,
  maxScenes: 10,
  cloudMaxFraction: 0.3,
  maxWindowDays: 120,
  stacUrl: STAC_URL,
  tokenUrl: TOKEN_URL,
  statisticsUrl: STATS_URL,
  clientId: null,
  clientSecret: null,
  hasCredentials: false,
  ...overrides,
});

const feature = (id, datetime, cloudPercent, extra = {}) => ({
  id,
  bbox: [79.1375, 10.7864, 79.1381, 10.787],
  collection: S2,
  properties: { datetime, "eo:cloud_cover": cloudPercent, platform: "Sentinel-2B", ...extra },
});

const searchResponse = (features) => ({ status: 200, data: { type: "FeatureCollection", features } });

const statsResponse = (red, nir) => ({
  status: 200,
  data: [
    {
      outputs: {
        default: {
          bands: {
            B0: { stats: { mean: red } },
            B1: { stats: { mean: nir } },
            B2: { stats: { mean: 1 } },
          },
        },
      },
    },
  ],
});

const httpError = (status) => {
  const error = new Error(`HTTP ${status}`);
  error.response = { status, data: {} };
  return error;
};

const timeoutError = () => {
  const error = new Error("timeout of 1000ms exceeded");
  error.code = "ECONNABORTED";
  return error;
};

// Routes by URL: STAC search, OAuth token, Statistical API. Records every call for assertions.
const makeTransport = ({ calls = [], onSearch, onToken, onStats } = {}) => ({
  get: vi.fn(),
  post: vi.fn(async (url, body) => {
    calls.push({ url, body });
    if (String(url).endsWith("/search")) {
      return onSearch ? onSearch(body) : searchResponse([]);
    }
    if (url === TOKEN_URL) {
      return onToken ? onToken() : { status: 200, data: { access_token: "tok-abc", expires_in: 600 } };
    }
    if (url === STATS_URL) {
      return onStats ? onStats() : statsResponse(0.1, 0.4);
    }
    throw new Error(`unexpected url ${url}`);
  }),
});

const SINGLE_WINDOW = { start: "2024-02-01T00:00:00Z", end: "2024-04-30T00:00:00Z" };
const PRE = TEST_PARCEL.preWindow;
const POST = TEST_PARCEL.postWindow;

const runArgs = (config, transport, overrides = {}) => ({
  config,
  aoi: TEST_PARCEL.geometry,
  window: SINGLE_WINDOW,
  transport,
  ...overrides,
});

// Returns pre scenes for the pre window request and post scenes otherwise.
const windowAwareSearch = (preScenes, postScenes) => (body) =>
  searchResponse(String(body?.datetime || "").startsWith(PRE.start) ? preScenes : postScenes);

// --- 1. valid provider configuration --------------------------------------------------------

describe("13.3 Adapter — configuration", () => {
  it("resolves valid provider configuration and redacts secrets", () => {
    const config = resolveSatelliteConfig({
      CDSE_CLIENT_ID: "client-id-value",
      CDSE_CLIENT_SECRET: "super-secret-value",
    });
    expect(config.provider).toBe("cdse-sentinel");
    expect(config.hasCredentials).toBe(true);
    expect(config.processingEnabled).toBe(false); // requires explicit opt-in

    const redacted = redactSatelliteConfig(config);
    expect(redacted).not.toHaveProperty("clientId");
    expect(redacted).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(redacted)).not.toContain("super-secret-value");
    expect(redacted.hasCredentials).toBe(true);

    expect(describeCredentialRequirement().required).toEqual(["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"]);
    expect(adapterCapabilities().discovery).toBe(true);
  });

  // --- 2. missing credentials -------------------------------------------------------------
  it("handles missing credentials safely and never calls the token endpoint", async () => {
    const config = resolveSatelliteConfig({ SATELLITE_PROCESSING_ENABLED: "true" });
    expect(config.hasCredentials).toBe(false);
    expect(config.processingEnabled).toBe(true);

    const calls = [];
    const transport = makeTransport({
      calls,
      onSearch: () => searchResponse([feature("S2-pre", "2024-02-10T05:00:00Z", 5)]),
    });
    const result = await runSatelliteAnalysis(runArgs(config, transport));

    expect(result.outcome).toBe(SATELLITE_OUTCOMES.IMAGERY_FOUND);
    expect(result.processingStatus).toBe(SATELLITE_PROCESSING_STATUS.CREDENTIALS_REQUIRED);
    expect(result.analysisExecuted).toBe(false);
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(0);
  });
});

// --- 3. invalid polygon / 4. invalid date range --------------------------------------------

describe("13.3 Adapter — input validation", () => {
  it("rejects an invalid polygon before any network request", async () => {
    const transport = makeTransport({});
    const result = await runSatelliteAnalysis(
      runArgs(baseConfig(), transport, { aoi: { type: "Point", coordinates: [0, 0] } })
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.INVALID_INPUT);
    expect(result.evidenceStatus).toBe("NOT_CHECKED");
    expect(transport.post).not.toHaveBeenCalled();
  });

  it("rejects an invalid/reversed date range before any network request", async () => {
    const transport = makeTransport({});
    const result = await runSatelliteAnalysis(
      runArgs(baseConfig(), transport, { window: { start: "2024-04-30T00:00:00Z", end: "2024-02-01T00:00:00Z" } })
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.INVALID_INPUT);
    expect(transport.post).not.toHaveBeenCalled();

    expect(resolveWindows({ maxWindowDays: 120 }).ok).toBe(false);
    expect(
      resolveWindows({ window: { start: "2020-01-01T00:00:00Z", end: "2021-06-01T00:00:00Z" }, maxWindowDays: 120 }).ok
    ).toBe(false);
  });

  // --- 5. unsupported product / processing mode ------------------------------------------
  it("rejects an unsupported product and an unsupported processing mode", async () => {
    const transport = makeTransport({});
    const badProduct = await runSatelliteAnalysis(
      runArgs(baseConfig(), transport, { requestedProduct: "landsat-8" })
    );
    expect(badProduct.outcome).toBe(SATELLITE_OUTCOMES.UNSUPPORTED_PRODUCT);
    expect(badProduct.evidenceStatus).toBe("NOT_CHECKED");

    const badProcessing = await runSatelliteAnalysis(
      runArgs(baseConfig(), transport, { requestedProduct: "sentinel-1-grd", requestProcessing: true })
    );
    expect(badProcessing.outcome).toBe(SATELLITE_OUTCOMES.UNSUPPORTED_PROCESSING);
  });
});

// --- 6. successful normalized discovery ----------------------------------------------------

describe("13.3 Adapter — discovery", () => {
  it("returns a normalized, traceable discovery result from a mocked provider", async () => {
    const calls = [];
    const transport = makeTransport({
      calls,
      onSearch: () => searchResponse([
        feature("S2-pre", "2024-02-10T05:00:00Z", 5),
        feature("S2-post", "2024-04-10T05:00:00Z", 3),
      ]),
    });
    const result = await runSatelliteAnalysis(runArgs(baseConfig(), transport));

    expect(result.outcome).toBe(SATELLITE_OUTCOMES.IMAGERY_FOUND);
    expect(result.evidenceStatus).toBe("PENDING");
    expect(result.discovery.empty).toBe(false);
    expect(result.discovery.sceneCount).toBe(2);
    expect(result.discovery.requestCount).toBeGreaterThanOrEqual(1);
    expect(result.discovery.spatialCoverage.crs).toBe("EPSG:4326");

    const scene = result.discovery.scenes.find((entry) => entry.sceneId === "S2-pre");
    expect(scene).toMatchObject({
      sceneId: "S2-pre",
      provider: "cdse-sentinel",
      collection: S2,
      productType: S2,
      productLevel: "L2A",
      platformFamily: "Sentinel-2",
      acquisitionTime: "2024-02-10T05:00:00Z",
      cloudCoverFraction: 0.05,
      cloudCoverSource: "eo:cloud_cover",
    });
    expect(scene.spatialCoverage).toEqual([79.1375, 10.7864, 79.1381, 10.787]);
    expect(scene.bands).toContain("B04");
    expect(typeof result.discovery.discoveryTimestamp).toBe("string");
  });

  // --- 14. no fabricated acquisition metadata --------------------------------------------
  it("never invents acquisition metadata the provider did not return", () => {
    const sparse = normalizeDiscoveryScene(
      { id: "S2-sparse", properties: {} },
      { provider: "cdse-sentinel", collection: S2 }
    );
    expect(sparse.sceneId).toBe("S2-sparse");
    expect(sparse.acquisitionTime).toBeNull();
    expect(sparse.cloudCoverFraction).toBeNull();
    expect(sparse.cloudCoverSource).toBeNull();
    expect(sparse.platform).toBeNull();
    expect(sparse.spatialCoverage).toBeNull();
    expect(JSON.stringify(sparse)).not.toMatch(/T\d\d:\d\d/); // no invented timestamp
  });

  // --- 7. empty imagery (success) vs API failure ------------------------------------------
  it("distinguishes a successful empty search from a provider failure", async () => {
    const emptyCalls = [];
    const empty = await runSatelliteAnalysis(
      runArgs(baseConfig(), makeTransport({ calls: emptyCalls, onSearch: () => searchResponse([]) }))
    );
    expect(empty.outcome).toBe(SATELLITE_OUTCOMES.IMAGERY_UNAVAILABLE);
    expect(empty.evidenceStatus).toBe("UNAVAILABLE");
    expect(empty.discovery.empty).toBe(true);
    expect(empty.discovery.sceneCount).toBe(0);

    const failure = await runSatelliteAnalysis(
      runArgs(baseConfig(), makeTransport({ onSearch: () => { throw httpError(500); } }))
    );
    expect(failure.outcome).toBe(SATELLITE_OUTCOMES.PROVIDER_ERROR);
    expect(failure.discovery.sceneCount).toBe(0);
  });
});

// --- 8. timeout / 9. auth / 10. quota / 11. malformed --------------------------------------

describe("13.3 Adapter — provider failures", () => {
  it("normalizes a provider timeout as UNAVAILABLE", async () => {
    const result = await runSatelliteAnalysis(
      runArgs(baseConfig(), makeTransport({ onSearch: () => { throw timeoutError(); } }))
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.TIMEOUT);
    expect(result.evidenceStatus).toBe("UNAVAILABLE");
  });

  it("normalizes authentication failure as UNAVAILABLE", async () => {
    const result = await runSatelliteAnalysis(
      runArgs(baseConfig(), makeTransport({ onSearch: () => { throw httpError(401); } }))
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.AUTH_REQUIRED);
    expect(result.evidenceStatus).toBe("UNAVAILABLE");
  });

  it("normalizes a quota/rate-limit response as UNAVAILABLE", async () => {
    const result = await runSatelliteAnalysis(
      runArgs(baseConfig(), makeTransport({ onSearch: () => { throw httpError(429); } }))
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.QUOTA_EXCEEDED);
    expect(result.evidenceStatus).toBe("UNAVAILABLE");
  });

  it("normalizes a malformed provider response (never treats it as empty success)", async () => {
    const result = await runSatelliteAnalysis(
      runArgs(baseConfig(), makeTransport({ onSearch: () => ({ status: 200, data: { type: "FeatureCollection" } }) }))
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.MALFORMED_RESPONSE);
    expect(result.evidenceStatus).toBe("UNAVAILABLE");
  });

  // --- 12. bounded retries ----------------------------------------------------------------
  it("bounds retries to retryable kinds only", async () => {
    let attempts = 0;
    const transport = {
      get: vi.fn(),
      post: vi.fn(async (url) => {
        if (String(url).endsWith("/search")) {
          attempts += 1;
          if (attempts < 3) throw httpError(503);
          return searchResponse([feature("S2-pre", "2024-02-10T05:00:00Z", 5)]);
        }
        throw new Error("unexpected");
      }),
    };
    await runSatelliteAnalysis(runArgs(baseConfig({ maxRetries: 2 }), transport));
    expect(attempts).toBe(3);

    let authAttempts = 0;
    const authTransport = {
      get: vi.fn(),
      post: vi.fn(async (url) => {
        authAttempts += 1;
        throw httpError(401);
      }),
    };
    const authResult = await runSatelliteAnalysis(runArgs(baseConfig({ maxRetries: 2 }), authTransport));
    expect(authAttempts).toBe(1);
    expect(authResult.outcome).toBe(SATELLITE_OUTCOMES.AUTH_REQUIRED);
  });
});

// --- 13. secret redaction -------------------------------------------------------------------

describe("13.3 Adapter — secret safety", () => {
  it("never serializes credentials or tokens into the result", async () => {
    const config = baseConfig({
      processingEnabled: true,
      hasCredentials: true,
      clientId: "client-id-value",
      clientSecret: "super-secret-value",
    });
    const calls = [];
    const transport = makeTransport({
      calls,
      onSearch: windowAwareSearch(
        [feature("S2-pre", "2024-02-10T05:00:00Z", 5)],
        [feature("S2-post", "2024-04-10T05:00:00Z", 3)]
      ),
      onStats: statsResponse(0.1, 0.4),
    });
    const result = await runSatelliteAnalysis(
      runArgs(config, transport, { preWindow: PRE, postWindow: POST, window: undefined })
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("client-id-value");
    expect(serialized).not.toContain("tok-abc");
  });
});

// --- processing (gated execution) -----------------------------------------------------------

describe("13.3 Adapter — honest processing status", () => {
  // --- 15. no processing claim when processing was not attempted --------------------------
  it("reports processing as disabled and never claims it ran", async () => {
    const transport = makeTransport({
      onSearch: () => searchResponse([feature("S2-pre", "2024-02-10T05:00:00Z", 5)]),
    });
    const result = await runSatelliteAnalysis(runArgs(baseConfig({ processingEnabled: false }), transport));
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.IMAGERY_FOUND);
    expect(result.processingStatus).toBe(SATELLITE_PROCESSING_STATUS.DISABLED);
    expect(result.analysisExecuted).toBe(false);
    expect(result.analysis).toBeNull();
    expect(result.liveProcessingValidated).toBe(false);
  });

  it("prepares a bounded request descriptor but does not execute it when gated", async () => {
    const provider = createSatelliteProvider({ config: baseConfig(), transport: makeTransport({}) });
    const descriptor = provider.prepareProcessing({
      aoi: { bbox: [79.1375, 10.7864, 79.1381, 10.787] },
      window: POST,
    });
    expect(descriptor.prepared).toBe(true);
    expect(descriptor.executed).toBe(false);
    expect(descriptor.indicator).toBe("NDVI");
    expect(descriptor.bands).toEqual({ red: "B04", nir: "B08", mask: "dataMask" });
    expect(descriptor.formula).toMatch(/B08 - B04/);
    expect(descriptor.bounded.singleRequestPerWindow).toBe(true);
    expect(descriptor.requestShape.input.data[0].type).toBe(S2);
  });

  it("executes bounded pre/post NDVI only when enabled and credentialed (mocked)", async () => {
    const config = baseConfig({ processingEnabled: true, hasCredentials: true, clientId: "a", clientSecret: "b" });
    let statsCall = 0;
    const transport = makeTransport({
      onSearch: windowAwareSearch(
        [feature("S2-pre", "2024-02-10T05:00:00Z", 5)],
        [feature("S2-post", "2024-04-10T05:00:00Z", 3)]
      ),
      onStats: () => {
        statsCall += 1;
        return statsCall === 1 ? statsResponse(0.1, 0.4) : statsResponse(0.2, 0.3);
      },
    });
    const result = await runSatelliteAnalysis(
      runArgs(config, transport, { preWindow: PRE, postWindow: POST, window: undefined })
    );
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.ANALYSIS_COMPLETE);
    expect(result.mode).toBe(SATELLITE_MODES.ANALYSIS);
    expect(result.processingStatus).toBe(SATELLITE_PROCESSING_STATUS.EXECUTED);
    expect(result.analysisExecuted).toBe(true);
    expect(result.analysis.deltaNdvi).toBeCloseTo(-0.4, 5);
    expect(result.evidence.status).toBe("AVAILABLE");
  });

  // --- 16. inconclusive for missing/no-data imagery ---------------------------------------
  it("returns inconclusive (not a fabricated indicator) when statistics are unusable", async () => {
    const config = baseConfig({ processingEnabled: true, hasCredentials: true, clientId: "a", clientSecret: "b" });
    const transport = makeTransport({
      onSearch: () => searchResponse([feature("S2-pre", "2024-02-10T05:00:00Z", 5)]),
      onStats: () => ({ status: 200, data: [] }),
    });
    const result = await runSatelliteAnalysis(runArgs(config, transport));
    expect(result.outcome).toBe(SATELLITE_OUTCOMES.INCONCLUSIVE);
    expect(result.evidenceStatus).toBe("INSUFFICIENT");
    expect(result.analysisExecuted).toBe(false);
    expect(result.analysis).toBeNull();
  });
});

// --- 17. evidence payload compatibility -----------------------------------------------------

describe("13.3 Adapter — evidence boundary", () => {
  it("produces a canonical, non-operative SATELLITE payload without persisting", () => {
    const payload = toVerificationEvidence({
      config: baseConfig(),
      outcome: SATELLITE_OUTCOMES.ANALYSIS_COMPLETE,
      aoiMeta: { fingerprint: "abc123abc123abcd" },
      discovery: { sceneCount: 2, productType: S2, queryWindows: [{ start: PRE.start, end: PRE.end }], scenes: [{ sceneId: "S2-pre" }] },
      processing: { status: SATELLITE_PROCESSING_STATUS.EXECUTED },
      analysis: { analyzed: true },
      collection: S2,
      notes: ["ok"],
    });
    expect(payload.source).toBe("SATELLITE");
    expect(payload.operative).toBe(false);
    expect(EVIDENCE_STATUSES).toContain(payload.status);
    expect(payload.metadata.liveProcessingValidated).toBe(false);
    expect(payload.metadata.analysisExecuted).toBe(true);
    expect(payload.evidenceVersion).toMatch(/^[0-9a-f]{40}$/);
    // No forbidden metadata keys (storage internals / secrets / urls).
    expect(payload.metadata).not.toHaveProperty("url");
    expect(payload.metadata).not.toHaveProperty("token");
    expect(payload.metadata).not.toHaveProperty("authorization");
  });

  // --- 18. satellite evidence cannot change claim decisions --------------------------------
  it("exposes no decision API and uses only evidence statuses", () => {
    const claimStates = new Set(CLAIM_STATES);
    for (const outcome of Object.keys(EVIDENCE_STATUS_BY_OUTCOME)) {
      const status = mapOutcomeToEvidenceStatus(outcome);
      expect(EVIDENCE_STATUSES).toContain(status);
      expect(claimStates.has(status)).toBe(false);
    }
    const forbidden = Object.keys(satelliteAdapter).filter((key) =>
      /transition|approve|reject|compensat|override|engine|claimstate|decision/i.test(key)
    );
    expect(forbidden).toEqual([]);
    const indexForbidden = Object.keys(satelliteIndex).filter((key) =>
      /transition|approve|reject|compensat|override|engine|claimstate|decision/i.test(key)
    );
    expect(indexForbidden).toEqual([]);
    expect(mapOutcomeToEvidenceStatus(SATELLITE_OUTCOMES.ANALYSIS_COMPLETE)).toBe("AVAILABLE");
    expect(mapOutcomeToEvidenceStatus(SATELLITE_OUTCOMES.IMAGERY_FOUND)).toBe("PENDING");
  });

  // --- 19. no live claim is accessed or modified ------------------------------------------
  it("never touches a claim: no claim identifiers in results and no DB/claim imports", async () => {
    const transport = makeTransport({ onSearch: () => searchResponse([feature("S2-pre", "2024-02-10T05:00:00Z", 5)]) });
    const result = await runSatelliteAnalysis(runArgs(baseConfig(), transport));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/claimId|cognitoSub/);
    expect(result).not.toHaveProperty("claimId");
    expect(result).not.toHaveProperty("claim");
    expect(result.evidence).not.toHaveProperty("claimId");
    // The adapter surface has no claim-persistence/mutation operation.
    const surface = [...Object.keys(satelliteIndex), ...Object.keys(satelliteAdapter)];
    expect(surface.filter((key) => /persist|save|mutate|review|approve|reject|transition|override/i.test(key))).toEqual([]);
  });
});

// --- 20. existing PoC tests remain compatible ----------------------------------------------

describe("13.3 Adapter — PoC remains intact", () => {
  it("does not break the Phase 13.2 PoC module surface or behavior", async () => {
    expect(typeof pocSatellite.runPoc).toBe("function");
    expect(pocSatellite.validateAoi(TEST_PARCEL.geometry).ok).toBe(true);
    expect(pocSatellite.POC_OUTCOMES.IMAGERY_FOUND).toBe("IMAGERY_FOUND");

    // A quick offline PoC discovery still works with an injected transport.
    const calls = [];
    const transport = {
      get: vi.fn(),
      post: vi.fn(async (url, body) => {
        calls.push({ url, body });
        const collection = body?.collections?.[0];
        const isPre = String(body?.datetime || "").startsWith(PRE.start);
        if (collection === S1) {
          return searchResponse([feature("S1-x", "2024-03-10T05:00:00Z", undefined)]);
        }
        return searchResponse([
          isPre ? feature("S2-pre", "2024-02-10T05:00:00Z", 5) : feature("S2-post", "2024-04-10T05:00:00Z", 3),
        ]);
      }),
    };
    const pocResult = await pocSatellite.runPoc({
      config: { ...baseConfig({ provider: "cdse", pocVersion: "13.2.0" }), allowPublicFallback: true, fallbackStacUrl: null },
      aoi: TEST_PARCEL.geometry,
      eventDate: TEST_PARCEL.eventDate,
      preWindow: PRE,
      postWindow: POST,
      transport,
    });
    expect(pocResult.outcome).toBe(pocSatellite.POC_OUTCOMES.IMAGERY_FOUND);
    expect(pocResult.evidencePayload.source).toBe("SATELLITE");
  });
});
