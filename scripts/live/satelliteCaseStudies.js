import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SATELLITE_ADAPTER_VERSION } from "../../services/satellite/config.js";
import { EVALSCRIPT_HASH } from "../../services/satellite/ndviStatistics.js";
import { ResultExistsError, writeJsonOnce } from "./lib/writeOnce.js";

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
//
// Provenance: the record carries a `provenance` block (run times, commit and dirty flag, adapter
// version, evalscript hash, the policy's satellite thresholds and windows, a secret-free config
// snapshot, policy id and hash), and every case keeps the thresholds, all notes and the scenes per
// window. The adapter returns `discovery.scenesByWindow` since 2026-10-16 (PC-7), so both windows'
// scenes are recorded; an older adapter without it leaves `scenesByWindow.post` null and
// `scenesByWindowSource` says why. Thresholds are READ
// from the policy and never overridden here. The output is write-once: an existing file for the same
// date/tag is never replaced (scripts/live/lib/writeOnce.js).
// Usage: node scripts/live/satelliteCaseStudies.js --date=YYYY-MM-DD [--tag=<name>]

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A square of `side` metres centred on [lon, lat].
export const square = (lon, lat, side = 100) => {
  const dLat = side / 2 / 110574;
  const dLon = side / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return { type: "Polygon", coordinates: [[[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat], [lon - dLon, lat - dLat]]] };
};

export const EVENTS = [
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

// Only these configuration keys are recorded. An allow-list (not a deny-list) so that a credential
// added to resolveSatelliteConfig() later can never leak into a result file.
export const CONFIG_SNAPSHOT_KEYS = Object.freeze([
  "adapterVersion",
  "provider",
  "enabled",
  "processingEnabled",
  "requestTimeoutMs",
  "maxRetries",
  "maxScenes",
  "cloudMaxFraction",
  "processingSceneCloudMax",
  "maxWindowDays",
  "stacUrl",
  "statisticsUrl",
  "hasCredentials",
]);

export const configSnapshot = (config = {}) =>
  Object.fromEntries(CONFIG_SNAPSHOT_KEYS.map((key) => [key, config[key] === undefined ? null : config[key]]));

const sceneSummary = (scene = {}) => ({
  id: scene.sceneId ?? scene.id ?? null,
  datetime: scene.acquisitionTime ?? scene.datetime ?? null,
  cloudCoverFraction: Number.isFinite(scene.cloudCoverFraction) ? scene.cloudCoverFraction : null,
});

// Scenes per window. Prefers the adapter's `discovery.scenesByWindow` = { pre: [scene], post: [scene] }
// (plan Part D; returned by the adapter since 2026-10-16, PC-7). Without it (an older adapter), the
// adapter puts only the FIRST window's search in `discovery.scenes` while `sceneCount` counts both
// windows; then a window whose scenes cannot all be present is recorded as null ("not recorded"), never
// as an empty list. Any other `scenesByWindow` shape is ignored rather than guessed at.
export const scenesPerWindow = (discovery, windows = {}) => {
  if (!discovery) return { source: "no_discovery", pre: null, post: null };
  const list = (value) => (Array.isArray(value) ? value.map(sceneSummary) : null);
  const byWindow = discovery.scenesByWindow;
  if (byWindow && !Array.isArray(byWindow) && typeof byWindow === "object" && (Array.isArray(byWindow.pre) || Array.isArray(byWindow.post))) {
    return { source: "adapter", pre: list(byWindow.pre), post: list(byWindow.post) };
  }
  const scenes = Array.isArray(discovery.scenes) ? discovery.scenes : [];
  const complete = Number.isFinite(discovery.sceneCount) && discovery.sceneCount === scenes.length;
  const inWindow = (window) => (window && window.start ? scenes.filter((scene) => scene.queryWindow?.start === window.start).map(sceneSummary) : null);
  const pre = inWindow(windows.preWindow);
  const post = inWindow(windows.postWindow);
  return {
    source: complete ? "derived_from_discovery_scenes" : "derived_from_discovery_scenes_incomplete",
    pre: pre && (pre.length || complete) ? pre : null,
    post: post && (post.length || complete) ? post : null,
  };
};

// The STAC search returns at most `maxScenes` features per window, so a full page means the count is a
// cap, not the true availability.
export const sceneCapReached = (perWindow, maxScenes) => {
  const reached = (scenes) => (Array.isArray(scenes) && Number.isFinite(maxScenes) ? scenes.length >= maxScenes : null);
  return { maxScenes: Number.isFinite(maxScenes) ? maxScenes : null, pre: reached(perWindow.pre), post: reached(perWindow.post) };
};

// One case. The first fields keep the shape of the 2026-10-16 record so runs stay comparable;
// `sceneCloudFractions` is still the adapter's `discovery.scenes` list (pre-event window only in
// adapter 13.3.0), and `scenesByWindow` is the per-window record.
export const summarizeRun = (run, { windows = {}, maxScenes = null } = {}) => {
  const perWindow = scenesPerWindow(run.discovery, windows);
  return {
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
          thresholds: run.analysis.thresholds ?? null,
          evalscriptHash: run.analysis.evalscriptHash ?? null,
        }
      : null,
    requestCount: run.requestCount ?? null,
    notes: Array.isArray(run.notes) ? [...run.notes] : [],
    scenesByWindowSource: perWindow.source,
    scenesByWindow: { pre: perWindow.pre, post: perWindow.post },
    sceneCapReached: sceneCapReached(perWindow, maxScenes),
  };
};

