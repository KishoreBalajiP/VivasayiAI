// Phase 13.2 — Satellite PoC focused unit tests (ISOLATED, non-production).
//
// These tests are fully OFFLINE and deterministic: every provider interaction goes through an
// injected transport. A mocked provider success proves the PoC's own logic only — it is NOT proof
// that any live provider works. Live validation (when possible) is recorded in the Phase 13.2
// report, separately from these tests.

import { describe, it, expect, vi } from "vitest";

import {
  runPoc,
  validateAoi,
  validateDateRange,
  computeNdvi,
  ndviFromBandMeans,
  ndviDelta,
  parseStatisticalResponse,
  buildSatelliteEvidencePayload,
  classifyHttpError,
  mapOutcomeToEvidenceStatus,
  createHttpClient,
  searchScenes,
  fetchCdseToken,
  SatellitePocError,
  POC_OUTCOMES,
  POC_MODES,
  EVIDENCE_STATUS_BY_OUTCOME,
} from "../poc/satellite/satellitePoc.js";
import {
  EVIDENCE_STATUSES,
  OPERATIVE_EVIDENCE_SOURCES,
  FUTURE_EVIDENCE_SOURCES,
  buildVerificationEvidence,
} from "../utils/verificationEvidence.js";
import satellitePoc from "../poc/satellite/satellitePoc.js";
import { resolvePocConfig, redactPocConfig } from "../poc/satellite/config.js";
import TEST_PARCEL from "../poc/satellite/testPolygon.js";
import { CLAIM_STATES } from "../models/LossClaim.js";

// --- fixtures -------------------------------------------------------------------------------

const S2 = "sentinel-2-l2a";
const S1 = "sentinel-1-grd";

const baseConfig = (overrides = {}) => ({
  pocVersion: "13.2.0",
  provider: "cdse",
  enabled: true,
  allowPublicFallback: true,
  requestTimeoutMs: 1000,
  maxRetries: 0,
  maxScenes: 10,
  cloudMaxFraction: 0.3,
  stacUrl: "https://catalogue.test/stac",
  tokenUrl: "https://token.test/oauth",
  statisticsUrl: "https://stats.test/api/v1/statistics",
  fallbackStacUrl: "https://fallback.test/api/stac/v1",
  clientId: null,
  clientSecret: null,
  hasCdseCredentials: false,
  ...overrides,
});

const scene = (id, datetime, cloudCover) => ({
  id,
  properties: { datetime, "eo:cloud_cover": cloudCover },
});

const searchResponse = (features) => ({
  status: 200,
  data: { type: "FeatureCollection", features },
});

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

const httpError = (status, data = {}) => {
  const error = new Error(`HTTP ${status}`);
  error.response = { status, data };
  return error;
};

const timeoutError = () => {
  const error = new Error("timeout of 1000ms exceeded");
  error.code = "ECONNABORTED";
  return error;
};

// Routes STAC search requests by collection; records every call (url + body) for assertions.
const routedTransport = ({ s2, s1, calls, onS2, onS1 }) => ({
  get: vi.fn(),
  post: vi.fn(async (url, body) => {
    calls.push({ url, body });
    if (String(url).endsWith("/search")) {
      const collection = body?.collections?.[0];
      if (collection === S2) {
        if (onS2) return onS2(body);
        return searchResponse(s2 || []);
      }
      if (collection === S1) {
        if (onS1) return onS1(body);
        return searchResponse(s1 || []);
      }
      return searchResponse([]);
    }
    throw new Error(`unexpected url ${url}`);
  }),
});

const optimisticScenes = () => [
  scene("S2-pre", "2024-02-10T05:00:00Z", 5),
  scene("S2-post", "2024-04-10T05:00:00Z", 3),
];

const runArgs = (config, transport) => ({
  config,
  aoi: TEST_PARCEL.geometry,
  eventDate: TEST_PARCEL.eventDate,
  preWindow: TEST_PARCEL.preWindow,
  postWindow: TEST_PARCEL.postWindow,
  transport,
});

// --- 1. valid polygon --------------------------------------------------------------------

