// Phase 13.2 — Satellite PoC CLI runner (ISOLATED, non-production).
//
// Usage (from backend/):  node poc/satellite/runPoc.js
//
// Performs a BOUNDED, read-only live discovery for the synthetic test parcel:
//   1. Primary: Copernicus Data Space Ecosystem (CDSE) public STAC catalogue (anonymous search).
//   2. If discovery is unavailable and public fallback is allowed: Microsoft Planetary Computer
//      public STAC (anonymous, throttled) — clearly labelled as a fallback, never as proof that
//      the primary provider works.
//
// It NEVER prints credentials, NEVER writes files, NEVER persists evidence, and NEVER touches the
// production claim/verification flow. Sentinel Hub pixel processing (NDVI statistics) is attempted
// ONLY when CDSE OAuth2 credentials are present in the environment.

import { performance } from "node:perf_hooks";

import { resolvePocConfig, redactPocConfig, POC_PROVIDERS } from "./config.js";
import {
  runPoc,
  POC_OUTCOMES,
  POC_MODES,
  SATELLITE_POC_VERSION,
} from "./satellitePoc.js";
import TEST_PARCEL from "./testPolygon.js";

const FALLBACK_OUTCOMES = new Set([
  POC_OUTCOMES.PROVIDER_ERROR,
  POC_OUTCOMES.TIMEOUT,
  POC_OUTCOMES.IMAGERY_UNAVAILABLE,
]);

const summarize = (result, label) => ({
  label,
  provider: result.provider,
  mode: result.mode,
  outcome: result.outcome,
  evidenceStatus: result.evidenceStatus,
  requestCount: result.requestCount,
  durationMs: result.durationMs,
  sceneCount: result.sceneCount ?? result.optical?.scenes?.length ?? 0,
  opticalSceneCount: result.optical?.scenes?.length ?? 0,
  sarSceneCount: result.sar?.scenes?.length ?? 0,
  bestPre: result.optical?.bestPre
    ? { id: result.optical.bestPre.id, datetime: result.optical.bestPre.datetime, cloudCover: result.optical.bestPre.cloudCover }
    : null,
  bestPost: result.optical?.bestPost
    ? { id: result.optical.bestPost.id, datetime: result.optical.bestPost.datetime, cloudCover: result.optical.bestPost.cloudCover }
    : null,
  sampleOpticalScenes: (result.optical?.scenes || []).slice(0, 8).map((s) => ({
    id: s.id,
    datetime: s.datetime,
    cloudCover: s.cloudCover,
  })),
  sampleSarScenes: (result.sar?.scenes || []).slice(0, 4).map((s) => ({
    id: s.id,
    datetime: s.datetime,
    instrumentMode: s.instrumentMode,
    orbitState: s.orbitState,
  })),
  aoi: result.aoi || null,
  analysis: result.optical?.analysis
    ? {
        beforeNdvi: result.optical.analysis.before?.ndvi ?? null,
        afterNdvi: result.optical.analysis.after?.ndvi ?? null,
        deltaNdvi: result.optical.analysis.deltaNdvi ?? null,
      }
    : null,
  evidenceStatusFromPayload: result.evidencePayload?.status ?? null,
  evidenceOperative: result.evidencePayload?.operative ?? null,
  notes: result.notes || [],
});

const main = async () => {
  const startedAt = performance.now();
  const config = resolvePocConfig();

  const report = {
    pocVersion: SATELLITE_POC_VERSION,
    config: redactPocConfig(config),
    testParcel: {
      label: TEST_PARCEL.label,
      synthetic: TEST_PARCEL.synthetic,
      district: TEST_PARCEL.district,
      state: TEST_PARCEL.state,
      crop: TEST_PARCEL.crop,
      crs: TEST_PARCEL.crs,
    },
    liveProcessingAttempted: config.hasCdseCredentials,
    primary: null,
    fallback: null,
    fallbackUsed: false,
  };

  const baseArgs = {
    config,
    aoi: TEST_PARCEL.geometry,
    eventDate: TEST_PARCEL.eventDate,
    preWindow: TEST_PARCEL.preWindow,
    postWindow: TEST_PARCEL.postWindow,
  };

  const primary = await runPoc(baseArgs);
  report.primary = summarize(primary, `${config.provider} (primary)`);

  if (
    FALLBACK_OUTCOMES.has(primary.outcome) &&
    config.allowPublicFallback &&
    config.fallbackStacUrl &&
    config.fallbackStacUrl !== config.stacUrl
  ) {
    const fallbackConfig = {
      ...config,
      provider: POC_PROVIDERS.PLANETARY_COMPUTER,
      stacUrl: config.fallbackStacUrl,
      tokenUrl: null,
      hasCdseCredentials: false,
    };
    const fallback = await runPoc({ ...baseArgs, config: fallbackConfig });
    report.fallbackUsed = true;
    report.fallback = summarize(fallback, `${fallbackConfig.provider} (public fallback, discovery only)`);
  }

  report.totalDurationMs = Math.round(performance.now() - startedAt);
  report.note =
    "EXPERIMENTAL NON-PRODUCTION PoC. Satellite output is supporting evidence only and never modifies a claim or its status.";

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: "poc-runner-failed", message: String(error?.message || error) }, null, 2)}\n`
  );
  process.exitCode = 1;
});
