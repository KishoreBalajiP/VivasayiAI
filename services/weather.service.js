import axios from "axios";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import WeatherCache from "../models/WeatherCache.js";
import weatherConfig from "../config/weather.js";
import { env } from "../config/env.js";

// Open-Meteo weather-code reference (for translating WMO codes to short labels in the
// cached payload — no magic numbers; single source of truth). Kept minimal and stable.
const WMO_SUMMARY = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow fall", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
  82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};
const summarize = (code) => WMO_SUMMARY[code] || "Unknown";

const http = axios.create({
  timeout: weatherConfig.fetchTimeoutMs,
  headers: { "User-Agent": weatherConfig.userAgent },
});

// Resolve a district name to { latitude, longitude, resolvedName } via Open-Meteo geocoding.
// Returns null (→ "unknown") if the district is not found or lookup fails.
const resolveDistrict = async (district) => {
  try {
    const { data } = await http.get(`${weatherConfig.geocodingBase}/search`, {
      params: { name: district, count: 1, language: "en", format: "json" },
    });
    const hit = data?.results?.[0];
    if (!hit) return null;
    return { latitude: hit.latitude, longitude: hit.longitude, resolvedName: hit.name };
  } catch (error) {
    logger.warn({ district, err: error }, "weather district geocoding failed");
    return null;
  }
};

// Fetch current + forecast from Open-Meteo given coordinates.
const fetchFromProvider = async ({ latitude, longitude }) => {
  const { data } = await http.get(`${weatherConfig.openMeteoBase}/forecast`, {
    params: {
      latitude,
      longitude,
      current: "temperature_2m,wind_speed_10m,weather_code,is_day",
      daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum",
      timezone: "Asia/Kolkata",
      forecast_days: 1,
    },
  });

  const current = data?.current;
  const daily = data?.daily;

  const payload = {
    district: null,
    current: current
      ? {
          temperature: current.temperature_2m,
          windspeed: current.wind_speed_10m,
          weatherCode: current.weather_code,
          isDay: current.is_day,
          summary: summarize(current.weather_code),
        }
      : undefined,
    forecast: Array.isArray(daily?.time)
      ? daily.time.map((date, i) => ({
          date,
          temperatureMax: daily.temperature_2m_max[i],
          temperatureMin: daily.temperature_2m_min[i],
          weatherCode: daily.weather_code[i],
          precipitation: daily.precipitation_sum[i],
          summary: summarize(daily.weather_code[i]),
        }))
      : [],
    source: "open-meteo",
  };
  return payload;
};

// Assemble the response envelope shared by cache-hit and fresh-fetch paths.
const buildResponse = (record) => {
  const now = Date.now();
  const ageMs = record.cachedAt ? now - new Date(record.cachedAt).getTime() : 0;
  // Convert Mongoose subdocument → plain object (toObject strips $__ / _id / etc.)
  // so cache reads do not leak driver internals into the API response.
  const rawCurrent = record.current && typeof record.current.toObject === "function"
    ? record.current.toObject()
    : record.current;
  const rawForecast = Array.isArray(record.forecast)
    ? record.forecast.map((day) =>
        day && typeof day.toObject === "function" ? day.toObject() : day
      )
    : [];
  // Strip Mongo _id from forecast days; current has no _id (schema is flat).
  // Re-derive human summaries from cached WMO codes so cache hits match the
  // fresh-fetch payload shape (cached record stores raw codes, not summaries).
  const current = rawCurrent
    ? { ...rawCurrent, summary: summarize(rawCurrent.weatherCode) }
    : null;
  const forecast = rawForecast.map(({ _id, ...day }) => ({
    ...day,
    summary: summarize(day.weatherCode),
  }));
  return {
    district: record.district,
    current,
    forecast,
    source: record.source || "open-meteo",
    cached: true,
    ageSeconds: Math.round(ageMs / 1000),
    freshness: ageMs <= weatherConfig.cacheTtlMs ? "fresh" : "stale",
  };
};

// Cache-first weather resolution (D-16/D-17/D-18). Never throws on provider failure.
export const getWeather = async (district) => {
  const startedAt = Date.now();
  const key = (district || "").toLowerCase();

  // 1) Cache hit (fresh preferred, stale honored per D-18 hybrid).
  try {
    const cached = await WeatherCache.findOne({ district: key }).exec();
    if (cached) {
      const ageMs = Date.now() - new Date(cached.cachedAt).getTime();
      logger.info(
        { district: key, ageSeconds: Math.round(ageMs / 1000), freshness: ageMs <= weatherConfig.cacheTtlMs ? "fresh" : "stale" },
        "weather.cache_hit"
      );
      return buildResponse(cached);
    }
  } catch (error) {
    // Cache read failure must not block a fresh fetch — log and continue.
    logger.warn({ district: key, err: error }, "weather cache read failed");
  }

  // 2) Cache miss → resolve district + fetch from provider.
  const resolved = await resolveDistrict(district);
  if (!resolved) {
    logger.warn({ district: key }, "weather district not resolvable");
    return {
      district: key,
      current: null,
      forecast: [],
      source: "open-meteo",
      cached: false,
      ageSeconds: 0,
      status: "unknown",
      note: "District could not be resolved; no weather data available.",
    };
  }

  try {
    const payload = await fetchFromProvider(resolved);
    payload.district = key;

    // 3) Persist to cache (upsert — key by district).
    try {
      await WeatherCache.findOneAndUpdate(
        { district: key },
        {
          district: key,
          current: payload.current,
          forecast: payload.forecast,
          source: payload.source,
          cachedAt: new Date(),
        },
        { upsert: true, new: true }
      ).exec();
      logger.info({ district: key }, "weather.cache_write");
    } catch (error) {
      // Cache write failure is non-fatal — return the fresh value to the caller.
      logger.warn({ district: key, err: error }, "weather cache write failed");
    }

    return { ...payload, cached: false, ageSeconds: 0, freshness: "fresh" };
  } catch (error) {
    // Provider totally failed: try stale cache as last resort (D-18 hybrid).
    logger.error(
      { district: key, provider: "open-meteo", durationMs: Date.now() - startedAt, err: error },
      "weather provider failure"
    );
    try {
      const stale = await WeatherCache.findOne({ district: key }).exec();
      if (stale) {
        logger.info({ district: key }, "weather.stale_cache_served");
        return buildResponse(stale);
      }
    } catch (cacheError) {
      logger.warn({ district: key, err: cacheError }, "weather stale cache read failed");
    }

    // No stale data — degrade to unknown (never 5xx from provider failure; caller decides rendering).
    return {
      district: key,
      current: null,
      forecast: [],
      source: "open-meteo",
      cached: false,
      ageSeconds: 0,
      status: "unknown",
      note: "Weather data is temporarily unavailable (provider failure).",
    };
  }
};
