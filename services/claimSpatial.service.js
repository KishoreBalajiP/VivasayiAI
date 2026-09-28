import {
  area,
  booleanContains,
  buffer,
  difference,
  feature,
  featureCollection,
  intersect,
} from "@turf/turf";
import { roundAcres, sqMetersToAcres } from "./parcelGeometry.service.js";

// E9-S9 (Phase 9) — Real Overclaim-Prevention Engine: SPATIAL layer. ADR-019 annex.
//
// PURE computational service (Turf only — the sole spatial dependency in the codebase). No
// database, no Express, no network, no AI. It converts raw geometries + server-owned sibling
// claim facts into the STRUCTURED overlap metadata the deterministic rule engine consumes:
//   - insideParcle  : is the drawn polygon inside the owner's parcel (with tolerance)?
//   - overlapAreaAcres + overlaps[] : drawn area vs VERIFIED / SUBMITTED / PROCESSING siblings
//   - remainingEligibleAcres        : parcel − verified − partially verified − in-flight
// The farm never computes any of this; every acre here is server-derived (P4).
//
// Frozen invariants (same as the rule engine):
//   - Areas use the SAME acre conversions as services/parcelGeometry.service.js (WGS84 equatorial
//     radius, SQ_METERS_PER_ACRE 4046.8564224, round4). Consistency is what makes the values
//     auditable across the claim's lifecycle.
//   - `parcelAreaAcres` is ALWAYS the server-stored parcel area (FarmProfile.calculatedAreaAcres
//     denormalized into the claim snapshot), never a client value.
//   - The budget NEVER trusts client-furnished verified/in-flight acreage; reserves come only from
//     sibling claims already persisted (approved area for verified/partial, claimed area for
//     submitted/processing).

const SQ_METERS_PER_ACRE = 4046.8564224;

// Approximate sharing threshold: a drawn area that shares ≥95% of its area with an already
// verified claim is treated as an attempt at the SAME land (duplicate_area), not a new parcel.
const DUPLICATE_AREA_SHARE = 0.95;

const toFeature = (geometry) => {
  if (!geometry || typeof geometry !== "object") return null;
  if (geometry.type === "Feature") return geometry;
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return feature(geometry);
  return null;
};

// Acres of the intersection of two geometries (0 when they do not overlap). Never throws: a
// degenerate/self-intersecting input simply yields 0 overlap (the rule engine still applies its
// own geometry validation at claim creation, so this is a floor, not a bypass).
export const computeOverlapAcres = ({ geometryA, geometryB }) => {
  const featureA = toFeature(geometryA);
  const featureB = toFeature(geometryB);
  if (!featureA || !featureB) return 0;
  try {
    const overlapped = intersect(featureCollection([featureA, featureB]));
    if (!overlapped) return 0;
    return roundAcres(sqMetersToAcres(area(overlapped)));
  } catch {
    return 0;
  }
};

// Whether TWO geometries share any area (used for in-flight overlap flags).
export const hasAnyOverlap = ({ geometryA, geometryB }) =>
  computeOverlapAcres({ geometryA, geometryB }) > 0;

// Is the drawn polygon inside the owner's parcel, allowing a configurable boundary tolerance
// (meters). A claim sitting fully inside the parcel yields true; a polygon partially/wholly
// outside yields false (the rule engine rejects as "outside the parcel boundary").
export const computeInsideParcel = ({ claimedGeometry, parcelGeometry, toleranceMeters = 0 }) => {
  const claim = toFeature(claimedGeometry);
  let parcel = toFeature(parcelGeometry);
  if (!claim || !parcel) return null; // unknown geometry -> engine keeps legacy unchecked behavior
  try {
    if (toleranceMeters > 0) {
      const buffered = buffer(parcel, toleranceMeters, { units: "meters" });
      if (!buffered) return null;
      parcel = buffered;
    }
    return booleanContains(parcel, claim);
  } catch {
    return null;
  }
};

// The remainder of `claimedGeometry` that is NOT covered by a set of overlay geometries. Used to
// compute the APPROVABLE portion when a claim partially overlaps an already-verified claim.
export const computeNonOverlappingGeometry = ({ claimedGeometry, overlays }) => {
  let remainder = toFeature(claimedGeometry);
  if (!remainder) return null;
  for (const overlay of overlays) {
    const other = toFeature(overlay && overlay.geometry);
    if (!other) continue;
    try {
      const next = difference(featureCollection([remainder, other]));
      remainder = next;
      if (!remainder) return null; // fully covered: nothing remains
    } catch {
      return null;
    }
  }
  return remainder || null;
};

