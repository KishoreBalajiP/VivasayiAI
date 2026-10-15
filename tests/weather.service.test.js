import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock("axios", () => ({ default: { create: () => ({ get: (...args) => mockGet(...args), post: vi.fn() }), get: vi.fn(), post: vi.fn() } }));

import District from "../models/District.js";
import WeatherCache from "../models/WeatherCache.js";
import { getWeather } from "../services/weather.service.js";
import { startTestDatabase, stopTestDatabase } from "./helpers.js";

// Weather for chat context. Regressions: district coordinates were looked up by free-text global
// geocoding even though the reference data holds them (so "Salem" could resolve outside India),
// the forecast was a single day, and cache keys differed by whitespace.

const forecastPayload = {
  data: {
    current: { temperature_2m: 30, wind_speed_10m: 8, weather_code: 1, is_day: 1 },
    daily: {
      time: ["2026-10-16", "2026-10-17", "2026-10-18"],
      temperature_2m_max: [32, 31, 30], temperature_2m_min: [24, 24, 23],
      weather_code: [1, 61, 3], precipitation_sum: [0, 12.5, 3],
    },
  },
};

const callsTo = (fragment) => mockGet.mock.calls.filter((call) => String(call[0]).includes(fragment));

describe("weather service", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await District.deleteMany({});
    await WeatherCache.deleteMany({});
    mockGet.mockReset();
    mockGet.mockImplementation(async (url) => {
      if (String(url).includes("/search")) return { data: { results: [{ name: "Geocoded", latitude: 1, longitude: 2 }] } };
      return forecastPayload;
    });
  });

  it("WS-1: a district in the reference data uses its stored coordinates, with no free-text geocoding", async () => {
    await District.create({ name: "Salem", lat: 11.66, lon: 78.15, regionType: "Hill" });
    const result = await getWeather("Salem");
    expect(callsTo("/search")).toHaveLength(0);
    const forecastCall = callsTo("/forecast")[0];
    expect(forecastCall[1].params).toMatchObject({ latitude: 11.66, longitude: 78.15 });
    expect(result.current.temperature).toBe(30);
  });

  it("WS-2: the reference lookup is case-insensitive", async () => {
    await District.create({ name: "Thanjavur", lat: 10.78, lon: 79.14, regionType: "Delta" });
    await getWeather("thanjavur");
    expect(callsTo("/search")).toHaveLength(0);
  });

  it("WS-3: an unknown district falls back to geocoding restricted to India", async () => {
    await getWeather("Villagename");
    const search = callsTo("/search")[0];
    expect(search[1].params.countryCode).toBe("IN");
  });

  it("WS-4: three forecast days with rainfall are returned", async () => {
    await District.create({ name: "Madurai", lat: 9.93, lon: 78.12, regionType: "Plains" });
    const result = await getWeather("Madurai");
    expect(callsTo("/forecast")[0][1].params.forecast_days).toBe(3);
    expect(result.forecast).toHaveLength(3);
    expect(result.forecast[1]).toMatchObject({ date: "2026-10-17", precipitation: 12.5 });
  });

  it("WS-5: surrounding whitespace and case share one cache entry", async () => {
    await District.create({ name: "Madurai", lat: 9.93, lon: 78.12, regionType: "Plains" });
    await getWeather("Madurai");
    const again = await getWeather("  madurai ");
    expect(again.cached).toBe(true);
    expect(callsTo("/forecast")).toHaveLength(1);
  });

  it("WS-6: a provider failure degrades to unknown, never an invented reading", async () => {
    await District.create({ name: "Madurai", lat: 9.93, lon: 78.12, regionType: "Plains" });
    mockGet.mockRejectedValue(new Error("down"));
    const result = await getWeather("Madurai");
    expect(result.status).toBe("unknown");
    expect(result.current).toBeNull();
  });
});