export const gitProvenance = (cwd = root) => {
  const git = (command) => {
    try {
      return execSync(command, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 }).toString();
    } catch {
      return null;
    }
  };
  const commit = git("git rev-parse HEAD");
  const status = git("git status --porcelain");
  const diff = git("git diff HEAD");
  return {
    commit: commit ? commit.trim() : null,
    dirty: status === null ? null : status.trim().length > 0,
    // A hash of the uncommitted changes, so a dirty run can still be tied to the exact code it used.
    diffSha256: diff === null ? null : createHash("sha256").update(diff).digest("hex"),
  };
};

// The provenance block. `policy` is a resolved policy (config/verificationPolicy.js) and `config` a
// resolved satellite config; both are only read.
export const buildProvenance = ({ runStartedAt, runFinishedAt, git = { commit: null, dirty: null, diffSha256: null }, policy, config, node = process.version }) => {
  const satellite = (policy && policy.satellite) || {};
  return {
    schema: "satellite-case-studies-provenance/v1",
    recordedAtRunTime: true,
    runStartedAt,
    runFinishedAt,
    commit: git.commit ?? null,
    dirty: git.dirty ?? null,
    diffSha256: git.diffSha256 ?? null,
    node,
    adapterVersion: SATELLITE_ADAPTER_VERSION,
    evalscriptHash: EVALSCRIPT_HASH,
    thresholds: {
      minValidPixelFraction: satellite.minValidPixelFraction ?? null,
      ndviDropSupport: satellite.ndviDropSupport ?? null,
      maxCloudFraction: satellite.maxCloudFraction ?? null,
    },
    windows: {
      preWindowDays: Array.isArray(satellite.preWindowDays) ? [...satellite.preWindowDays] : null,
      postWindowDays: Array.isArray(satellite.postWindowDays) ? [...satellite.postWindowDays] : null,
    },
    config: configSnapshot(config),
    policy: { id: policy?.id ?? null, hash: policy?.hash ?? null },
  };
};

export const outputPath = ({ date = null, tag = null } = {}) =>
  join(root, "docs", "research", "evaluation", "live", `satellite_case_studies${date ? `_${date}` : ""}${tag ? `_${tag}` : ""}.json`);

const main = async () => {
  process.env.LOG_LEVEL ||= "silent";
  const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
  const runDate = arg("date");
  const tag = arg("tag");
  if (tag && !/^[A-Za-z0-9-]+$/.test(tag)) throw new Error("--tag may contain only letters, digits and '-'");
  const outFile = outputPath({ date: runDate, tag });
  // Checked before any provider call so a duplicate run spends no quota; writeJsonOnce checks again.
  if (existsSync(outFile)) throw new ResultExistsError(outFile);
  const runStartedAt = new Date().toISOString();

  const { runSatelliteAnalysis } = await import("../../services/satellite/satelliteAdapter.js");
  const { buildClaimWindows } = await import("../../services/satelliteVerification.service.js");
  const { resolveSatelliteConfig } = await import("../../services/satellite/config.js");
  const { createSatelliteProvider } = await import("../../services/satellite/provider.js");
  const { resolvePolicy } = await import("../../config/verificationPolicy.js");
  const policy = resolvePolicy();
  const runConfig = resolveSatelliteConfig();

  const cases = [];
  for (const event of EVENTS) {
    const windows = buildClaimWindows({ eventDate: event.eventDate, now: new Date() });
    for (const [lon, lat] of event.areas) {
      const aoi = square(lon, lat, 100);
      const started = performance.now();
      let result;
      try {
        const run = await runSatelliteAnalysis({ aoi, preWindow: windows.preWindow, postWindow: windows.postWindow, requestProcessing: true, correlationId: `case-${event.id}` });
        result = summarizeRun(run, { windows, maxScenes: runConfig.maxScenes });
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

  const provenance = buildProvenance({ runStartedAt, runFinishedAt: new Date().toISOString(), git: gitProvenance(root), policy, config: runConfig });
  const record = { runDate, tag, source: "Copernicus Data Space Ecosystem, Sentinel-2 L2A, Statistical API", provenance, events: EVENTS.map(({ areas, ...rest }) => ({ ...rest, areas: areas.length })), cases, resolutionCheck };
  writeJsonOnce(outFile, record);
  console.log("resolutionCheck:", JSON.stringify(resolutionCheck));
  const withoutPostScenes = cases.filter((c) => c.scenesByWindow && c.scenesByWindow.post === null).length;
  if (withoutPostScenes) console.warn(`warning: ${withoutPostScenes} of ${cases.length} cases have no recorded post-event scenes; see each case's scenesByWindowSource`);
  console.log(`wrote ${outFile}`);
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error && error.message ? error.message : error);
      process.exit(error && error.exitCode ? error.exitCode : 1);
    }
  );
}
