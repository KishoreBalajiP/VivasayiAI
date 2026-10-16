import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// LIVE satellite case studies against the Copernicus Data Space Ecosystem (real Sentinel-2 L2A data).
//
// Runs the PRODUCTION pipeline (services/satellite/satelliteAdapter.js with the claim windows from
// services/satelliteVerification.service.js) over small, parcel-sized areas in districts affected by
// documented events, and over a no-damage control. Nothing is written to any database.
//
// What this can show: whether usable imagery exists before and after real events, how much is lost to
// cloud, what NDVI change the pipeline measures, and whether the request is accepted live.
// What it CANNOT show: damage-detection accuracy. The areas are approximate farmland chosen from maps,
// their land cover and crop at the time are unverified, and there is no ground truth of damage per area.
// Usage: node scripts/live/satelliteCaseStudies.js --date=YYYY-MM-DD

process.env.LOG_LEVEL ||= "silent";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dateArg = process.argv.find((a) => a.startsWith("--date="));
const runDate = dateArg ? dateArg.slice(7) : null;

const { runSatelliteAnalysis } = await import("../../services/satellite/satelliteAdapter.js");
const { buildClaimWindows } = await import("../../services/satelliteVerification.service.js");
const { resolveSatelliteConfig } = await import("../../services/satellite/config.js");
const { createSatelliteProvider } = await import("../../services/satellite/provider.js");

// A square of `side` metres centred on [lon, lat].
const square = (lon, lat, side = 100) => {
  const dLat = side / 2 / 110574;
  const dLon = side / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return { type: "Polygon", coordinates: [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]] };
};

const EVENTS = [
  {
    id: "south_tn_floods_2023", kind: "event", eventDate: "2023-12-18",
    label: "Extreme rainfall and floods in southern Tamil Nadu, 17-18 Dec 2023 (Thoothukudi, Tirunelveli)",
    source: "Sphere India SitRep 1, TN Flood, 19-12-2023, https://www.sphereindia.org.in/sites/default/files/2023-12/SitRep%201_TN_%20Flood_19-12-23.pdf",
    areas: [[77.905, 8.635], [77.935, 8.620], [77.960, 8.600]],
  },
  {
    id: "cyclone_michaung_2023", kind: "event", eventDate: "2023-12-04",
    label: "Cyclone Michaung, 4 Dec 2023 (Tiruvallur district)",
    source: "Sphere India SitRep 3, Cyclone Michaung, 09-12-2023, https://www.sphereindia.org.in/sites/default/files/2023-12/SitRep3_CycloneMichaung_09-12-23.pdf",
    areas: [[80.150, 13.300], [80.180, 13.350], [80.120, 13.250]],
  },
  {
    id: "cyclone_fengal_2024", kind: "event", eventDate: "2024-12-01",
    label: "Cyclone Fengal landfall 30 Nov - 1 Dec 2024 (Villupuram district)",
    source: "Sphere India SitRep 2, Cyclone Fengal, 09-12-2024, https://www.sphereindia.org.in/sites/default/files/2025-04/SI%20Sitrep-2__cyclone%20Fengal_09-12-2024.pdf",
    areas: [[79.430, 11.905], [79.560, 11.960], [79.380, 11.850]],
  },
  {
    id: "thanjavur_harvest_control_2024", kind: "control", eventDate: "2024-02-15",
    label: "CONTROL: no reported event; Cauvery delta during the samba paddy harvest season",
    source: "Pseudo-event date chosen inside the harvest season to test the seasonal confound; no damage is implied",
    areas: [[79.200, 10.800], [79.300, 10.850], [79.100, 10.750]],
  },
];

const summarizeRun = (run) => ({
  outcome: run.outcome,
  evidenceStatus: run.evidenceStatus,
  processingStatus: run.processingStatus,
  scenes: run.discovery ? run.discovery.sceneCount : 0,
  sceneCloudFractions: run.discovery && Array.isArray(run.discovery.scenes) ? run.discovery.scenes.map((s) => s.cloudCoverFraction).filter((v) => v !== undefined) : [],
  analysis: run.analysis
    ? {
        method: run.analysis.method,
        before: run.analysis.before,
        after: run.analysis.after,
        deltaNdvi: run.analysis.deltaNdvi,
        analysisOutcome: run.analysis.analysisOutcome,
        reasons: run.analysis.interpretationReasons,
      }
    : null,
  requestCount: run.requestCount ?? null,
  notes: (run.notes || []).slice(0, 3),
});

