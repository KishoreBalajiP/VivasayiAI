import { describe, expect, it, vi } from "vitest";
import { buildWindow, claimCentroid, fetchEventRainfall } from "../services/weatherArchive.service.js";

const NOW = new Date("2026-10-10T06:00:00.000Z");
const GEOMETRY = { type: "Polygon", coordinates: [[[79.1, 10.7], [79.11, 10.7], [79.11, 10.71], [79.1, 10.71], [79.1, 10.7]]] };
const day = (offset) => new Date(Date.UTC(2026, 9, 10) + offset * 86400000).toISOString();
const response = (times, rain) => ({ data: { daily: { time: times, precipitation_sum: rain } } });
const http = (impl) => ({ get: vi.fn(impl) });

describe("weatherArchive", () => {
  it("WA-1: the centroid of the claim polygon is used", () => {
    const point = claimCentroid(GEOMETRY);
    expect(point.longitude).toBeCloseTo(79.105, 3);
    expect(point.latitude).toBeCloseTo(10.705, 3);
    expect(claimCentroid({ type: "Point", coordinates: [1, 2] })).not.toBeNull(); // turf handles it
    expect(claimCentroid(null)).toBeNull();
  });

  it("WA-2: the window is clamped to today and refuses events that cannot be observed yet", () => {
    const recent = buildWindow({ eventDate: day(-1), daysBefore: 3, daysAfter: 5, now: NOW });
    expect(recent.end).toBe(Date.UTC(2026, 9, 10));
    expect(buildWindow({ eventDate: day(10), daysBefore: 3, daysAfter: 1, now: NOW }).valid).toBe(false);
  });

  it("WA-3: an old event uses the archive API and sums the rainfall inside the window only", async () => {
    const client = http(async () => response(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-20"], [0, 12.4, 30.1, 0.4, 2, 99]));
    const result = await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-09-03", daysBefore: 2, daysAfter: 1, now: NOW, http: client });
    expect(client.get.mock.calls[0][0]).toContain("archive");
    expect(result.status).toBe("AVAILABLE");
    expect(result.api).toBe("archive");
    expect(result.window).toEqual({ start: "2026-09-01", end: "2026-09-04" });
    expect(result.rainfallTotalMm).toBe(42.9);
    expect(result.rainfallPeakMm).toBe(30.1);
    expect(result.daysWithRain).toBe(2);
    expect(result.dailyMm).toHaveLength(4); // the 2026-09-05 and 2026-09-20 rows are outside the window
  });

  it("WA-4: a recent event uses the forecast API's past_days, not the lagging archive", async () => {
    const client = http(async () => response(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"], [0, 5, 20, 1]));
    const result = await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-10-08", daysBefore: 1, daysAfter: 1, now: NOW, http: client });
    expect(client.get.mock.calls[0][0]).toContain("forecast");
    expect(client.get.mock.calls[0][1].params.past_days).toBeGreaterThan(0);
    expect(result.api).toBe("forecast_past_days");
    expect(result.rainfallTotalMm).toBe(25);
  });

  it("WA-5: failures are `UNAVAILABLE` with a reason — never an AVAILABLE zero", async () => {
    const boom = http(async () => { throw Object.assign(new Error("slow"), { code: "ECONNABORTED" }); });
    expect(await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-09-03", now: NOW, http: boom })).toEqual({ status: "UNAVAILABLE", reason: "timeout" });
    const malformed = http(async () => ({ data: {} }));
    expect((await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-09-03", now: NOW, http: malformed })).reason).toBe("malformed_provider_response");
    const empty = http(async () => response([], []));
    expect((await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-09-03", now: NOW, http: empty })).status).toBe("UNAVAILABLE");
    expect((await fetchEventRainfall({ geometry: null, eventDate: "2026-09-03", now: NOW, http: empty })).reason).toBe("no_usable_geometry");
  });

  it("WA-6: an event in the future makes no request at all", async () => {
    const client = http(async () => response([], []));
    const result = await fetchEventRainfall({ geometry: GEOMETRY, eventDate: day(20), now: NOW, http: client });
    expect(result.reason).toBe("event_window_not_yet_observable");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("WA-7: the reported location is rounded, not the exact centroid", async () => {
    const client = http(async () => response(["2026-09-03"], [1]));
    const result = await fetchEventRainfall({ geometry: GEOMETRY, eventDate: "2026-09-03", daysBefore: 0, daysAfter: 0, now: NOW, http: client });
    const { latitude, longitude } = result.locationRounded;
    // At most two decimals (about 1 km), and within rounding distance of the true centroid.
    expect(Math.round(latitude * 100) / 100).toBe(latitude);
    expect(Math.round(longitude * 100) / 100).toBe(longitude);
    expect(Math.abs(latitude - 10.705)).toBeLessThanOrEqual(0.006);
    expect(Math.abs(longitude - 79.105)).toBeLessThanOrEqual(0.006);
  });
});