describe("13.2 PoC — test geometry", () => {
  it("accepts the synthetic test polygon and reports a bounded extent", () => {
    const result = validateAoi(TEST_PARCEL.geometry);
    expect(result.ok).toBe(true);
    expect(result.acres).toBeGreaterThan(0.5);
    expect(result.acres).toBeLessThan(2);
    expect(result.bbox).toHaveLength(4);
    expect(result.extentMeters.width).toBeGreaterThan(0);
    expect(TEST_PARCEL.synthetic).toBe(true);
  });

  // --- 2. invalid polygon ----------------------------------------------------------------
  it("rejects invalid polygons (open ring, zero area, non-polygon)", () => {
    expect(validateAoi({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 1]]] }).ok).toBe(false);
    expect(validateAoi({ type: "Point", coordinates: [0, 0] }).ok).toBe(false);
    expect(
      validateAoi({
        type: "Polygon",
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2], [0.1, 0.2], [0.1, 0.1]]],
      }).ok
    ).toBe(false);
  });

  // --- 3. date range ---------------------------------------------------------------------
  it("validates date ranges and rejects reversed, future, and over-long windows", () => {
    expect(validateDateRange({ start: "2024-01-01T00:00:00Z", end: "2024-03-01T00:00:00Z", now: new Date("2025-01-01") }).ok).toBe(true);
    expect(validateDateRange({ start: "2024-03-01T00:00:00Z", end: "2024-01-01T00:00:00Z" }).ok).toBe(false);
    expect(validateDateRange({ start: "2099-01-01T00:00:00Z", end: "2099-02-01T00:00:00Z", now: new Date("2025-01-01") }).ok).toBe(false);
    expect(validateDateRange({ start: "2020-01-01T00:00:00Z", end: "2021-01-01T00:00:00Z", now: new Date("2025-01-01") }).ok).toBe(false);
    expect(validateDateRange({ start: "not-a-date", end: "2024-01-01T00:00:00Z" }).ok).toBe(false);
  });
});

// --- 4. missing credentials --------------------------------------------------------------
describe("13.2 PoC — credentials", () => {
  it("reports missing credentials safely and never calls the token endpoint", async () => {
    const config = resolvePocConfig({});
    expect(config.hasCdseCredentials).toBe(false);

    const redacted = redactPocConfig(config);
    expect(redacted).not.toHaveProperty("clientId");
    expect(redacted).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(redacted)).not.toMatch(/secret/i);

    const calls = [];
    const transport = routedTransport({ s2: optimisticScenes(), s1: [], calls });
    const result = await runPoc(runArgs(config, transport));

    expect(result.outcome).toBe(POC_OUTCOMES.IMAGERY_FOUND);
    expect(result.mode).toBe(POC_MODES.DISCOVERY_ONLY);
    expect(result.evidenceStatus).toBe("PENDING");
    expect(result.optical.analysis).toBeNull();
    const tokenCalls = calls.filter((call) => String(call.url).includes("token"));
    expect(tokenCalls).toHaveLength(0);
  });

  it("never serializes a credential value into the result", async () => {
    const config = baseConfig({ hasCdseCredentials: true, clientId: "id-123", clientSecret: "super-secret-value" });
    const calls = [];
    const transport = {
      get: vi.fn(),
      post: vi.fn(async (url, body) => {
        calls.push({ url, body });
        if (String(url).endsWith("/search")) return searchResponse(optimisticScenes());
        if (url === config.tokenUrl) return { status: 200, data: { access_token: "tok-abc", expires_in: 600 } };
        return statsResponse(0.1, 0.4);
      }),
    };
    const result = await runPoc(runArgs(config, transport));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("tok-abc");
    expect(serialized).not.toContain("id-123");
  });
});

