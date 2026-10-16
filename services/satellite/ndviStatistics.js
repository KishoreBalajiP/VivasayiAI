import { createHash } from "node:crypto";

// Production NDVI request, response parsing and interpretation for the Sentinel Hub Statistical API
// (Copernicus Data Space). Replaces the PoC's request for claim verification. Differences:
//   - the statistics are computed over the claim POLYGON, not its bounding box;
//   - pixels the scene classification (SCL) marks as cloud, cloud shadow, cirrus, saturated or no
//     data are excluded, so a cloudy pixel can never read as crop damage;
//   - NDVI is the mean of PER-PIXEL values over the unmasked pixels, not a ratio of band means;
//   - resolution is expressed in DEGREES. The request geometry is EPSG:4326, and the API reads
//     resx/resy in the units of that CRS: the PoC's `resx: 10` asked for 10-degree pixels, which
//     community reports say returns a single sample (see docs/research notes). NOT yet validated
//     against the live API: live validation is a separate, credentialed step.
//
// Water (SCL 6) is deliberately NOT masked: a field under floodwater is exactly what a flood claim
// describes. The cost is a known confound: paddy is flooded early in the season, so low NDVI over
// water can be normal. The interpretation below therefore only ever SUPPORTS a claim and never
// refutes one, and says so.

export const S2_L2A = "sentinel-2-l2a";
export const INVALID_SCL_CLASSES = Object.freeze([0, 1, 3, 8, 9, 10]);
export const NDVI_METHOD = "per-pixel-mean-scl-masked";
export const LEGACY_METHOD = "ratio-of-band-means";

export const NDVI_EVALSCRIPT = [
  "//VERSION=3",
  "function setup() {",
  '  return { input: [{ bands: ["B04", "B08", "SCL", "dataMask"] }],',
  '    output: [{ id: "ndvi", bands: 1, sampleType: "FLOAT32" }, { id: "dataMask", bands: 1 }] };',
  "}",
  `var INVALID = [${INVALID_SCL_CLASSES.join(", ")}];`,
  "function evaluatePixel(s) {",
  "  var denom = s.B08 + s.B04;",
  "  var valid = (s.dataMask === 1 && denom !== 0 && INVALID.indexOf(s.SCL) === -1) ? 1 : 0;",
  "  return { ndvi: [valid ? (s.B08 - s.B04) / denom : 0], dataMask: [valid] };",
  "}",
].join("\n");

export const EVALSCRIPT_HASH = createHash("sha1").update(NDVI_EVALSCRIPT).digest("hex").slice(0, 12);

const METRES_PER_DEGREE = 111320;
export const metresToDegrees = (metres) => Math.round((metres / METRES_PER_DEGREE) * 1e8) / 1e8;

export const buildNdviStatisticalRequest = ({ geometry = null, bbox = null, start, end, maxCloudCoverage = 30, resolutionM = 10 }) => {
  const crs = "http://www.opengis.net/def/crs/EPSG/0/4326";
  const resolution = metresToDegrees(resolutionM);
  return {
    input: {
      bounds: geometry ? { geometry, properties: { crs } } : { bbox, properties: { crs } },
      data: [{ type: S2_L2A, dataFilter: { maxCloudCoverage, timeRange: { from: start, to: end } } }],
    },
    aggregation: {
      timeRange: { from: start, to: end },
      aggregationInterval: { of: "P1D" },
      resx: resolution,
      resy: resolution,
      evalscript: NDVI_EVALSCRIPT,
    },
    calculations: { default: {} },
  };
};

const weightedMean = (items) => {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  return total > 0 ? items.reduce((sum, item) => sum + item.value * item.weight, 0) / total : null;
};

// Accepts the masked per-pixel shape (`outputs.ndvi.bands.B0.stats` with sampleCount/noDataCount) and,
// for compatibility, the legacy band-means shape (`outputs.default.bands.B0..B2`). The legacy shape
// carries no cloud masking and is labelled as such.
// The HTTP client returns the response BODY under `response.data`, and the body itself is
// `{ data: [...intervals], status }`. Fixtures written by hand used `{ data: [...] }` directly, which is
// why the original parser passed its tests but never parsed a live response. Both shapes are accepted.
const intervalsOf = (response) => {
  if (!response) return [];
  if (Array.isArray(response.data)) return response.data;
  if (response.data && Array.isArray(response.data.data)) return response.data.data;
  return [];
};

