// Pure helpers for seeding hermetic e2e data (ADR-024). No application imports.

// UTC midnight `days` days ago (critique E1: eventDaysAgo 0 is today in UTC).
export const utcEventDate = (days, now = new Date()) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - Math.max(0, Math.floor(Number(days) || 0)))).toISOString();

export const squareAt = ([lon, lat], size = 0.0015) => ({
  type: "Polygon",
  coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
});
// Each session gets its own patch of Thanjavur (no accidental overlap between tests' farmers).
export const defaultParcelGeometry = (index) => squareAt([79.135 + (index % 40) * 0.004, 10.79 + Math.floor(index / 40) % 40 * 0.004]);
// A claim over the parcel with ~14% more area than the parcel allows (5% tolerance): out_of_limit.
export const overLimitGeometry = (parcelGeometry) => {
  const [lon, lat] = parcelGeometry.coordinates[0][0];
  const size = Math.abs(parcelGeometry.coordinates[0][1][0] - lon) || 0.0015;
  return squareAt([lon, lat], size * 1.07);
};


export default { utcEventDate, squareAt, defaultParcelGeometry, overLimitGeometry };
