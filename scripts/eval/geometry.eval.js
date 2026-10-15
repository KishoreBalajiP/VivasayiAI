import { computeInsideParcel, computeOverlapAcres } from "../../services/claimSpatial.service.js";
import { validateParcelGeometry } from "../../services/parcelGeometry.service.js";
import { between, confusion, pick, rate, rng, scores, summary } from "./lib/metrics.js";

// Geometry and overlap evaluation against ANALYTIC ground truth.
//
// Parcels and claims are axis-aligned rectangles defined in metres in a local frame, then placed at
// random positions across Tamil Nadu. Expected containment, overlap area and validity follow from the
// rectangle arithmetic alone, independently of the code under test. This checks the geometry
// implementation against exact answers; it does NOT measure how well the system matches real cadastral
// boundaries, which needs real surveyed parcels (see docs/research/evaluation/README.md).

const ACRE_M2 = 4046.8564224;
const TN = { latMin: 8.1, latMax: 13.5, lonMin: 76.2, lonMax: 80.3 };
const TOLERANCE_M = 1.0; // CLAIM_OVERLAP_TOLERANCE_M default
const THRESHOLDS = { minOverlapAcres: 0.05, minShare: 0.1 }; // policy crossFarmer defaults

// WGS84 metres per degree at a latitude (standard series).
const mPerDegLat = (phi) => 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const mPerDegLon = (phi) => 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);

// A rectangle (metres east/north of an origin) -> GeoJSON polygon.
const makeFrame = (lat0, lon0) => {
  const phi = (lat0 * Math.PI) / 180;
  const dLat = 1 / mPerDegLat(phi);
  const dLon = 1 / mPerDegLon(phi);
  const toLonLat = (x, y) => [lon0 + x * dLon, lat0 + y * dLat];
  const rect = ({ x, y, w, h }) => ({
    type: "Polygon",
    coordinates: [[toLonLat(x, y), toLonLat(x + w, y), toLonLat(x + w, y + h), toLonLat(x, y + h), toLonLat(x, y)]],
  });
  return { rect };
};

const intersectArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

const randomFrame = (random) => makeFrame(between(random, TN.latMin, TN.latMax), between(random, TN.lonMin, TN.lonMax));

