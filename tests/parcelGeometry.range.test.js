import { describe, expect, it } from "vitest";
import { inspectPolygonRing, positionIsInRange, validateParcelGeometry } from "../services/parcelGeometry.service.js";

// Coordinate ranges are enforced by the shared validator itself, not only by the API schema.
describe("coordinate range validation", () => {
  const poly = (ring) => ({ type: "Polygon", coordinates: [ring] });
  const square = (lon, lat, size = 0.001) => [[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]];

  it("PG-1: a longitude or latitude outside the WGS84 range is rejected by the service validator", () => {
    expect(validateParcelGeometry(poly(square(200, 10))).ok).toBe(false);
    expect(validateParcelGeometry(poly(square(-181, 10))).ok).toBe(false);
    expect(validateParcelGeometry(poly(square(79, 91))).ok).toBe(false);
    expect(validateParcelGeometry(poly(square(79, -91))).ok).toBe(false);
    expect(validateParcelGeometry(poly(square(200, 10))).reason).toMatch(/within -180..180/);
  });

  it("PG-2: non-finite and non-numeric coordinates are rejected", () => {
    expect(validateParcelGeometry(poly([[NaN, 10], [79, 10], [79, 11], [NaN, 10]])).ok).toBe(false);
    expect(validateParcelGeometry(poly([[Infinity, 10], [79, 10], [79, 11], [Infinity, 10]])).ok).toBe(false);
    expect(validateParcelGeometry(poly([["79", 10], [79, 10], [79, 11], ["79", 10]])).ok).toBe(false);
  });

  it("PG-3: real Tamil Nadu coordinates and the exact range boundaries are accepted", () => {
    expect(validateParcelGeometry(poly(square(79.14, 10.78))).ok).toBe(true);
    expect(positionIsInRange([180, 90])).toBe(true);
    expect(positionIsInRange([-180, -90])).toBe(true);
    expect(positionIsInRange([180.0001, 0])).toBe(false);
    expect(inspectPolygonRing(square(79.14, 10.78)).ok).toBe(true);
  });
});
