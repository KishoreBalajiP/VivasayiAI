// Axis-aligned bounding box of a GeoJSON Polygon or MultiPolygon, as { minLon, minLat, maxLon, maxLat }.
// Pure. Returns null for anything that is not a usable polygon geometry, so callers never store a
// partial or NaN box. Used as a cheap pre-filter for cross-claim overlap lookups: a plain indexed
// range query on four numbers, unlike a 2dsphere index whose strict polygon validation could make
// an index build fail on existing rows.
export const geometryBbox = (geometry) => {
  if (!geometry || typeof geometry !== "object") return null;
  const rings =
    geometry.type === "Polygon"
      ? geometry.coordinates
      : geometry.type === "MultiPolygon"
        ? (geometry.coordinates || []).flat()
        : null;
  if (!Array.isArray(rings) || rings.length === 0) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    if (!Array.isArray(ring)) return null;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) return null;
      const [lon, lat] = point;
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return { minLon, minLat, maxLon, maxLat };
};

export const bboxesIntersect = (a, b) =>
  Boolean(a && b) && a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;

export default { geometryBbox, bboxesIntersect };