export const runGeometryEvaluation = ({ seed = 20261016 } = {}) => {
  const random = rng(seed);

  // ---- 1. Area ------------------------------------------------------------------------------
  const areaErrors = [];
  for (let i = 0; i < 200; i += 1) {
    const frame = randomFrame(random);
    const r = { x: 0, y: 0, w: between(random, 20, 600), h: between(random, 20, 600) };
    const result = validateParcelGeometry(frame.rect(r));
    if (!result.ok) continue;
    const expectedAcres = (r.w * r.h) / ACRE_M2;
    areaErrors.push(Math.abs(result.acres - expectedAcres) / expectedAcres);
  }

  // ---- 2. Containment within the registered parcel -----------------------------------------------
  const containment = [];
  for (let i = 0; i < 300; i += 1) {
    const frame = randomFrame(random);
    const parcel = { x: 0, y: 0, w: between(random, 80, 500), h: between(random, 80, 500) };
    const kind = pick(random, ["inside", "inside", "outside", "overhang"]);
    let claim;
    let expectedInside;
    if (kind === "inside") {
      const w = between(random, 10, parcel.w * 0.9);
      const h = between(random, 10, parcel.h * 0.9);
      claim = { x: between(random, 0.5, parcel.w - w - 0.5), y: between(random, 0.5, parcel.h - h - 0.5), w, h };
      expectedInside = true;
    } else if (kind === "outside") {
      claim = { x: parcel.w + between(random, 20, 400), y: between(random, 0, parcel.h), w: between(random, 10, 100), h: between(random, 10, 100) };
      expectedInside = false;
    } else {
      // Crosses the east edge by a known amount, spanning the tolerance on both sides.
      const overhang = pick(random, [0.2, 0.5, 0.8, 1.5, 2, 5, 15, 40]);
      const w = between(random, 20, parcel.w * 0.6);
      claim = { x: parcel.w - w + overhang, y: between(random, 1, Math.max(1.5, parcel.h - 30)), w, h: between(random, 10, 30) };
      expectedInside = overhang <= TOLERANCE_M;
    }
    const actual = computeInsideParcel({ claimedGeometry: frame.rect(claim), parcelGeometry: frame.rect(parcel), toleranceMeters: TOLERANCE_M });
    containment.push({ kind, expected: expectedInside, actual });
  }
  const undecidedContainment = containment.filter((c) => c.actual === null).length;
  // Positive class = "claim is OUTSIDE the parcel" (the case the engine must catch).
  const containmentScores = scores(confusion(containment.filter((c) => c.actual !== null).map((c) => ({ expected: !c.expected, actual: !c.actual }))));
  const byKind = {};
  for (const kind of ["inside", "outside", "overhang"]) {
    const rows = containment.filter((c) => c.kind === kind && c.actual !== null);
    byKind[kind] = rate(rows.filter((c) => c.actual === c.expected).length, rows.length);
  }

  // ---- 3. Overlap area and the cross-farmer review flag -----------------------------------------------
  const overlapRows = [];
  const overlapErrors = [];
  for (let i = 0; i < 300; i += 1) {
    const frame = randomFrame(random);
    const a = { x: 0, y: 0, w: between(random, 40, 400), h: between(random, 40, 400) };
    const kind = pick(random, ["disjoint", "touching", "sliver", "partial", "partial", "contained", "identical"]);
    let b;
    if (kind === "disjoint") b = { x: a.w + between(random, 10, 300), y: between(random, 0, a.h), w: between(random, 20, 200), h: between(random, 20, 200) };
    else if (kind === "touching") b = { x: a.w, y: between(random, 0, a.h / 2), w: between(random, 20, 200), h: between(random, 20, 200) };
    else if (kind === "sliver") b = { x: a.w - between(random, 0.5, 3), y: 0, w: between(random, 20, 200), h: a.h };
    else if (kind === "partial") b = { x: between(random, a.w * 0.2, a.w * 0.9), y: between(random, a.h * 0.2, a.h * 0.9), w: between(random, 40, 300), h: between(random, 40, 300) };
    else if (kind === "contained") b = { x: a.w * 0.2, y: a.h * 0.2, w: a.w * 0.5, h: a.h * 0.5 };
    else b = { ...a };

    const expectedAcres = intersectArea(a, b) / ACRE_M2;
    const claimAcres = (b.w * b.h) / ACRE_M2;
    const expectedFlag = expectedAcres >= THRESHOLDS.minOverlapAcres && expectedAcres / claimAcres >= THRESHOLDS.minShare;

    const actualAcres = computeOverlapAcres({ geometryA: frame.rect(b), geometryB: frame.rect(a) });
    const actualFlag = actualAcres >= THRESHOLDS.minOverlapAcres && actualAcres / claimAcres >= THRESHOLDS.minShare;
    overlapRows.push({ kind, expected: expectedFlag, actual: actualFlag });
    // Relative error where there is real overlap; where there is none, any overlap the code reports
    // (beyond its 4-decimal rounding) is a phantom and counts as a full error.
    if (expectedAcres > 0) overlapErrors.push(Math.abs(actualAcres - expectedAcres) / expectedAcres);
    else if (actualAcres > 0.0001) overlapErrors.push(1);
  }
  const flagByKind = {};
  for (const kind of ["disjoint", "touching", "sliver", "partial", "contained", "identical"]) {
    const rows = overlapRows.filter((r) => r.kind === kind);
    flagByKind[kind] = rate(rows.filter((r) => r.actual === r.expected).length, rows.length);
  }

  // ---- 4. Invalid geometry detection ----------------------------------------------------------------------------
  const validRows = [];
  for (let i = 0; i < 100; i += 1) {
    const frame = randomFrame(random);
    validRows.push({ kind: "valid", expected: false, actual: !validateParcelGeometry(frame.rect({ x: 0, y: 0, w: between(random, 20, 500), h: between(random, 20, 500) })).ok });
  }
  const invalidKinds = {
    bowtie: (f, r) => ({ type: "Polygon", coordinates: [[f(0, 0), f(r.w, r.h), f(r.w, 0), f(0, r.h), f(0, 0)]] }),
    unclosed: (f, r) => ({ type: "Polygon", coordinates: [[f(0, 0), f(r.w, 0), f(r.w, r.h), f(0, r.h)]] }),
    twoPoints: (f, r) => ({ type: "Polygon", coordinates: [[f(0, 0), f(r.w, 0), f(0, 0)]] }),
    outOfRange: () => ({ type: "Polygon", coordinates: [[[200, 0], [201, 0], [201, 1], [200, 1], [200, 0]]] }),
    notPolygon: (f) => ({ type: "Point", coordinates: f(0, 0) }),
    zeroArea: (f) => ({ type: "Polygon", coordinates: [[f(0, 0), f(10, 0), f(20, 0), f(0, 0)]] }),
  };
  const invalidRows = [];
  for (const [kind, build] of Object.entries(invalidKinds)) {
    for (let i = 0; i < 15; i += 1) {
      const lat0 = between(random, TN.latMin, TN.latMax);
      const lon0 = between(random, TN.lonMin, TN.lonMax);
      const phi = (lat0 * Math.PI) / 180;
      const f = (x, y) => [lon0 + x / mPerDegLon(phi), lat0 + y / mPerDegLat(phi)];
      const r = { w: between(random, 30, 300), h: between(random, 30, 300) };
      invalidRows.push({ kind, expected: true, actual: !validateParcelGeometry(build(f, r)).ok });
    }
  }
  const invalidByKind = {};
  for (const kind of Object.keys(invalidKinds)) {
    const rows = invalidRows.filter((r) => r.kind === kind);
    invalidByKind[kind] = rate(rows.filter((r) => r.actual).length, rows.length);
  }

  return {
    name: "geometry",
    seed,
    description: "Geometry validation, containment, overlap area and the cross-farmer review flag against analytic rectangle ground truth, placed at random positions across Tamil Nadu.",
    groundTruth: "analytic (rectangle arithmetic in a local metre frame); independent of the code under test",
    parameters: { toleranceMeters: TOLERANCE_M, crossFarmerThresholds: THRESHOLDS },
    area: { n: areaErrors.length, relativeError: summary(areaErrors), note: "server acres vs an ellipsoidal metres-per-degree reference; the server uses a spherical-earth area formula, so a small systematic difference is expected" },
    containment: { positiveClass: "claim outside the parcel", undecided: undecidedContainment, scores: containmentScores, correctByKind: byKind },
    overlap: {
      flagScores: scores(confusion(overlapRows)),
      correctByKind: flagByKind,
      areaRelativeError: summary(overlapErrors),
    },
    invalidGeometry: {
      detection: scores(confusion([...validRows, ...invalidRows])),
      detectedByKind: invalidByKind,
      validRejected: rate(validRows.filter((r) => r.actual).length, validRows.length),
    },
    limitations: [
      "Axis-aligned rectangles only; real parcels are irregular.",
      "Ground truth is analytic, not surveyed cadastral data, so this says nothing about agreement with official boundaries.",
      "Thresholds are provisional policy values, not calibrated.",
    ],
  };
};

export default runGeometryEvaluation;