const cases = [];
for (const event of EVENTS) {
  const windows = buildClaimWindows({ eventDate: event.eventDate, now: new Date() });
  for (const [lon, lat] of event.areas) {
    const aoi = square(lon, lat, 100);
    const started = performance.now();
    let result;
    try {
      const run = await runSatelliteAnalysis({ aoi, preWindow: windows.preWindow, postWindow: windows.postWindow, requestProcessing: true, correlationId: `case-${event.id}` });
      result = summarizeRun(run);
    } catch (error) {
      result = { error: String(error && error.message).slice(0, 200) };
    }
    cases.push({ event: event.id, kind: event.kind, eventDate: event.eventDate, centre: [lon, lat], areaSideMetres: 100, windows, latencyMs: Math.round(performance.now() - started), ...result });
    console.log(`${event.id} ${lon},${lat}: ${result.outcome || result.error} ${result.analysis ? `dNDVI=${result.analysis.deltaNdvi} ${result.analysis.analysisOutcome}` : ""}`);
  }
}

// Live check of the resolution defect: the same window and area, requested the PoC way (resx 10 in
// a degree-based CRS) and the production way. Reports how many pixels each request is computed over.
const resolutionCheck = {};
try {
  const config = resolveSatelliteConfig();
  const provider = createSatelliteProvider({ config });
  const token = await provider.fetchToken();
  const aoi = square(79.2, 10.8, 100);
  const window = { start: "2024-01-01T00:00:00Z", end: "2024-01-31T23:59:59Z" };
  const production = await provider.executeProcessing({ aoi: { bbox: [aoi.coordinates[0][0][0], aoi.coordinates[0][0][1], aoi.coordinates[0][2][0], aoi.coordinates[0][2][1]] }, geometry: aoi, window, token });
  const { buildStatisticalRequest, parseStatisticalResponse } = await import("../../poc/satellite/satellitePoc.js");
  const pocBody = buildStatisticalRequest({ bbox: [aoi.coordinates[0][0][0], aoi.coordinates[0][0][1], aoi.coordinates[0][2][0], aoi.coordinates[0][2][1]], start: window.start, end: window.end });
  const pocRes = await fetch(config.statisticsUrl, { method: "POST", headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(pocBody) });
  const pocJson = await pocRes.json().catch(() => ({}));
  const pocFirst = Array.isArray(pocJson.data) ? pocJson.data.find((d) => d && d.outputs) : null;
  const pocBand = pocFirst ? pocFirst.outputs.default.bands.B0.stats : null;
  resolutionCheck.production = { ok: production.ok, method: production.method, sampleCount: production.sampleCount, intervals: production.intervals, ndvi: production.ndvi, validPixelFraction: production.validPixelFraction, reason: production.reason || null };
  resolutionCheck.pocRequest = { httpStatus: pocRes.status, intervalsReturned: Array.isArray(pocJson.data) ? pocJson.data.length : null, sampleCountPerInterval: pocBand ? pocBand.sampleCount : null, parsed: pocJson.data ? parseStatisticalResponse({ data: pocJson.data }) : null, error: pocJson.error ? String(pocJson.error.message || pocJson.error).slice(0, 200) : null };
} catch (error) {
  resolutionCheck.error = String(error && error.message).slice(0, 200);
}

const outDir = join(root, "docs", "research", "evaluation", "live");
mkdirSync(outDir, { recursive: true });
const record = { runDate, source: "Copernicus Data Space Ecosystem, Sentinel-2 L2A, Statistical API", events: EVENTS.map(({ areas, ...rest }) => ({ ...rest, areas: areas.length })), cases, resolutionCheck };
writeFileSync(join(outDir, `satellite_case_studies${runDate ? `_${runDate}` : ""}.json`), `${JSON.stringify(record, null, 2)}\n`);
console.log("resolutionCheck:", JSON.stringify(resolutionCheck));
process.exit(0);