// Full spatial context for a claim under verification.
//
//   claimedGeometry     — the farmer's drawn polygon (server-validated at creation).
//   parcelGeometry      — the owner's stored parcel polygon (may be absent -> insideParcle null).
//   parcelAreaAcres     — server-stored parcel area (denormalized snapshot).
//   verifiedSiblings    — [{ claimId, geometry, areaAcres }] (assessments approved geometry/area).
//   inFlightSiblings    — [{ claimId, geometry, areaAcres }] (submitted/processing, claimed area).
//   toleranceMeters     — boundary tolerance (env.claimOverlapToleranceM).
//
// Returns structured overlap metadata (08_API_Documentation §10.8 enriched):
//   { insideParcel, overlapStatus, overlapAreaAcres, remainingEligibleAcres,
//     previouslyVerifiedAcres, inFlightAreaAcres, overlaps, overlapWarnings,
//     partialApproval: { geometry, areaAcres } | null, fullyCovered }
export const buildSpatialContext = ({
  claimedGeometry,
  claimedAreaAcres,
  parcelGeometry,
  parcelAreaAcres,
  verifiedSiblings = [],
  inFlightSiblings = [],
  toleranceMeters = 0,
}) => {
  const insideParcel = computeInsideParcel({
    claimedGeometry,
    parcelGeometry,
    toleranceMeters,
  });

  // Overlap vs already-verified/partially-verified siblings.
  const verifiedOverlaps = [];
  let overlapAreaAcres = 0;
  for (const sibling of verifiedSiblings || []) {
    const acres = computeOverlapAcres({ geometryA: claimedGeometry, geometryB: sibling.geometry });
    if (acres > 0) {
      overlapAreaAcres = roundAcres(overlapAreaAcres + acres);
      verifiedOverlaps.push({
        claimId: sibling.claimId,
        siblingState: sibling.siblingState || "verified",
        overlapAreaAcres: acres,
      });
    }
  }

  // Overlap vs in-flight (submitted/processing) claims — never cancellable until decided.
  const inFlightOverlaps = [];
  for (const sibling of inFlightSiblings || []) {
    if (hasAnyOverlap({ geometryA: claimedGeometry, geometryB: sibling.geometry })) {
      inFlightOverlaps.push({
        claimId: sibling.claimId,
        siblingState: sibling.siblingState || "submitted",
      });
    }
  }

  const overlapStatus =
    verifiedOverlaps.length > 0
      ? "overlaps_verified"
      : inFlightOverlaps.length > 0
        ? "overlaps_in_flight"
        : "none";

  // Eligibility budget (server-derived: parcel − verified − partially verified − in-flight).
  const previouslyVerifiedAcres = roundAcres(
    (verifiedSiblings || []).reduce((sum, s) => sum + (Number(s.areaAcres) || 0), 0)
  );
  const inFlightAreaAcres = roundAcres(
    (inFlightSiblings || []).reduce((sum, s) => sum + (Number(s.areaAcres) || 0), 0)
  );
  const remainingEligibleAcres = roundAcres(
    Math.max(0, roundAcres((Number(parcelAreaAcres) || 0) - previouslyVerifiedAcres - inFlightAreaAcres))
  );

  // Partial approval: when the claim partially overlaps verified land, the NEW (non-overlapping)
  // portion is the only approvable area. The geometric remainder is computed with Turf `difference`
  // so the engine's approvedGeometry stays exact, not an approximation. The share is computed
  // against the SERVER-derived claimedAreaAcres (parcelGeometry, P4) — never a Turf re-derivation.
  let partialApproval = null;
  let fullyCovered = false;
  if (verifiedOverlaps.length > 0) {
    const claimedAcres = Number(claimedAreaAcres) || 0;
    const share = claimedAcres > 0 ? roundAcres(overlapAreaAcres / claimedAcres) : 1;
    if (share >= DUPLICATE_AREA_SHARE) {
      fullyCovered = true;
    } else {
      const remainder = computeNonOverlappingGeometry({
        claimedGeometry,
        overlays: verifiedSiblings,
      });
      if (remainder) {
        const remainderAcres = roundAcres(sqMetersToAcres(area(remainder)));
        if (remainderAcres > 0) {
          partialApproval = { geometry: remainder, areaAcres: remainderAcres };
        }
      }
      if (!partialApproval) fullyCovered = true;
    }
  }

  const overlapWarnings = [];
  if (insideParcel === false) {
    overlapWarnings.push({
      code: "outside_parcel",
      message: "The drawn area is outside the parcel boundary",
    });
  }
  if (inFlightOverlaps.length > 0) {
    overlapWarnings.push({
      code: "overlaps_in_flight",
      message: "The drawn area overlaps a claim still in progress",
      claims: inFlightOverlaps,
    });
  }
  if (verifiedOverlaps.length > 0) {
    overlapWarnings.push({
      code: "overlaps_verified",
      message: fullyCovered
        ? "The drawn area is already claimed"
        : "The drawn area partially overlaps an already verified claim",
      claims: verifiedOverlaps,
      overlapAreaAcres,
    });
  }

  return {
    insideParcel,
    overlapStatus,
    overlapAreaAcres,
    remainingEligibleAcres,
    previouslyVerifiedAcres,
    inFlightAreaAcres,
    overlaps: [...verifiedOverlaps, ...inFlightOverlaps],
    overlapWarnings,
    partialApproval,
    fullyCovered,
  };
};

export const CLAIM_SPATIAL_ENGINE_VERSION = "1";

export default {
  CLAIM_SPATIAL_ENGINE_VERSION,
  computeOverlapAcres,
  hasAnyOverlap,
  computeInsideParcel,
  computeNonOverlappingGeometry,
  buildSpatialContext,
};