// --- 5. timeout --------------------------------------------------------------------------
describe("13.2 PoC — provider failures", () => {
  it("handles a provider timeout as UNAVAILABLE without throwing", async () => {
    const calls = [];
    const transport = routedTransport({
      calls,
      onS2: () => {
        throw timeoutError();
      },
    });
    const result = await runPoc(runArgs(baseConfig(), transport));
    expect(result.outcome).toBe(POC_OUTCOMES.TIMEOUT);
    expect(result.mode).toBe(POC_MODES.BLOCKED);
    expect(result.evidenceStatus).toBe("UNAVAILABLE");
  });

  // --- 6. auth + quota -------------------------------------------------------------------
  it("handles provider auth and quota errors as UNAVAILABLE without throwing", async () => {
    const authCalls = [];
    const auth = await runPoc(
      runArgs(baseConfig(), routedTransport({ calls: authCalls, onS2: () => { throw httpError(401); } }))
    );
    expect(auth.outcome).toBe(POC_OUTCOMES.AUTH_REQUIRED);
    expect(auth.evidenceStatus).toBe("UNAVAILABLE");

    const quotaCalls = [];
    const quota = await runPoc(
      runArgs(baseConfig(), routedTransport({ calls: quotaCalls, onS2: () => { throw httpError(429); } }))
    );
    expect(quota.outcome).toBe(POC_OUTCOMES.QUOTA_EXCEEDED);
    expect(quota.evidenceStatus).toBe("UNAVAILABLE");
  });

  it("classifies errors and wraps the token call with a bounded kind", async () => {
    expect(classifyHttpError(timeoutError())).toBe("TIMEOUT");
    expect(classifyHttpError(httpError(401))).toBe("AUTH");
    expect(classifyHttpError(httpError(429))).toBe("QUOTA");
    expect(classifyHttpError(httpError(500))).toBe("PROVIDER");
    expect(classifyHttpError({ code: "ENOTFOUND" })).toBe("NETWORK");

    await expect(
      fetchCdseToken({
        config: baseConfig({ hasCdseCredentials: true, clientId: "a", clientSecret: "b" }),
        http: createHttpClient({
          timeoutMs: 100,
          maxRetries: 0,
          transport: {
            get: async () => ({ status: 200, data: {} }),
            post: async () => {
              throw httpError(401);
            },
          },
        }),
      })
    ).rejects.toBeInstanceOf(SatellitePocError);
  });

  it("bounds retries (maxRetries) and only retries retryable failures", async () => {
    let attempts = 0;
    const transport = {
      get: vi.fn(),
      post: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw httpError(503);
        return searchResponse([]);
      }),
    };
    const http = createHttpClient({ timeoutMs: 100, maxRetries: 2, transport });
    await searchScenes({ http, endpoint: "https://x.test/search", provider: "cdse", collection: S2, bbox: [0, 0, 1, 1], start: "2024-01-01T00:00:00Z", end: "2024-02-01T00:00:00Z" });
    expect(attempts).toBe(3);

    let authAttempts = 0;
    const authTransport = {
      get: vi.fn(),
      post: vi.fn(async () => {
        authAttempts += 1;
        throw httpError(401);
      }),
    };
    const authHttp = createHttpClient({ timeoutMs: 100, maxRetries: 2, transport: authTransport });
    await expect(
      searchScenes({ http: authHttp, endpoint: "https://x.test/search", provider: "cdse", collection: S2, bbox: [0, 0, 1, 1], start: "2024-01-01T00:00:00Z", end: "2024-02-01T00:00:00Z" })
    ).rejects.toBeInstanceOf(SatellitePocError);
    expect(authAttempts).toBe(1);
  });
});

// --- 7. missing imagery ------------------------------------------------------------------
describe("13.2 PoC — imagery availability", () => {
  it("reports missing imagery as UNAVAILABLE (never a negative agricultural finding)", async () => {
    const calls = [];
    const result = await runPoc(runArgs(baseConfig(), routedTransport({ s2: [], s1: [], calls })));
    expect(result.outcome).toBe(POC_OUTCOMES.IMAGERY_UNAVAILABLE);
    expect(result.evidenceStatus).toBe("UNAVAILABLE");
    expect(result.optical.scenes).toHaveLength(0);
    expect(result.sceneCount).toBe(0);
    expect(result.evidenceResult || {}).not.toHaveProperty("damage");
  });

  // --- 9. no fabricated data -------------------------------------------------------------
  it("never fabricates scene data when discovery fails", async () => {
    const calls = [];
    const result = await runPoc(
      runArgs(baseConfig(), routedTransport({ calls, onS2: () => { throw httpError(500); } }))
    );
    expect(result.optical.scenes).toHaveLength(0);
    expect(result.mode).toBe(POC_MODES.BLOCKED);
    expect(JSON.stringify(result.evidencePayload.result || {})).not.toMatch(/S2-/);
  });

  // --- 8. cloud obscured -----------------------------------------------------------------
  it("treats fully cloud-obscured imagery as INSUFFICIENT, not as damage", async () => {
    const calls = [];
    const cloudy = [
      scene("S2-pre", "2024-02-10T05:00:00Z", 92),
      scene("S2-post", "2024-04-10T05:00:00Z", 88),
    ];
    const result = await runPoc(runArgs(baseConfig(), routedTransport({ s2: cloudy, s1: [], calls })));
    expect(result.outcome).toBe(POC_OUTCOMES.CLOUD_OBSCURED);
    expect(result.evidenceStatus).toBe("INSUFFICIENT");
    expect(result.optical.analysis).toBeNull();
    expect(result.evidenceResult.cloudObscured).toBe(true);
    expect(result.evidenceResult.analyzed).toBe(false);
  });

  it("treats a single-sided window as INSUFFICIENT_TEMPORAL_COVERAGE", async () => {
    const calls = [];
    const onlyPost = [scene("S2-post", "2024-04-10T05:00:00Z", 3)];
    const result = await runPoc(runArgs(baseConfig(), routedTransport({ s2: onlyPost, s1: [], calls })));
    expect(result.outcome).toBe(POC_OUTCOMES.INSUFFICIENT_TEMPORAL_COVERAGE);
    expect(result.evidenceStatus).toBe("INSUFFICIENT");
  });
});

