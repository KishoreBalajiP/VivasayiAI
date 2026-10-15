import axios from "axios";
import { centroid } from "@turf/turf";
import weatherConfig from "../config/weather.js";
import logger from "../utils/logger.js";

// ADR-020 — rainfall around a claimed event, as SUPPORTING evidence only (ADR-019 P3). The numbers
// are context for a reviewer. They never reject a claim, never confirm a cause, and a failed or
// missing lookup is `unavailable`, never a negative finding.
//
// Open-Meteo's archive lags by several days, so a recent event is read from the forecast API's
// `past_days` window instead.

const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_LAG_DAYS = 6;
const MAX_PAST_DAYS = 92;

const defaultHttp = axios.create({
  timeout: weatherConfig.fetchTimeoutMs,
  headers: { "User-Agent": weatherConfig.userAgent },
});

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const startOfDay = (value) => {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const round1 = (value) => Math.round(value * 10) / 10;

export const claimCentroid = (geometry) => {
  try {
    const point = centroid({ type: "Feature", properties: {}, geometry });
    const [longitude, latitude] = point.geometry.coordinates;
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  } catch {
    return null;
  }
};

export const buildWindow = ({ eventDate, daysBefore, daysAfter, now = new Date() }) => {
  const event = startOfDay(eventDate);
  const today = startOfDay(now);
  const start = event - daysBefore * DAY_MS;
  const end = Math.min(event + daysAfter * DAY_MS, today);
  return { start, end, valid: Number.isFinite(event) && start <= end };
};

export const fetchEventRainfall = async ({ geometry, eventDate, daysBefore = 3, daysAfter = 1, now = new Date(), http = defaultHttp }) => {
  const point = claimCentroid(geometry);
  if (!point) return { status: "UNAVAILABLE", reason: "no_usable_geometry" };

  const window = buildWindow({ eventDate, daysBefore, daysAfter, now });
  if (!window.valid) return { status: "UNAVAILABLE", reason: "event_window_not_yet_observable" };

  const today = startOfDay(now);
  const useArchive = window.end <= today - ARCHIVE_LAG_DAYS * DAY_MS;
  const pastDays = Math.ceil((today - window.start) / DAY_MS) + 1;
  if (!useArchive && pastDays > MAX_PAST_DAYS) return { status: "UNAVAILABLE", reason: "event_too_old_for_forecast_window" };

  try {
    const { data } = useArchive
      ? await http.get(`${weatherConfig.archiveBase}/archive`, {
          params: {
            latitude: point.latitude, longitude: point.longitude,
            start_date: isoDay(window.start), end_date: isoDay(window.end),
            daily: "precipitation_sum,temperature_2m_max", timezone: "Asia/Kolkata",
          },
        })
      : await http.get(`${weatherConfig.openMeteoBase}/forecast`, {
          params: {
            latitude: point.latitude, longitude: point.longitude,
            past_days: pastDays, forecast_days: 1,
            daily: "precipitation_sum,temperature_2m_max", timezone: "Asia/Kolkata",
          },
        });

    const times = data && data.daily && data.daily.time;
    const rain = data && data.daily && data.daily.precipitation_sum;
    if (!Array.isArray(times) || !Array.isArray(rain)) return { status: "UNAVAILABLE", reason: "malformed_provider_response" };

    const lo = isoDay(window.start);
    const hi = isoDay(window.end);
    const dailyMm = [];
    times.forEach((date, index) => {
      const mm = rain[index];
      if (date >= lo && date <= hi && typeof mm === "number") dailyMm.push({ date, mm: round1(mm) });
    });
    if (dailyMm.length === 0) return { status: "UNAVAILABLE", reason: "no_observations_in_window" };

    const values = dailyMm.map((entry) => entry.mm);
    return {
      status: "AVAILABLE",
      api: useArchive ? "archive" : "forecast_past_days",
      window: { start: lo, end: hi },
      rainfallTotalMm: round1(values.reduce((sum, value) => sum + value, 0)),
      rainfallPeakMm: Math.max(...values),
      daysWithRain: values.filter((value) => value >= 1).length,
      dailyMm,
      // Rounded to ~1 km: enough to reproduce the lookup, not a farm location.
      locationRounded: { latitude: Math.round(point.latitude * 100) / 100, longitude: Math.round(point.longitude * 100) / 100 },
    };
  } catch (error) {
    logger.warn({ err: error?.message }, "event rainfall lookup failed");
    return { status: "UNAVAILABLE", reason: error && error.code === "ECONNABORTED" ? "timeout" : "provider_error" };
  }
};

export default { fetchEventRainfall, claimCentroid, buildWindow };
