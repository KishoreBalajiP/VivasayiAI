import { describe, expect, it } from "vitest";
import {
  INVALID_SCL_CLASSES, LEGACY_METHOD, NDVI_EVALSCRIPT, NDVI_METHOD,
  buildNdviStatisticalRequest, interpretNdviChange, metresToDegrees, parseNdviStatisticalResponse,
} from "../services/satellite/ndviStatistics.js";

const GEOMETRY = { type: "Polygon", coordinates: [[[79.1, 10.7], [79.101, 10.7], [79.101, 10.701], [79.1, 10.701], [79.1, 10.7]]] };
const TH = { minValidPixelFraction: 0.6, ndviDropSupport: 0.15 };
const interval = (mean, sampleCount, noDataCount) => ({ outputs: { ndvi: { bands: { B0: { stats: { mean, sampleCount, noDataCount } } } } } });
const side = (ndvi, validPixelFraction) => ({ ndvi, validPixelFraction });

describe("NDVI statistics request", () => {
  it("NS-1: uses the claim polygon, not its bounding box", () => {
    const body = buildNdviStatisticalRequest({ geometry: GEOMETRY, start: "2026-09-01T00:00:00Z", end: "2026-09-10T00:00:00Z" });
    expect(body.input.bounds.geometry).toEqual(GEOMETRY);
    expect(body.input.bounds.bbox).toBeUndefined();
    expect(buildNdviStatisticalRequest({ bbox: [1, 2, 3, 4], start: "a", end: "b" }).input.bounds.bbox).toEqual([1, 2, 3, 4]);
  });

  it("NS-2: resolution is in degrees, never the 10 that meant 10-degree pixels in EPSG:4326", () => {
    const body = buildNdviStatisticalRequest({ geometry: GEOMETRY, start: "a", end: "b", resolutionM: 10 });
    expect(body.aggregation.resx).toBeCloseTo(0.0000898, 6);
    expect(body.aggregation.resx).toBe(body.aggregation.resy);
    expect(body.aggregation.resx).toBeLessThan(0.001);
    expect(metresToDegrees(111320)).toBe(1);
  });

  it("NS-3: the evalscript masks cloud classes, keeps water, and reports a dataMask output", () => {
    expect(INVALID_SCL_CLASSES).toEqual([0, 1, 3, 8, 9, 10]);
    expect(INVALID_SCL_CLASSES).not.toContain(6); // water stays observable for flood claims
    expect(NDVI_EVALSCRIPT).toContain('"SCL"');
    expect(NDVI_EVALSCRIPT).toContain("dataMask");
    expect(NDVI_EVALSCRIPT).toContain("(s.B08 - s.B04) / denom");
  });
});

describe("NDVI statistics response", () => {
  it("NS-4: averages per-pixel NDVI across days weighted by VALID pixel count, and reports the valid fraction", () => {
    const parsed = parseNdviStatisticalResponse({ data: [interval(0.8, 100, 0), interval(0.2, 100, 75)] });
    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe(NDVI_METHOD);
    // weights 100 and 25 -> (0.8*100 + 0.2*25) / 125 = 0.68
    expect(parsed.ndvi).toBeCloseTo(0.68, 6);
    expect(parsed.validPixelFraction).toBeCloseTo(125 / 200, 6);
    expect(parsed.sampleCount).toBe(200);
  });

  it("NS-5: when every pixel is masked the result is NOT ok — a cloud is never a zero NDVI", () => {
    const parsed = parseNdviStatisticalResponse({ data: [interval(0, 50, 50)] });
    expect(parsed.ok).toBe(false);
    expect(parsed.validPixelFraction).toBe(0);
  });

  it("NS-6: the legacy band-means shape still parses and is labelled as unmasked", () => {
    const legacy = { data: [{ outputs: { default: { bands: { B0: { stats: { mean: 0.1 } }, B1: { stats: { mean: 0.4 } }, B2: { stats: { mean: 1 } } } } } }] };
    const parsed = parseNdviStatisticalResponse(legacy);
    expect(parsed.ok).toBe(true);
    expect(parsed.method).toBe(LEGACY_METHOD);
    expect(parsed.ndvi).toBeCloseTo(0.6, 6);
  });

  it("NS-7: empty or malformed responses are not ok", () => {
    expect(parseNdviStatisticalResponse({}).ok).toBe(false);
    expect(parseNdviStatisticalResponse({ data: [{}] }).ok).toBe(false);
    expect(parseNdviStatisticalResponse(null).ok).toBe(false);
  });
});

describe("NDVI change interpretation", () => {
  it("NS-8: a large fall with enough valid pixels in both windows supports the claim", () => {
    const result = interpretNdviChange({ before: side(0.7, 0.9), after: side(0.4, 0.8), thresholds: TH });
    expect(result.outcome).toBe("SUPPORTS_LOSS");
    expect(result.deltaNdvi).toBe(-0.3);
  });

  it("NS-9: no fall is NO_CHANGE, which does not disprove a claim", () => {
    expect(interpretNdviChange({ before: side(0.7, 0.9), after: side(0.65, 0.9), thresholds: TH }).outcome).toBe("NO_CHANGE");
    expect(interpretNdviChange({ before: side(0.5, 0.9), after: side(0.7, 0.9), thresholds: TH }).outcome).toBe("NO_CHANGE");
  });

  it("NS-10: too few valid pixels in either window is inconclusive even when the drop is large", () => {
    const cloudyAfter = interpretNdviChange({ before: side(0.7, 0.9), after: side(0.1, 0.3), thresholds: TH });
    expect(cloudyAfter.outcome).toBe("INCONCLUSIVE");
    expect(cloudyAfter.reasons).toContain("post_event_too_few_valid_pixels");
    expect(interpretNdviChange({ before: side(0.7, 0.2), after: side(0.1, 0.9), thresholds: TH }).reasons).toContain("pre_event_too_few_valid_pixels");
  });

  it("NS-11: missing statistics are inconclusive, never a fabricated change", () => {
    expect(interpretNdviChange({ before: null, after: side(0.5, 0.9), thresholds: TH })).toMatchObject({ outcome: "INCONCLUSIVE", deltaNdvi: null });
    expect(interpretNdviChange({ before: side(NaN, 0.9), after: side(0.5, 0.9), thresholds: TH }).outcome).toBe("INCONCLUSIVE");
  });

  it("NS-12: a drop exactly at the threshold counts, just inside it does not", () => {
    expect(interpretNdviChange({ before: side(0.7, 0.9), after: side(0.55, 0.9), thresholds: TH }).outcome).toBe("SUPPORTS_LOSS");
    expect(interpretNdviChange({ before: side(0.7, 0.9), after: side(0.56, 0.9), thresholds: TH }).outcome).toBe("NO_CHANGE");
  });
});