// --- 10. traceability --------------------------------------------------------------------
describe("13.2 PoC — traceable analysis", () => {
  it("computes a pre/post NDVI comparison with traceable provider/product/version metadata", async () => {
    let statsCall = 0;
    const config = baseConfig({ hasCdseCredentials: true, clientId: "a", clientSecret: "b" });
    const calls = [];
    const transport = {
      get: vi.fn(),
      post: vi.fn(async (url, body) => {
        calls.push({ url, body });
        if (String(url).endsWith("/search")) return searchResponse(optimisticScenes());
        if (url === config.tokenUrl) return { status: 200, data: { access_token: "tok", expires_in: 600 } };
        statsCall += 1;
        return statsCall === 1 ? statsResponse(0.1, 0.4) : statsResponse(0.2, 0.3);
      }),
    };
    const result = await runPoc(runArgs(config, transport));

    expect(result.outcome).toBe(POC_OUTCOMES.ANALYSIS_COMPLETE);
    expect(result.mode).toBe(POC_MODES.LIVE);
    expect(result.optical.analysis.before.ndvi).toBeCloseTo(0.6, 5);
    expect(result.optical.analysis.after.ndvi).toBeCloseTo(0.2, 5);
    expect(result.optical.analysis.deltaNdvi).toBeCloseTo(-0.4, 5);

    expect(result.evidencePayload.source).toBe("SATELLITE");
    expect(result.evidencePayload.provider).toBe("cdse");
    expect(result.evidencePayload.providerVersion).toBe("13.2.0");
    expect(result.evidencePayload.evidenceVersion).toBe("13.2.0");
    expect(result.evidencePayload.evaluationVersion).toBe("poc-ndvi-v1");
    expect(result.evidencePayload.reference).toMatch(/^[0-9a-f]{16}$/);
    expect(result.optical.scenes.map((s) => s.id)).toEqual(["S2-pre", "S2-post"]);
  });

  it("parses NDVI helpers and Statistical API responses defensively", () => {
    expect(computeNdvi(0.1, 0.5)).toBeCloseTo(0.6666667, 5);
    expect(computeNdvi(0, 0)).toBeNull();
    expect(computeNdvi("x", 1)).toBeNull();
    expect(ndviFromBandMeans({ redMean: 0.2, nirMean: 0.6 })).toBeCloseTo(0.5, 5);
    expect(ndviDelta(0.6, 0.2)).toBeCloseTo(-0.4, 5);
    expect(ndviDelta(null, 0.2)).toBeNull();
    expect(parseStatisticalResponse({ data: [] }).ok).toBe(false);
    expect(parseStatisticalResponse(statsResponse(0.1, 0.4)).ndvi).toBeCloseTo(0.6, 5);
  });
});

// --- 11. claim-safety --------------------------------------------------------------------
describe("13.2 PoC — claim-decision boundaries", () => {
  it("uses only evidence statuses and never a claim lifecycle state", () => {
    const claimStates = new Set(CLAIM_STATES);
    for (const outcome of Object.keys(EVIDENCE_STATUS_BY_OUTCOME)) {
      const status = mapOutcomeToEvidenceStatus(outcome);
      expect(EVIDENCE_STATUSES).toContain(status);
      expect(claimStates.has(status)).toBe(false);
    }
  });

  it("produces non-operative SATELLITE evidence only and exposes no engine/decision API", () => {
    const payload = buildSatelliteEvidencePayload({
      config: baseConfig(),
      outcome: POC_OUTCOMES.ANALYSIS_COMPLETE,
      aoiMeta: { fingerprint: "abc123abc123abcd" },
      result: { analyzed: true },
    });
    expect(payload.source).toBe("SATELLITE");
    expect(payload.operative).toBe(false);
    expect(EVIDENCE_STATUSES).toContain(payload.status);

    const mod = satellitePoc;
    const forbidden = Object.keys(mod).filter((key) =>
      /transition|approve|reject|compensat|override|engine|claimstate/i.test(key)
    );
    expect(forbidden).toEqual([]);
    expect(OPERATIVE_EVIDENCE_SOURCES).not.toContain("SATELLITE");
    expect(FUTURE_EVIDENCE_SOURCES).toContain("SATELLITE");
  });
});

// --- 12. existing behavior unchanged -----------------------------------------------------
describe("13.2 PoC — existing evidence foundation unchanged", () => {
  it("keeps the frozen operative/future source split and non-operative SATELLITE", () => {
    expect(OPERATIVE_EVIDENCE_SOURCES).toEqual(["GEOMETRY", "AI_IMAGE", "WEATHER"]);
    expect(FUTURE_EVIDENCE_SOURCES).toEqual(["OWNERSHIP", "SATELLITE"]);
    const direct = buildVerificationEvidence({ source: "SATELLITE", status: "AVAILABLE" });
    expect(direct.operative).toBe(false);
    expect(direct.status).toBe("AVAILABLE");
  });
});
