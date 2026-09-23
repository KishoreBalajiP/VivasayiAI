// Pure polygon geometry validation + authoritative area calculation for farm parcels (F-49,
// Phase 1 — Farm Parcel Foundation, ADR-019 P1/P4).
//
// Area algorithm: spherical geodesic "spherical excess" method (the same formula used by
// Mapbox's `geojson-area` / `@turf/area`): for a ring on the WGS84 sphere,
//   area ≈ R²/2 · | Σⱼ (λⱼ₊₁ − λⱼ) · (2 + sin φⱼ + sin φⱼ₊₁) |
// with R = 6378137 m (WGS84 equatorial radius). Implemented in-house (no runtime dependency)
// and unit-tested (tests/parcel.geometry.test.js). Input coordinates are WGS84
// [longitude, latitude]; result is in m², converted to acres with 1 acre = 4046.8564224 m².
//
// The AI never computes area (P4); this module is the ONLY source of authoritative parcel area.

const WGS84_EQUATORIAL_RADIUS_M = 6378137;
const SQ_METERS_PER_ACRE = 4046.8564224;

const MAX_RING_VERTICES = 100;
const MIN_AREA_SQ_METERS = 0.01; // below this, the polygon is degenerate (zero-area sliver)

const degToRad = (deg) => (deg * Math.PI) / 180;

// --- low-level helpers (exported for unit tests) ---

// GeoJSON linear rings are closed: first position === last position.
export const ringIsClosed = (ring) => {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
};

// Cross-product orientation of ordered triple (a,b,c) in the lon/lat plane.
const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const onSegment = (a, b, p) =>
  p[0] >= Math.min(a[0], b[0]) &&
  p[0] <= Math.max(a[0], b[0]) &&
  p[1] >= Math.min(a[1], b[1]) &&
  p[1] <= Math.max(a[1], b[1]);

// Two closed segments intersect if orientations straddle OR they share a collinear point.
const segmentsIntersect = (p1, p2, p3, p4) => {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
};

// A valid polygon ring must NOT self-intersect. Checks every non-adjacent edge pair; adjacent
// edges share exactly one vertex (the polygon boundary), so they are skipped.
export const ringSelfIntersects = (ring) => {
  // ring is closed: last edge closes (n-2 -> n-1). Edges: i -> i+1 for i in [0, n-2].
  const n = ring.length;
  const edges = [];
  for (let i = 0; i < n - 1; i += 1) edges.push([ring[i], ring[i + 1]]);

  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      // Skip immediately adjacent edges (they share an endpoint by construction), and also
      // skip the first/last edge pair, which shares the ring-closure vertex by construction.
      if (j === i + 1) continue;
      if (i === 0 && j === edges.length - 1) continue;
      if (segmentsIntersect(edges[i][0], edges[i][1], edges[j][0], edges[j][1])) {
        return true;
      }
    }
  }
  return false;
};

// Spherical excess area of a CLOSED exterior ring, in m². Ignores winding direction (returns
// the absolute value so a clockwise ring yields the same positive area).
export const ringAreaSqMeters = (ring) => {
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    total +=
      degToRad(p2[0] - p1[0]) *
      (2 + Math.sin(degToRad(p1[1])) + Math.sin(degToRad(p2[1])));
  }
  return (Math.abs(total) * WGS84_EQUATORIAL_RADIUS_M ** 2) / 2;
};

export const sqMetersToAcres = (sqMeters) => sqMeters / SQ_METERS_PER_ACRE;

// Round to 4 decimal places of an acre (~0.4 m² granularity at that precision). Single defined
// precision for stored calculatedAreaAcres (ADR-019 P4 / 07_Database_Design §5).
export const roundAcres = (acres) => Math.round(acres * 10000) / 10000;

export const inspectPolygonRing = (ring) => {
  if (!ringIsClosed(ring)) {
    return { ok: false, reason: "polygon ring must be closed (first and last coordinates must match)" };
  }
  if (ring.length > MAX_RING_VERTICES) {
    return { ok: false, reason: `polygon exceeds ${MAX_RING_VERTICES} vertices` };
  }
  if (ringSelfIntersects(ring)) {
    return { ok: false, reason: "polygon self-intersects; edges must not cross" };
  }
  const areaSqMeters = ringAreaSqMeters(ring);
  if (!(areaSqMeters > MIN_AREA_SQ_METERS)) {
    return { ok: false, reason: "polygon has zero area (degenerate)" };
  }
  return { ok: true, areaSqMeters };
};

// Public: validate + compute the authoritative area in acres for a GeoJSON Polygon whose
// coordinates hold EXACTLY ONE exterior ring (no holes in MVP). Returns { ok, acres? } where
// acres is rounded to 4 decimal places. Never throws; schema + service both use it.
export const validateParcelGeometry = (geometry) => {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    return { ok: false, reason: "geometry must be an object" };
  }
  if (geometry.type !== "Polygon") {
    return { ok: false, reason: "geometry.type must be 'Polygon'" };
  }
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
    return { ok: false, reason: "coordinates must contain at least one linear ring" };
  }
  if (geometry.coordinates.length !== 1) {
    return { ok: false, reason: "only a single exterior ring is supported (no holes in this phase)" };
  }
  const ring = geometry.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4) {
    return { ok: false, reason: "linear ring must contain at least 4 positions" };
  }

  const inspection = inspectPolygonRing(ring);
  if (!inspection.ok) return inspection;
  return { ok: true, acres: roundAcres(sqMetersToAcres(inspection.areaSqMeters)) };
};

export const calculateParcelAreaAcres = (geometry) => {
  const result = validateParcelGeometry(geometry);
  if (!result.ok) return null;
  return result.acres;
};