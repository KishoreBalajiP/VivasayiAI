import { describe, expect, it } from "vitest";
import {
  calculateParcelAreaAcres,
  ringAreaSqMeters,
  ringIsClosed,
  ringSelfIntersects,
  validateParcelGeometry,
} from "../services/parcelGeometry.service.js";

// Local fixture: importing tests/helpers.js would import the full Express app, which parcel
// geometry unit tests do not need.
const squareGeometry = (sizeDegrees = 0.009, origin = [0, 0]) => {
  const [lon, lat] = origin;
  return {
    type: "Polygon",
    coordinates: [
      [
        [lon, lat],
        [lon + sizeDegrees, lat],
        [lon + sizeDegrees, lat + sizeDegrees],
        [lon, lat + sizeDegrees],
        [lon, lat],
      ],
    ],
  };
};

const bowtieRing = [
  [0, 0],
  [0.01, 0.01],
  [0, 0.01],
  [0.01, 0],
  [0, 0],
];

const collinearRing = [
  [0, 0],
  [0.01, 0.01],
  [0.02, 0.02],
  [0.03, 0.03],
  [0, 0],
];

const circularRing = (uniquePoints) => {
  const ring = [];
  for (let i = 0; i < uniquePoints; i += 1) {
    const angle = (2 * Math.PI * i) / uniquePoints;
    ring.push([0.01 + 0.001 * Math.cos(angle), 0.01 + 0.001 * Math.sin(angle)]);
  }
  ring.push([...ring[0]]);
  return ring;
};

describe("parcel geometry validation and authoritative area", () => {
  it("accepts a valid closed square and returns positive acres", () => {
    const result = validateParcelGeometry(squareGeometry(0.009));
    expect(result.ok).toBe(true);
    expect(result.acres).toBeGreaterThan(0);
    expect(Number.isFinite(result.acres)).toBe(true);
  });

  it("does not mistake a valid closed square for self-intersection", () => {
    expect(ringIsClosed(squareGeometry(0.009).coordinates[0])).toBe(true);
    expect(ringSelfIntersects(squareGeometry(0.009).coordinates[0])).toBe(false);
  });

  it("returns the same area independent of ring winding", () => {
    const ring = squareGeometry(0.009).coordinates[0];
    const reversed = { type: "Polygon", coordinates: [[...ring].reverse()] };
    expect(validateParcelGeometry({ type: "Polygon", coordinates: [ring] }).acres).toBe(
      validateParcelGeometry(reversed).acres
    );
  });

  it("scales area with polygon size for small equatorial parcels", () => {
    const full = validateParcelGeometry(squareGeometry(0.008));
    const half = validateParcelGeometry(squareGeometry(0.004));
    expect(full.ok).toBe(true);
    expect(half.ok).toBe(true);
    const ratio = full.acres / half.acres;
    expect(ratio).toBeGreaterThan(3.9);
    expect(ratio).toBeLessThan(4.1);
  });

  it("rejects a self-intersecting bowtie polygon", () => {
    expect(ringSelfIntersects(bowtieRing)).toBe(true);
    const result = validateParcelGeometry({ type: "Polygon", coordinates: [bowtieRing] });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/self-intersects/);
  });

  it("rejects degenerate zero-area rings", () => {
    // Out-and-back over the same segment encloses exactly zero area.
    const outAndBack = validateParcelGeometry({
      type: "Polygon",
      coordinates: [[[0, 0], [0.01, 0.01], [0.01, 0.01], [0, 0]]],
    });
    expect(ringAreaSqMeters([[[0, 0], [0.01, 0.01], [0.01, 0.01], [0, 0]]][0])).toBe(0);
    expect(outAndBack.ok).toBe(false);
    expect(outAndBack.reason).toMatch(/zero area/);

    // A collinear out-and-back ring overlaps its own return edge, so it is rejected as well.
    const collinear = validateParcelGeometry({ type: "Polygon", coordinates: [collinearRing] });
    expect(collinear.ok).toBe(false);
  });

  it("rejects open rings and rings with fewer than four positions", () => {
    expect(
      validateParcelGeometry({
        type: "Polygon",
        coordinates: [[[0, 0], [0.004, 0], [0, 0.004], [0.001, 0.001]]],
      }).ok
    ).toBe(false);
    expect(
      validateParcelGeometry({ type: "Polygon", coordinates: [[[0, 0], [0.004, 0], [0, 0]]] }).ok
    ).toBe(false);
  });

  it("rejects non-Polygon geometry and polygon holes in this phase", () => {
    expect(validateParcelGeometry({ type: "Point", coordinates: [0, 0] }).ok).toBe(false);
    expect(
      validateParcelGeometry({
        type: "Polygon",
        coordinates: [squareGeometry(0.004).coordinates[0], squareGeometry(0.001).coordinates[0]],
      }).ok
    ).toBe(false);
  });

  it("rejects non-finite coordinates without throwing", () => {
    const infinite = {
      type: "Polygon",
      coordinates: [[[0, 0], [Infinity, 0], [0, 0.004], [0, 0]]],
    };
    const nan = {
      type: "Polygon",
      coordinates: [[[0, 0], [NaN, 0], [0, 0.004], [0, 0]]],
    };
    expect(validateParcelGeometry(infinite).ok).toBe(false);
    expect(validateParcelGeometry(nan).ok).toBe(false);
    expect(calculateParcelAreaAcres(infinite)).toBeNull();
  });

  it("enforces the configured vertex cap deterministically", () => {
    const tooMany = validateParcelGeometry({ type: "Polygon", coordinates: [circularRing(100)] });
    const atCap = validateParcelGeometry({ type: "Polygon", coordinates: [circularRing(99)] });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.reason).toMatch(/exceeds 100 vertices/);
    expect(atCap.ok).toBe(true);
  });
});