export const parseNdviStatisticalResponse = (response) => {
  const data = intervalsOf(response);
  const masked = [];
  const legacy = [];
  for (const entry of data) {
    const stats = entry && entry.outputs && entry.outputs.ndvi && entry.outputs.ndvi.bands && entry.outputs.ndvi.bands.B0 && entry.outputs.ndvi.bands.B0.stats;
    if (stats && Number.isFinite(stats.mean)) {
      const sampleCount = Number(stats.sampleCount) || 0;
      const noDataCount = Number(stats.noDataCount) || 0;
      masked.push({
        value: stats.mean, weight: Math.max(sampleCount - noDataCount, 0), sampleCount, noDataCount,
        date: entry.interval && entry.interval.from ? String(entry.interval.from).slice(0, 10) : null,
      });
      continue;
    }
    const bands = entry && ((entry.outputs && entry.outputs.default && entry.outputs.default.bands) || entry.bands);
    const red = bands && bands.B0 && bands.B0.stats && bands.B0.stats.mean;
    const nir = bands && bands.B1 && bands.B1.stats && bands.B1.stats.mean;
    const mask = bands && bands.B2 && bands.B2.stats && bands.B2.stats.mean;
    if (Number.isFinite(red) && Number.isFinite(nir)) legacy.push({ red, nir, mask: Number.isFinite(mask) ? mask : null });
  }

  if (masked.length > 0) {
    const sampleCount = masked.reduce((sum, item) => sum + item.sampleCount, 0);
    const noDataCount = masked.reduce((sum, item) => sum + item.noDataCount, 0);
    const ndvi = weightedMean(masked);
    if (ndvi === null) return { ok: false, reason: "every pixel was masked (cloud, shadow or no data)", method: NDVI_METHOD, sampleCount, noDataCount, validPixelFraction: 0 };
    return {
      ok: true,
      method: NDVI_METHOD,
      intervals: masked.length,
      // Each acquisition day separately, for transparency: a window mean can hide a crop that grew or was
      // harvested within the window.
      series: masked.map((item) => ({
        date: item.date,
        ndvi: Math.round(item.value * 10000) / 10000,
        validPixelFraction: item.sampleCount > 0 ? Math.round(((item.sampleCount - item.noDataCount) / item.sampleCount) * 10000) / 10000 : null,
      })),
      ndvi,
      sampleCount,
      noDataCount,
      validPixelFraction: sampleCount > 0 ? (sampleCount - noDataCount) / sampleCount : null,
    };
  }
  if (legacy.length > 0) {
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const red = mean(legacy.map((item) => item.red));
    const nir = mean(legacy.map((item) => item.nir));
    const masks = legacy.map((item) => item.mask).filter(Number.isFinite);
    return {
      ok: Number.isFinite(red + nir) && red + nir !== 0,
      method: LEGACY_METHOD,
      intervals: legacy.length,
      redMean: red,
      nirMean: nir,
      ndvi: red + nir === 0 ? null : (nir - red) / (nir + red),
      validPixelFraction: masks.length ? mean(masks) : null,
      sampleCount: null,
      noDataCount: null,
    };
  }
  return { ok: false, reason: "no valid statistics in Statistical API response", method: NDVI_METHOD };
};

// Outcomes of comparing the pre-event and post-event NDVI. Pure.
//   SUPPORTS_LOSS  : NDVI fell by at least `ndviDropSupport` with enough valid pixels in BOTH windows;
//   NO_CHANGE      : enough valid pixels in both windows and no such fall (does NOT disprove a claim:
//                    a drop can be missed by timing, resolution or the cause);
//   INCONCLUSIVE   : too few valid pixels in one window, or no usable values.
// This is change in a vegetation index. It does not identify a cause (drought, flood, disease,
// harvest and normal senescence all lower NDVI) and is never proof of crop loss.
export const interpretNdviChange = ({ before, after, thresholds }) => {
  const reasons = [];
  const usable = (side) => side && Number.isFinite(side.ndvi) && Number.isFinite(side.validPixelFraction);
  if (!usable(before) || !usable(after)) {
    return { outcome: "INCONCLUSIVE", deltaNdvi: null, reasons: ["missing_window_statistics"] };
  }
  const deltaNdvi = Math.round((after.ndvi - before.ndvi) * 10000) / 10000;
  if (before.validPixelFraction < thresholds.minValidPixelFraction) reasons.push("pre_event_too_few_valid_pixels");
  if (after.validPixelFraction < thresholds.minValidPixelFraction) reasons.push("post_event_too_few_valid_pixels");
  if (reasons.length > 0) return { outcome: "INCONCLUSIVE", deltaNdvi, reasons };
  if (deltaNdvi <= -thresholds.ndviDropSupport) return { outcome: "SUPPORTS_LOSS", deltaNdvi, reasons: ["ndvi_dropped_beyond_threshold"] };
  return { outcome: "NO_CHANGE", deltaNdvi, reasons: ["no_ndvi_drop_beyond_threshold"] };
};

export default { buildNdviStatisticalRequest, parseNdviStatisticalResponse, interpretNdviChange, NDVI_EVALSCRIPT, EVALSCRIPT_HASH };
