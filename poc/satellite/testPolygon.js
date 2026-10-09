// Phase 13.2 — Satellite Verification PoC test fixture (ISOLATED, non-production).
//
// A single SYNTHETIC agricultural parcel used only by the PoC. It is NOT derived from any real
// farmer, claim, or production parcel, and is NOT persisted anywhere. It is deliberately small
// (~0.4 ha / ~1 acre) and inside a well-known paddy-growing area near Thanjavur, Tamil Nadu, so
// that public satellite catalogues return real scenes for bounded discovery requests.
//
// Coordinate reference system: WGS84 / EPSG:4326, GeoJSON position order [longitude, latitude].
// The polygon is a closed single exterior ring — the same shape the production parcel layer
// accepts (services/parcelGeometry.service.js). The PoC reuses that validator READ-ONLY; it never
// modifies the authoritative parcel-area calculation.

export const TEST_PARCEL_LABEL = "SYNTHETIC-POC-PARCEL-THANJAVUR-TN";

// Synthetic square, side 0.0006° (~66 m), centroid ~ [79.1378, 10.7867], Thanjavur district, TN.
// Approximate extent is recomputed at runtime with the existing geometry validator.
export const TEST_PARCEL_GEOMETRY = Object.freeze({
  type: "Polygon",
  coordinates: [
    [
      [79.1375, 10.7864],
      [79.1381, 10.7864],
      [79.1381, 10.787],
      [79.1375, 10.787],
      [79.1375, 10.7864],
    ],
  ],
});

// Synthetic event. This is an arbitrary date used to split a bounded discovery window into a
// "before" and "after" period for a pre/post indicator comparison. It is NOT a real claim event.
export const TEST_EVENT_DATE = "2024-03-20T00:00:00Z";

export const TEST_PRE_WINDOW = Object.freeze({
  start: "2024-02-01T00:00:00Z",
  end: "2024-03-15T00:00:00Z",
});

export const TEST_POST_WINDOW = Object.freeze({
  start: "2024-03-21T00:00:00Z",
  end: "2024-04-30T00:00:00Z",
});

export const TEST_PARCEL = Object.freeze({
  label: TEST_PARCEL_LABEL,
  synthetic: true,
  district: "Thanjavur",
  state: "Tamil Nadu",
  country: "India",
  crop: "Paddy",
  crs: "EPSG:4326",
  geometry: TEST_PARCEL_GEOMETRY,
  eventDate: TEST_EVENT_DATE,
  preWindow: TEST_PRE_WINDOW,
  postWindow: TEST_POST_WINDOW,
});

export default TEST_PARCEL;
