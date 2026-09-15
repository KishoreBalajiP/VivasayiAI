// Weather service configuration (D-15/D-16/D-17/D-18, E2-S1).
// Reference data (the 38 TN districts) is E2-S2 work and is NOT hardcoded here — that list
// belongs in the `districts` reference collection, seeded by a separate task. This service
// accepts a district by name and resolves it to coordinates via Open-Meteo geocoding; an
// unknown/unsupported district degrades to `unknown` (D-18), never a crash.
import { env } from "./env.js";

const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000; // 30-minute cache (14_Deployment §4 / 09 §5)
const WEATHER_FETCH_TIMEOUT_MS = 5000; // never let an upstream hang block a response
const WEATHER_STALE_AFTER_MS = 60 * 60 * 1000; // stale cache honored for up to 1 hour (D-18)

export const weatherConfig = Object.freeze({
  cacheTtlMs: Number(env.weatherCacheTtlMs) || WEATHER_CACHE_TTL_MS,
  fetchTimeoutMs: Number(env.weatherFetchTimeoutMs) || WEATHER_FETCH_TIMEOUT_MS,
  staleAfterMs: Number(env.weatherStaleAfterMs) || WEATHER_STALE_AFTER_MS,
  openMeteoBase: env.openMeteoBase || "https://api.open-meteo.com/v1",
  geocodingBase: env.openMeteoGeocodingBase || "https://geocoding-api.open-meteo.com/v1",
  userAgent: "vivasayi-backend-weather/1.0",
});

export default weatherConfig;
