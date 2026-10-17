import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// ADR-024 (plan A8, MK-1/MK-2) — the weather and satellite dev/e2e seams. WEATHER_MODE / SATELLITE_MODE
// and their *_MOCK_OUTCOME selectors are read on every call (the e2e control server switches them
// between tests). Satellite mock runs go through the REAL adapter and the normal recordEvidenceRun, so
// the farmer's satellite status comes out of the production display mapping. A loopback-only network
// guard is installed for the whole file: any attempt to reach Open-Meteo or Copernicus would throw and
// be recorded.

import VerificationEvidence from "../models/VerificationEvidence.js";
import LossClaim from "../models/LossClaim.js";
import { fetchEventRainfall, MOCK_WEATHER_OUTCOMES } from "../services/weatherArchive.service.js";
import { getWeather } from "../services/weather.service.js";
import { runSatelliteVerificationForClaim } from "../services/satelliteVerification.service.js";
import { MOCK_SATELLITE_OUTCOMES, MOCK_SATELLITE_PROVIDER_LABEL } from "../services/satellite/mockProvider.js";
import { satelliteMode, weatherMode } from "../config/env.js";
import { installNetworkGuard, uninstallNetworkGuard, networkViolations } from "../scripts/e2e/lib/networkGuard.js";
import { api, authHeader, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";
import { createClaim, daysAgo, resetDatabase, seedFarmer, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const KEYS = ["WEATHER_MODE", "WEATHER_MOCK_OUTCOME", "SATELLITE_MODE", "SATELLITE_MOCK_OUTCOME"];
const saved = {};
const setEnv = (values) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};
// An http client that must never be called (the mock answers without the network).
const forbiddenHttp = () => {
  const calls = [];
  const fail = (url) => {
    calls.push(String(url));
    throw new Error("network call in mock mode");
  };
  return { calls, get: fail, post: fail };
};
const GEOMETRY = squareGeometry(0.0015, [79.135, 10.79]);
const NOW = new Date("2026-10-16T08:00:00Z");

describe("weather and satellite mock modes (MK)", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
    installNetworkGuard({ label: "TEST" });
  });
  afterAll(async () => {
    uninstallNetworkGuard();
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    for (const key of KEYS) saved[key] = process.env[key];
    await resetDatabase();
  });
  afterEach(() => {
    setEnv(saved);
  });

  it("MK-1: WEATHER_MODE=mock answers a deterministic rainfall series (or the selected failure) and WEATHER_MODE=off a disabled result, with no HTTP call; /weather answers a canned forecast", async () => {
    const http = forbiddenHttp();
    // live by default; an unknown value is live too (a typo never switches a seam on)
    setEnv({ WEATHER_MODE: undefined });
    expect(weatherMode()).toBe("live");
    setEnv({ WEATHER_MODE: "mok" });
    expect(weatherMode()).toBe("live");

    setEnv({ WEATHER_MODE: "mock", WEATHER_MOCK_OUTCOME: undefined });
    const first = await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-10-13", daysBefore: 3, daysAfter: 1, now: NOW, http });
    const second = await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-10-13", daysBefore: 3, daysAfter: 1, now: NOW, http });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "AVAILABLE",
      api: "mock",
      provider: "mock-weather",
      window: { start: "2026-10-10", end: "2026-10-14" },
      rainfallTotalMm: 42,
      rainfallPeakMm: 30,
      daysWithRain: 2,
      locationRounded: { latitude: 10.79, longitude: 79.14 },
    });
    expect(first.dailyMm).toEqual([
      { date: "2026-10-10", mm: 0 },
      { date: "2026-10-11", mm: 0 },
      { date: "2026-10-12", mm: 12 },
      { date: "2026-10-13", mm: 30 },
      { date: "2026-10-14", mm: 0 },
    ]);
    // The outcome selector is read on every call.
    expect(MOCK_WEATHER_OUTCOMES).toEqual(["available", "unavailable", "timeout"]);
    setEnv({ WEATHER_MOCK_OUTCOME: "unavailable" });
    expect(await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-10-13", now: NOW, http })).toEqual({ status: "UNAVAILABLE", reason: "provider_error", provider: "mock-weather" });
    setEnv({ WEATHER_MOCK_OUTCOME: "timeout" });
    expect(await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-10-13", now: NOW, http })).toEqual({ status: "UNAVAILABLE", reason: "timeout", provider: "mock-weather" });
    // The real input checks still apply in mock mode.
    expect(await fetchEventRainfall({ geometry: null, eventDate: "2026-10-13", now: NOW, http })).toEqual({ status: "UNAVAILABLE", reason: "no_usable_geometry" });

    setEnv({ WEATHER_MODE: "off" });
    expect(await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-10-13", now: NOW, http })).toEqual({ status: "UNAVAILABLE", reason: "weather_disabled" });
    expect(http.calls).toEqual([]);

    // The app shell's /weather: a canned forecast with no District, cache or Open-Meteo access.
    setEnv({ WEATHER_MODE: "mock", WEATHER_MOCK_OUTCOME: "available" });
    const forecast = await getWeather("Thanjavur");
    expect(forecast).toMatchObject({ district: "thanjavur", source: "mock", cached: false, freshness: "fresh", current: { temperature: 29.5, summary: "Slight rain" } });
    expect(forecast.forecast).toHaveLength(3);
    const viaApi = await api().get("/weather?district=Thanjavur").set(authHeader("mk1-user"));
    expect(viaApi.status).toBe(200);
    expect(viaApi.body.data).toMatchObject({ source: "mock" });
    setEnv({ WEATHER_MOCK_OUTCOME: "timeout" });
    expect(await getWeather("Thanjavur")).toMatchObject({ status: "unknown", current: null, forecast: [], source: "mock" });
    setEnv({ WEATHER_MODE: "off" });
    expect(await getWeather("Thanjavur")).toMatchObject({ status: "unknown", current: null, forecast: [] });
    expect(networkViolations()).toEqual([]);
  });

  it("MK-2: SATELLITE_MODE=mock records adapter-shaped runs through recordEvidenceRun (imagery_found -> unavailable/analysis_not_enabled, supports_loss -> passed, ...); off records CONFIG_DISABLED -> unavailable/not_enabled", async () => {
    expect(MOCK_SATELLITE_OUTCOMES).toEqual(["imagery_found", "supports_loss", "no_change", "cloud", "provider_error"]);
    setEnv({ SATELLITE_MODE: "mock" });
    expect(satelliteMode()).toBe("mock");

    const cases = [
      [undefined, { outcome: "IMAGERY_FOUND", status: "PENDING", processingStatus: "disabled" }, { status: "unavailable", reasonCode: "analysis_not_enabled" }],
      ["supports_loss", { outcome: "ANALYSIS_COMPLETE", status: "AVAILABLE", processingStatus: "executed", analysisOutcome: "SUPPORTS_LOSS" }, { status: "passed", reasonCode: "vegetation_drop_consistent_with_damage" }],
      ["no_change", { outcome: "ANALYSIS_COMPLETE", status: "AVAILABLE", processingStatus: "executed", analysisOutcome: "NO_CHANGE" }, { status: "inconclusive", reasonCode: "no_clear_vegetation_change" }],
      ["cloud", { outcome: "CLOUD_OBSCURED", status: "INSUFFICIENT", processingStatus: null }, { status: "inconclusive", reasonCode: "cloud_cover" }],
      ["provider_error", { outcome: "PROVIDER_ERROR", status: "UNAVAILABLE", processingStatus: null }, { status: "unavailable", reasonCode: "provider_unavailable" }],
    ];
    for (const [selector, recorded, shown] of cases) {
      setEnv({ SATELLITE_MODE: "mock", SATELLITE_MOCK_OUTCOME: selector });
      const farmer = await seedFarmer(`mk2-${selector || "default"}`, { origin: [79.135, 10.79], parcelSize: 0.0015 });
      const claimId = await createClaim(farmer, { geometry: squareGeometry(0.0015, [79.135, 10.79]), eventDaysAgo: 3 });
      await uploadPhoto(farmer.user, claimId);
      await submitClaim(farmer.user, claimId);
      const claim = await LossClaim.findById(claimId);
      const result = await runSatelliteVerificationForClaim({ claimId, cognitoSub: farmer.user, claim });
      expect({ selector, recorded: result.recorded, outcome: result.run.outcome }).toEqual({ selector, recorded: true, outcome: recorded.outcome });

      const rows = await VerificationEvidence.find({ claimId, component: "satellite" }).lean();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect({ selector, status: row.status }).toEqual({ selector, status: recorded.status });
      expect(row.provider).toBe(MOCK_SATELLITE_PROVIDER_LABEL);
      expect(row.metadata).toMatchObject({ outcome: recorded.outcome, processingStatus: recorded.processingStatus, simulated: true, liveProcessingValidated: false });
      if (recorded.analysisOutcome) expect(row.result.analysisOutcome).toBe(recorded.analysisOutcome);
      // The farmer's view, from the production display mapping.
      const progress = await api().get(`/claims/${claimId}/progress`).set(authHeader(farmer.user));
      expect(progress.status).toBe(200);
      expect({ selector, ...progress.body.data.progress.satellite }).toMatchObject({ selector, ...shown, supportingOnly: true });
    }

    // off: the adapter runs switched off (as SATELLITE_ENABLED=false) and that is what is recorded.
    setEnv({ SATELLITE_MODE: "off", SATELLITE_MOCK_OUTCOME: "supports_loss" });
    const farmer = await seedFarmer("mk2-off", { origin: [79.135, 10.79], parcelSize: 0.0015 });
    const claimId = await createClaim(farmer, { geometry: squareGeometry(0.0015, [79.135, 10.79]), eventDaysAgo: 3 });
    const claim = await LossClaim.findById(claimId);
    const off = await runSatelliteVerificationForClaim({ claimId, cognitoSub: farmer.user, claim });
    expect(off.run.outcome).toBe("CONFIG_DISABLED");
    const [offRow] = await VerificationEvidence.find({ claimId, component: "satellite" }).lean();
    expect(offRow).toMatchObject({ status: "NOT_CHECKED", metadata: { outcome: "CONFIG_DISABLED" } });
    expect(offRow.metadata.simulated).toBeUndefined();
    const progress = await api().get(`/claims/${claimId}/progress`).set(authHeader(farmer.user));
    expect(progress.body.data.progress.satellite).toMatchObject({ status: "unavailable", reasonCode: "not_enabled" });

    // An event today (UTC): the post-event window is not open, nothing is recorded, a re-check is due.
    setEnv({ SATELLITE_MODE: "mock", SATELLITE_MOCK_OUTCOME: "supports_loss" });
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();
    const pending = await runSatelliteVerificationForClaim({ claimId, cognitoSub: farmer.user, claim: { ...claim.toObject(), eventDate: todayUtc } });
    expect(pending).toMatchObject({ recorded: false, skipped: "post_window_not_open" });
    expect(pending.rescheduleAt).toBeInstanceOf(Date);
    expect(daysAgo(0)).toBeTruthy();

    expect(networkViolations()).toEqual([]);
  });
});
