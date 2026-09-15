import mongoose from "mongoose";
import { env } from "../config/env.js";

// Cache record for district weather (D-16).
// Keyed by district name; TTL index auto-expires documents after the configured
// cache window (default 30 min). `cachedAt` is the source-of-truth freshness stamp
// surfaced to callers (D-18: stale cache is honored + labelled).
const weatherCacheSchema = new mongoose.Schema(
  {
    district: { type: String, required: true, index: true, unique: true },
    current: {
      temperature: Number,
      windspeed: Number,
      weatherCode: Number,
      isDay: Number,
    },
    forecast: [
      {
        date: String,
        temperatureMax: Number,
        temperatureMin: Number,
        weatherCode: Number,
        precipitation: Number,
      },
    ],
    cachedAt: { type: Date, default: Date.now, index: { expires: Math.floor(Number(env.weatherCacheTtlMs) || 1800000) / 1000 } },
    source: { type: String, default: "open-meteo" },
  },
  { timestamps: true }
);

export default mongoose.model("WeatherCache", weatherCacheSchema);
