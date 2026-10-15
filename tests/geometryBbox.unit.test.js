import { describe, expect, it } from "vitest";
import { bboxesIntersect, geometryBbox } from "../utils/geometryBbox.js";

describe("geometryBbox", () => {
  const square = (origin = [0, 0], size = 1) => ({
    type: "Polygon",
    coordinates: [[origin, [origin[0] + size, origin[1]], [origin[0] + size, origin[1] + size], [origin[0], origin[1] + size], origin]],
  });

  it("GB-1: computes the box of a polygon", () => {
    expect(geometryBbox(square([78, 10], 0.5))).toEqual({ minLon: 78, minLat: 10, maxLon: 78.5, maxLat: 10.5 });
  });

  it("GB-2: covers every part of a MultiPolygon", () => {
    const multi = { type: "MultiPolygon", coordinates: [square([0, 0]).coordinates, square([5, 5]).coordinates] };
    expect(geometryBbox(multi)).toEqual({ minLon: 0, minLat: 0, maxLon: 6, maxLat: 6 });
  });

  it("GB-3: refuses anything that is not a usable polygon (never a partial or NaN box)", () => {
    for (const bad of [null, undefined, {}, { type: "Point", coordinates: [1, 2] }, { type: "Polygon", coordinates: [] },
      { type: "Polygon", coordinates: [[[0, 0], [1, "x"]]] }, { type: "Polygon", coordinates: [[[0, 0], [NaN, 1]]] }]) {
      expect(geometryBbox(bad)).toBeNull();
    }
  });

  it("GB-4: intersection test includes touching edges and excludes disjoint boxes", () => {
    const a = geometryBbox(square([0, 0]));
    expect(bboxesIntersect(a, geometryBbox(square([1, 1])))).toBe(true);
    expect(bboxesIntersect(a, geometryBbox(square([2, 2])))).toBe(false);
    expect(bboxesIntersect(a, null)).toBe(false);
  });
});
