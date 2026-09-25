import { describe, it, expect } from "vitest";
import {
  evaluateClaimVerification,
  VERIFICATION_ENGINE_VERSION,
} from "../services/claimVerificationEngine.service.js";

// Test geometries
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

const baseClaim = (overrides = {}) => ({
  claimedAreaAcres: 0.5,
  parcelSnapshot: { parcelAreaAcres: 1.0, parcelId: "par_test", name: "Test", crop: "Rice" },
  eventType: "flood",
  eventDate: new Date(Date.now() - 86400000).toISOString(),
  claimedGeometry: squareGeometry(),
  cognitoSub: "user-123",
  _id: "claim-1",
  ...overrides,
});

const baseAssessment = (overrides = {}) => ({
  status: "completed",
  aiAggregate: {
    damageDetected: true,
    damageType: "flood",
    severity: "moderate",
    confidence: "high",
    uncertain: false,
    inconsistencies: [],
    imageCount: 1,
  },
  aiImageAssessments: [
    {
      observation: {
        damageDetected: true,
        damageType: "flood",
        severity: "moderate",
        confidence: "high",
        imageQuality: "good",
      },
    },
  ],
  evidenceVersion: "ev-1",
  ...overrides,
});

describe("E9-S9 Phase 9 — enriched verification engine (spatial + eligibleContext)", () => {
  describe("engine version", () => {
    it("VERIFICATION_ENGINE_VERSION is bumped to 2", () => {
      expect(VERIFICATION_ENGINE_VERSION).toBe("2");
    });
  });

  describe("spatialCheck rule (E9-S9: inside parcel)", () => {
    it("spatialEvaluated=true when spatial provided", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.spatialEvaluated).toBe(true);
      expect(result.rules.spatialCheck).toEqual({ passed: true, insideParcel: true });
    });

    it("spatialEvaluated=true when insideParcel=false", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: false, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.spatialEvaluated).toBe(true);
      expect(result.rules.spatialCheck).toEqual({ passed: false, insideParcel: false });
    });

    it("insideParcel=false -> rejected (precedence before overlap)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.2 },
        spatial: { insideParcel: false, overlapStatus: "overlaps_verified", overlapAreaAcres: 0.2 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toBe("Claimed area is outside the parcel boundary");
    });
  });

  describe("overlapCheck enriched (E9-S9: real verified/in-flight overlap)", () => {
    it("overlaps_verified + fullyCovered -> duplicate_area", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.5 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.5 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.5,
          fullyCovered: true,
          partialApproval: null,
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.5, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("duplicate_area");
      expect(result.reason).toBe("Claimed area duplicates an already verified claim");
      expect(result.rules.overlapCheck).toEqual({ passed: false, overlapArea: 0.5 });
    });

    it("overlaps_verified + partialApproval -> partially_verified (fits budget)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.3 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.3,
          fullyCovered: false,
          partialApproval: { geometry: { type: "Polygon", coordinates: [] }, areaAcres: 0.7 },
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.3, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("partially_verified");
      expect(result.reason).toContain("Partially verified:");
      expect(result.approvedAreaAcres).toBe(0.7);
      expect(result.verifiedAreaAcres).toBe(0.7);
    });

    it("overlaps_verified + partialApproval + exceeds budget -> out_of_limit", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.3 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.3,
          fullyCovered: false,
          partialApproval: { geometry: { type: "Polygon", coordinates: [] }, areaAcres: 0.7 },
        },
        eligibleContext: { remainingEligibleAcres: 0.5, previouslyVerifiedAcres: 0.3, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("out_of_limit");
      expect(result.reason).toContain("exceed this");
    });

    it("overlaps_in_flight -> more_evidence_required", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_in_flight", overlapAreaAcres: 0.1 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_in_flight",
          overlapAreaAcres: 0.1,
          fullyCovered: false,
          partialApproval: null,
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0.2 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.reason).toBe("Claim area overlaps a claim still in progress");
    });

    it("overlapCheck passed when no overlap", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
    });
  });

  describe("remainingCheck (E9-S9: claimed/new area must fit remaining budget)", () => {
    it("remainingCheck passed when new area <= remaining eligible", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.5 }),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.rules.remainingCheck).toEqual({ passed: true, remainingEligible: 1.0 });
    });

    it("remainingCheck failed when claimed area > remaining eligible", () => {
      // Use claimed area that passes areaCheck (< parcel*1.05) but exceeds remaining budget
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.8, parcelSnapshot: { parcelAreaAcres: 2.0, parcelId: "par_test", name: "Test", crop: "Rice" } }),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 0.5, previouslyVerifiedAcres: 1.0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.rules.remainingCheck).toEqual({ passed: false, remainingEligible: 0.5 });
      expect(result.outcome).toBe("out_of_limit");
      expect(result.reason).toContain("exceeds the remaining eligible acreage");
    });

    it("remainingCheck not enforced in legacy mode (no eligibleContext)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.5 }),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      // Legacy mode: remainingPassed = true always, remainingCheck.remainingEligible = inferred = parcel - claimed
      expect(result.rules.remainingCheck).toEqual({ passed: true, remainingEligible: -0.5 });
      // Area check should catch the overage (1.5 > 1.05)
      expect(result.outcome).toBe("out_of_limit");
    });

    it("remainingCheck not enforced for fullyCovered duplicate (adjudicated earlier)", () => {
      // Use claimed area that passes areaCheck (0.8 < 2.0*1.05=2.1) but is fully covered by verified sibling
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.8, parcelSnapshot: { parcelAreaAcres: 2.0, parcelId: "par_test", name: "Test", crop: "Rice" } }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.8 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.8,
          fullyCovered: true,
          partialApproval: null,
        },
        eligibleContext: { remainingEligibleAcres: 0, previouslyVerifiedAcres: 1.5, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      // duplicate_area takes precedence over remaining exceeded
      expect(result.outcome).toBe("duplicate_area");
    });
  });

  describe("precedence chain (E9-S9: outside parcel > duplicate > partial > in-flight > remaining > AI > success)", () => {
    it("outside parcel beats duplicate (spatialCheck before overlapCheck)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.5 },
        spatial: { insideParcel: false, overlapStatus: "overlaps_verified", overlapAreaAcres: 0.5, fullyCovered: true },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.5, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toBe("Claimed area is outside the parcel boundary");
    });

    it("duplicate beats partial (fullyCovered takes precedence)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.5 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.5 },
        spatial: { insideParcel: true, overlapStatus: "overlaps_verified", overlapAreaAcres: 0.5, fullyCovered: true },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.5, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("duplicate_area");
    });

    it("partial beats in-flight", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.3 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.3,
          fullyCovered: false,
          partialApproval: { geometry: { type: "Polygon", coordinates: [] }, areaAcres: 0.7 },
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.3, inFlightAreaAcres: 0.2 },
        evidenceCount: 1,
        now: Date.now(),
      });
      // overlaps_verified triggers before overlaps_in_flight
      expect(result.outcome).toBe("partially_verified");
    });

    it("in-flight beats remaining exceeded", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_in_flight", overlapAreaAcres: 0.1 },
        spatial: { insideParcel: true, overlapStatus: "overlaps_in_flight", overlapAreaAcres: 0.1, fullyCovered: false },
        eligibleContext: { remainingEligibleAcres: 0.5, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0.2 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("more_evidence_required");
    });

    it("remaining exceeded beats AI rejection", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.5 }),
        assessment: baseAssessment({ aiAggregate: { damageDetected: false, confidence: "high" } }),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      // remaining exceeded (out_of_limit) beats AI confident no-damage (rejected)
      expect(result.outcome).toBe("out_of_limit");
    });

    it("AI rejection beats success", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment({ aiAggregate: { damageDetected: false, confidence: "high" } }),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      // AI check decision depends on evaluateAiCheck implementation
      // For confident no-damage, it returns "rejected" or "more_evidence_required"
      expect(["rejected", "more_evidence_required"]).toContain(result.outcome);
    });
  });

  describe("legacy mode compatibility (no spatial/eligibleContext -> frozen E9-S5 behavior)", () => {
    it("legacy overlaps_verified -> duplicate_area (P5-E22)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.2 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("duplicate_area");
      expect(result.reason).toBe("Claim area overlaps an already verified claim");
      expect(result.rules.overlapCheck).toEqual({ passed: false, overlapArea: 0.2 });
    });

    it("legacy overlaps_in_flight -> more_evidence_required (P5-E23)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_in_flight", overlapAreaAcres: 0.1 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.reason).toBe("Claim area overlaps a claim still in progress");
    });

    it("legacy overlap unchecked -> passed with flag (P5-E20)", () => {
      // Use same inputs as P5-E01 which produces verified
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.5 }),
        assessment: baseAssessment(),
        overlap: { status: "unchecked", overlapAreaAcres: 0 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.overlapUnchecked).toBe(true);
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
      // Other rules pass -> verified
      expect(result.outcome).toBe("verified");
    });

    it("legacy mode never emits partially_verified (P5-E47)", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.3 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.outcome).not.toBe("partially_verified");
      // Legacy: overlaps_verified -> duplicate_area
      expect(result.outcome).toBe("duplicate_area");
    });

    it("legacy areaCheck uses inferred remainingEligible = parcel - claimed", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.5 }),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.rules.areaCheck.remainingEligible).toBe(0.5); // 1.0 - 0.5
    });

    it("engineVersion is 2 even in legacy mode", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.engineVersion).toBe("2");
    });
  });

  describe("enriched decision surface (E9-S9: verifiedAreaAcres, remainingEligible, overlapWarnings, etc.)", () => {
    it("returns verifiedAreaAcres = approvedAreaAcres for verified", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 0.5 }),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      // Both should be 0.5 for verified outcome
      expect(result.approvedAreaAcres).toBe(0.5);
      expect(result.verifiedAreaAcres).toBe(result.approvedAreaAcres);
    });

    it("returns verifiedAreaAcres = partialApproval.areaAcres for partially_verified", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.3 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.3,
          fullyCovered: false,
          partialApproval: { geometry: { type: "Polygon", coordinates: [] }, areaAcres: 0.7 },
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.3, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.verifiedAreaAcres).toBe(0.7);
      expect(result.approvedAreaAcres).toBe(0.7);
    });

    it("returns remainingEligible from eligibleContext", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 2.5, previouslyVerifiedAcres: 1.0, inFlightAreaAcres: 0.5 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.remainingEligible).toBe(2.5);
      expect(result.remainingEligibleAcres).toBe(2.5);
      expect(result.previouslyVerifiedAcres).toBe(1.0);
      expect(result.inFlightAreaAcres).toBe(0.5);
    });

    it("returns overlapWarnings from spatial", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.2 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.2,
          fullyCovered: false,
          overlapWarnings: [{ code: "overlaps_verified", message: "Partial overlap", claims: [] }],
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.2, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.overlapWarnings).toEqual([{ code: "overlaps_verified", message: "Partial overlap", claims: [] }]);
    });

    it("spatialEvaluated=true when spatial provided", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: { insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0 },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.spatialEvaluated).toBe(true);
    });

    it("spatialEvaluated=false when spatial not provided", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim(),
        assessment: baseAssessment(),
        overlap: { status: "none", overlapAreaAcres: 0 },
        spatial: null,
        eligibleContext: null,
        evidenceCount: 1,
        now: Date.now(),
      });
      expect(result.spatialEvaluated).toBe(false);
    });

    it("approvedGeometry is normalized from Turf Feature to plain geometry for partial", () => {
      const result = evaluateClaimVerification({
        claim: baseClaim({ claimedAreaAcres: 1.0 }),
        assessment: baseAssessment(),
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.3 },
        spatial: {
          insideParcel: true,
          overlapStatus: "overlaps_verified",
          overlapAreaAcres: 0.3,
          fullyCovered: false,
          partialApproval: { geometry: { type: "Feature", geometry: { type: "Polygon", coordinates: [[]] } }, areaAcres: 0.7 },
        },
        eligibleContext: { remainingEligibleAcres: 1.0, previouslyVerifiedAcres: 0.3, inFlightAreaAcres: 0 },
        evidenceCount: 1,
        now: Date.now(),
      });
      // approvedGeometry should be plain geometry, not Feature
      expect(result.approvedGeometry).toEqual({ type: "Polygon", coordinates: [[]] });
      expect(result.approvedGeometry.type).not.toBe("Feature");
    });
  });
});