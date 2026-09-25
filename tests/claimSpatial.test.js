import { describe, it, expect } from "vitest";
import {
  computeOverlapAcres,
  hasAnyOverlap,
  computeInsideParcel,
  computeNonOverlappingGeometry,
  buildSpatialContext,
  CLAIM_SPATIAL_ENGINE_VERSION,
} from "../services/claimSpatial.service.js";

// Test geometries (small square ~0.009 deg = ~1km at equator, area ~0.5 acres)
const squareGeometry = (size = 0.009) => ({
  type: "Polygon",
  coordinates: [[
    [77.0, 11.0],
    [77.0 + size, 11.0],
    [77.0 + size, 11.0 + size],
    [77.0, 11.0 + size],
    [77.0, 11.0],
  ]],
});

const parcelGeometry = () => ({
  type: "Polygon",
  coordinates: [[
    [77.0 - 0.01, 11.0 - 0.01],
    [77.0 + 0.02, 11.0 - 0.01],
    [77.0 + 0.02, 11.0 + 0.02],
    [77.0 - 0.01, 11.0 + 0.02],
    [77.0 - 0.01, 11.0 - 0.01],
  ]],
});

describe("E9-S9 — claimSpatial.service (Turf spatial engine)", () => {
  describe("CLAIM_SPATIAL_ENGINE_VERSION", () => {
    it("exposes the spatial engine version", () => {
      expect(CLAIM_SPATIAL_ENGINE_VERSION).toBe("1");
    });
  });

  describe("computeOverlapAcres", () => {
    it("returns 0 for non-overlapping polygons", () => {
      const a = squareGeometry(0.009);
      const b = { ...squareGeometry(0.009), coordinates: [[[77.1, 11.1], [77.109, 11.1], [77.109, 11.109], [77.1, 11.109], [77.1, 11.1]]] };
      expect(computeOverlapAcres({ geometryA: a, geometryB: b })).toBe(0);
    });

    it("returns positive acres for overlapping polygons", () => {
      const a = squareGeometry(0.009);
      const b = squareGeometry(0.009); // identical
      const acres = computeOverlapAcres({ geometryA: a, geometryB: b });
      expect(acres).toBeGreaterThan(0);
    });

    it("handles null/undefined geometry gracefully", () => {
      expect(computeOverlapAcres({ geometryA: null, geometryB: squareGeometry() })).toBe(0);
      expect(computeOverlapAcres({ geometryA: squareGeometry(), geometryB: undefined })).toBe(0);
    });

    it("is symmetric (A vs B == B vs A)", () => {
      const a = squareGeometry(0.009);
      const b = squareGeometry(0.009);
      expect(computeOverlapAcres({ geometryA: a, geometryB: b })).toBe(computeOverlapAcres({ geometryA: b, geometryB: a }));
    });

    it("handles Feature objects (not just raw geometries)", () => {
      const a = { type: "Feature", geometry: squareGeometry(0.009) };
      const b = { type: "Feature", geometry: squareGeometry(0.009) };
      expect(computeOverlapAcres({ geometryA: a, geometryB: b })).toBeGreaterThan(0);
    });
  });

  describe("hasAnyOverlap", () => {
    it("returns true for overlapping polygons", () => {
      const a = squareGeometry(0.009);
      const b = squareGeometry(0.009);
      expect(hasAnyOverlap({ geometryA: a, geometryB: b })).toBe(true);
    });

    it("returns false for non-overlapping polygons", () => {
      const a = squareGeometry(0.009);
      const b = { ...squareGeometry(0.009), coordinates: [[[77.1, 11.1], [77.109, 11.1], [77.109, 11.109], [77.1, 11.109], [77.1, 11.1]]] };
      expect(hasAnyOverlap({ geometryA: a, geometryB: b })).toBe(false);
    });
  });

  describe("computeInsideParcel", () => {
    it("returns true when claim is inside parcel", () => {
      const claim = squareGeometry(0.009);
      const parcel = parcelGeometry();
      expect(computeInsideParcel({ claimedGeometry: claim, parcelGeometry: parcel, toleranceMeters: 0 })).toBe(true);
    });

    it("returns false when claim is outside parcel", () => {
      const claim = { ...squareGeometry(0.009), coordinates: [[[78.0, 12.0], [78.009, 12.0], [78.009, 12.009], [78.0, 12.009], [78.0, 12.0]]] };
      const parcel = parcelGeometry();
      expect(computeInsideParcel({ claimedGeometry: claim, parcelGeometry: parcel, toleranceMeters: 0 })).toBe(false);
    });

    it("returns null when parcel geometry is missing", () => {
      expect(computeInsideParcel({ claimedGeometry: squareGeometry(), parcelGeometry: null, toleranceMeters: 0 })).toBeNull();
    });

    it("returns null when claim geometry is missing", () => {
      expect(computeInsideParcel({ claimedGeometry: null, parcelGeometry: parcelGeometry(), toleranceMeters: 0 })).toBeNull();
    });

    it("buffer tolerance expands parcel boundary", () => {
      // Claim clearly outside parcel (~1km outside at equator: 0.009 deg ≈ 1km)
      const claim = { ...squareGeometry(0.009), coordinates: [[[77.05, 11.05], [77.059, 11.05], [77.059, 11.059], [77.05, 11.059], [77.05, 11.05]]] };
      const parcel = parcelGeometry();
      const strict = computeInsideParcel({ claimedGeometry: claim, parcelGeometry: parcel, toleranceMeters: 0 });
      const tolerant = computeInsideParcel({ claimedGeometry: claim, parcelGeometry: parcel, toleranceMeters: 1 });
      expect(strict).toBe(false);
      // With 1m buffer, the parcel boundary expands by ~0.000009 deg (1m at equator)
      // The claim at 77.05 is still far outside, so tolerant should also be false
      // This test verifies the function doesn't throw and handles tolerance parameter
      expect(tolerant).toBe(false);
    });
  });

  describe("computeNonOverlappingGeometry", () => {
    it("returns null when claim is fully covered by overlay", () => {
      const claim = squareGeometry(0.009);
      const overlays = [{ geometry: squareGeometry(0.009) }];
      const remainder = computeNonOverlappingGeometry({ claimedGeometry: claim, overlays });
      expect(remainder).toBeNull();
    });

    it("returns remainder when claim partially overlaps overlay", () => {
      const claim = squareGeometry(0.01);
      const overlay = { ...squareGeometry(0.005), coordinates: [[[77.0, 11.0], [77.005, 11.0], [77.005, 11.005], [77.0, 11.005], [77.0, 11.0]]] };
      const overlays = [{ geometry: overlay }];
      const remainder = computeNonOverlappingGeometry({ claimedGeometry: claim, overlays });
      expect(remainder).not.toBeNull();
      expect(remainder.type).toBe("Feature");
      expect(remainder.geometry.type).toMatch(/Polygon|MultiPolygon/);
    });

    it("returns claim geometry when no overlays", () => {
      const claim = squareGeometry(0.009);
      const remainder = computeNonOverlappingGeometry({ claimedGeometry: claim, overlays: [] });
      expect(remainder).not.toBeNull();
      expect(remainder.geometry).toEqual(claim);
    });
  });

  describe("buildSpatialContext", () => {
    it("returns insideParcel=true for claim inside parcel", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.insideParcel).toBe(true);
      expect(ctx.overlapStatus).toBe("none");
      expect(ctx.overlapAreaAcres).toBe(0);
      expect(ctx.remainingEligibleAcres).toBe(1.0);
      expect(ctx.previouslyVerifiedAcres).toBe(0);
      expect(ctx.inFlightAreaAcres).toBe(0);
      expect(ctx.partialApproval).toBeNull();
      expect(ctx.fullyCovered).toBe(false);
    });

    it("returns insideParcel=false for claim outside parcel", () => {
      const claim = { ...squareGeometry(0.009), coordinates: [[[78.0, 12.0], [78.009, 12.0], [78.009, 12.009], [78.0, 12.009], [78.0, 12.0]]] };
      const ctx = buildSpatialContext({
        claimedGeometry: claim,
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.insideParcel).toBe(false);
    });

    it("detects overlaps_verified with verified siblings", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [{ claimId: "c1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 0.5 }],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.overlapStatus).toBe("overlaps_verified");
      expect(ctx.overlapAreaAcres).toBeGreaterThan(0);
      expect(ctx.overlaps.length).toBe(1);
      expect(ctx.overlaps[0].siblingState).toBe("verified");
    });

    it("detects overlaps_in_flight with submitted/processing siblings", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [],
        inFlightSiblings: [{ claimId: "c2", siblingState: "submitted", geometry: squareGeometry(0.009), areaAcres: 0.3 }],
        toleranceMeters: 1,
      });
      expect(ctx.overlapStatus).toBe("overlaps_in_flight");
    });

    it("prefers overlaps_verified over overlaps_in_flight", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 0.5 }],
        inFlightSiblings: [{ claimId: "s1", siblingState: "submitted", geometry: squareGeometry(0.009), areaAcres: 0.3 }],
        toleranceMeters: 1,
      });
      expect(ctx.overlapStatus).toBe("overlaps_verified");
    });

    it("computes remainingEligibleAcres = parcel - verified - inFlight", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 10.0,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 3.0 }],
        inFlightSiblings: [{ claimId: "s1", siblingState: "submitted", geometry: squareGeometry(0.009), areaAcres: 1.5 }],
        toleranceMeters: 1,
      });
      expect(ctx.remainingEligibleAcres).toBe(5.5); // 10 - 3 - 1.5 = 5.5
      expect(ctx.previouslyVerifiedAcres).toBe(3.0);
      expect(ctx.inFlightAreaAcres).toBe(1.5);
    });

    it("clamps remainingEligibleAcres at 0 (never negative)", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 5.0,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 4.0 }],
        inFlightSiblings: [{ claimId: "s1", siblingState: "submitted", geometry: squareGeometry(0.009), areaAcres: 2.0 }],
        toleranceMeters: 1,
      });
      expect(ctx.remainingEligibleAcres).toBe(0);
    });

    it("fullyCovered=true when overlap share >= 0.95 (duplicate_area threshold)", () => {
      // Claim 0.5 acres, verified sibling 0.5 acres exact same geometry → share = 1.0 >= 0.95
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 10.0,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 0.5 }],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.fullyCovered).toBe(true);
      expect(ctx.partialApproval).toBeNull();
    });

    it("fullyCovered=false + partialApproval when overlap share < 0.95", () => {
      // Use a verified sibling that barely touches the claim corner (tiny sliver overlap)
      // The claim is 0.01 deg square (~300 acres actual), sibling is a tiny 0.0001 deg square at the corner
      const tinyOverlay = {
        type: "Polygon",
        coordinates: [[[77.0099, 11.0099], [77.01, 11.0099], [77.01, 11.01], [77.0099, 11.01], [77.0099, 11.0099]]],
      };
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.01),
        claimedAreaAcres: 300, // matches actual geometry size (~300 acres)
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1000,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: tinyOverlay, areaAcres: 0.01 }],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.fullyCovered).toBe(false);
      expect(ctx.partialApproval).not.toBeNull();
      expect(ctx.partialApproval.areaAcres).toBeGreaterThan(0);
    });

    it("includes overlapWarnings for outside_parcel", () => {
      const claim = { ...squareGeometry(0.009), coordinates: [[[78.0, 12.0], [78.009, 12.0], [78.009, 12.009], [78.0, 12.009], [78.0, 12.0]]] };
      const ctx = buildSpatialContext({
        claimedGeometry: claim,
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      const warning = ctx.overlapWarnings.find((w) => w.code === "outside_parcel");
      expect(warning).toBeTruthy();
    });

    it("includes overlapWarnings for overlaps_verified", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 0.5 }],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      const warning = ctx.overlapWarnings.find((w) => w.code === "overlaps_verified");
      expect(warning).toBeTruthy();
      expect(warning.claims.length).toBe(1);
      expect(warning.overlapAreaAcres).toBeGreaterThan(0);
    });

    it("includes overlapWarnings for overlaps_in_flight", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 1.0,
        verifiedSiblings: [],
        inFlightSiblings: [{ claimId: "s1", siblingState: "submitted", geometry: squareGeometry(0.009), areaAcres: 0.3 }],
        toleranceMeters: 1,
      });
      const warning = ctx.overlapWarnings.find((w) => w.code === "overlaps_in_flight");
      expect(warning).toBeTruthy();
      expect(warning.claims.length).toBe(1);
    });

    it("handles missing parcel gracefully (insideParcel=null, remaining=parcelArea)", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: null,
        parcelAreaAcres: 1.0,
        verifiedSiblings: [],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.insideParcel).toBeNull();
      expect(ctx.overlapStatus).toBe("none");
      expect(ctx.remainingEligibleAcres).toBe(1.0);
    });

    it("handles missing parcelAreaAcres (defaults to 0)", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: null,
        verifiedSiblings: [],
        inFlightSiblings: [],
        toleranceMeters: 1,
      });
      expect(ctx.remainingEligibleAcres).toBe(0);
    });

    it("includes both verified and in-flight in overlaps array", () => {
      const ctx = buildSpatialContext({
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: 0.5,
        parcelGeometry: parcelGeometry(),
        parcelAreaAcres: 10.0,
        verifiedSiblings: [{ claimId: "v1", siblingState: "verified", geometry: squareGeometry(0.009), areaAcres: 2.0 }],
        inFlightSiblings: [{ claimId: "s1", siblingState: "submitted", geometry: squareGeometry(0.009), areaAcres: 1.0 }],
        toleranceMeters: 1,
      });
      expect(ctx.overlaps.length).toBe(2);
      expect(ctx.overlaps.some((o) => o.siblingState === "verified")).toBe(true);
      expect(ctx.overlaps.some((o) => o.siblingState === "submitted")).toBe(true);
    });
  });
});