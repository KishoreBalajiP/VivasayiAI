// ADR-024 (plan A8) — DEV/E2E-ONLY satellite stand-in (SATELLITE_MODE=mock).
//
// It does not invent a result shape. It answers the REAL adapter (satelliteAdapter.runSatelliteAnalysis)
// through the adapter's own transport seam, with STAC search, OAuth and Statistical API responses shaped
// like the provider's, so every recorded row comes out of the production code path: outcome mapping,
// evidence payload, `metadata.outcome`, fingerprints, and then the normal recordEvidenceRun. No request
// leaves the process: the configuration points at `*.invalid` URLs and the transport never touches the
// network. Credentials here are placeholders, never the CDSE keys from the environment.
//
// SATELLITE_MOCK_OUTCOME (read on every run so the e2e control server can switch it):
//   imagery_found (default)  imagery in both windows, analysis not enabled -> IMAGERY_FOUND / processing disabled
//   supports_loss            analysis runs; NDVI falls 0.62 -> 0.31 (beyond the 0.15 threshold) -> SUPPORTS_LOSS
//   no_change                analysis runs; NDVI 0.62 -> 0.60 -> NO_CHANGE
//   cloud                    every scene above the cloud limit -> CLOUD_OBSCURED
//   provider_error           the catalogue answers HTTP 503 -> PROVIDER_ERROR (rescheduled like a real one)

import { SATELLITE_ADAPTER_VERSION, SATELLITE_PROVIDERS, resolveSatelliteConfig } from "./config.js";

export const MOCK_SATELLITE_OUTCOMES = Object.freeze(["imagery_found", "supports_loss", "no_change", "cloud", "provider_error"]);
export const MOCK_SATELLITE_PROVIDER_LABEL = "cdse-sentinel-mock";

export const mockSatelliteOutcome = (source = process.env) => {
  const value = String(source.SATELLITE_MOCK_OUTCOME || "imagery_found").trim().toLowerCase();
  return MOCK_SATELLITE_OUTCOMES.includes(value) ? value : "imagery_found";
};

const MOCK_BASE = "https://satellite.mock.invalid";
const STAC_URL = `${MOCK_BASE}/stac`;
const TOKEN_URL = `${MOCK_BASE}/oauth/token`;
const STATS_URL = `${MOCK_BASE}/api/v1/statistics`;

const NDVI = Object.freeze({
  supports_loss: { pre: 0.62, post: 0.31 },
  no_change: { pre: 0.62, post: 0.6 },
});

// The adapter configuration for a mock run: defaults from an EMPTY environment (so no real credential
// is ever read), the mock endpoints, and analysis switched on only for the outcomes that need it.
export const mockSatelliteConfig = (outcome) => {
  const analysis = outcome === "supports_loss" || outcome === "no_change";
  return {
    ...resolveSatelliteConfig({}),
    adapterVersion: SATELLITE_ADAPTER_VERSION,
    provider: SATELLITE_PROVIDERS.CDSE_SENTINEL,
    enabled: true,
    processingEnabled: analysis,
    hasCredentials: analysis,
    clientId: analysis ? "mock-client" : null,
    clientSecret: analysis ? "mock-secret" : null,
    maxRetries: 0,
    requestTimeoutMs: 1000,
    stacUrl: STAC_URL,
    tokenUrl: TOKEN_URL,
    statisticsUrl: STATS_URL,
  };
};

const midpoint = (window) => {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  return new Date(Math.round((start + end) / 2)).toISOString();
};

const scene = ({ id, datetime, cloudPercent }) => ({
  type: "Feature",
  stac_version: "1.0.0",
  id,
  collection: "sentinel-2-l2a",
  bbox: [79.13, 10.78, 79.14, 10.8],
  properties: { datetime, "eo:cloud_cover": cloudPercent, platform: "sentinel-2b", constellation: "sentinel-2" },
});

const statsBody = ({ ndvi, from }) => ({
  status: 200,
  data: {
    status: "OK",
    data: [
      {
        interval: { from, to: new Date(Date.parse(from) + 24 * 60 * 60 * 1000).toISOString() },
        outputs: { ndvi: { bands: { B0: { stats: { min: ndvi - 0.1, max: ndvi + 0.1, mean: ndvi, stDev: 0.05, sampleCount: 400, noDataCount: 20 } } } } },
      },
    ],
  },
});

const httpError = (status, message) => Object.assign(new Error(message), { response: { status, data: {} }, status });

// The transport the adapter's HTTP client calls instead of axios. It answers by URL, like the provider.
export const createMockSatelliteTransport = ({ outcome, preWindow, postWindow }) => {
  const calls = [];
  const windowOf = (datetime) => (String(datetime || "").startsWith(String(preWindow?.start)) ? "pre" : "post");
  const post = async (url, body) => {
    calls.push({ url: String(url) });
    if (url === `${STAC_URL}/search`) {
      if (outcome === "provider_error") throw httpError(503, "Service Unavailable");
      const which = windowOf(body && body.datetime);
      const window = which === "pre" ? preWindow : postWindow;
      return {
        status: 200,
        data: {
          type: "FeatureCollection",
          features: [scene({ id: `MOCK_S2_${which.toUpperCase()}_1`, datetime: midpoint(window), cloudPercent: outcome === "cloud" ? 96 : 8 })],
        },
      };
    }
    if (url === TOKEN_URL) return { status: 200, data: { access_token: "mock-access-token", expires_in: 600, token_type: "Bearer" } };
    if (url === STATS_URL) {
      const values = NDVI[outcome] || NDVI.no_change;
      const range = body && body.aggregation && body.aggregation.timeRange;
      const from = range && range.from ? range.from : postWindow.start;
      const isPre = String(from).startsWith(String(preWindow?.start));
      return statsBody({ ndvi: isPre ? values.pre : values.post, from: midpoint(isPre ? preWindow : postWindow) });
    }
    throw httpError(404, "Not Found");
  };
  return {
    calls,
    get: async (url) => {
      calls.push({ url: String(url) });
      throw httpError(404, "Not Found");
    },
    post,
  };
};

export default {
  MOCK_SATELLITE_OUTCOMES,
  MOCK_SATELLITE_PROVIDER_LABEL,
  mockSatelliteOutcome,
  mockSatelliteConfig,
  createMockSatelliteTransport,
};
