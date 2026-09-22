import { describe, expect, it } from "vitest";
import {
  evaluateClaimVerification,
  OVERLAP_STATUSES,
  VERIFICATION_ENGINE_VERSION,
} from "../services/claimVerificationEngine.service.js";

// E9-S5 (ADR-019) — Phase 5: Deterministic Claim Verification Engine. PURE unit tests — no
// database, no network, no AI adapter. Same inputs => same output (`now` injected for
// determinism). Scenarios P5-E01..P5-E51 map to the documented rule set + strict precedence.

const NOW = new Date("2026-09-21T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PARCEL_AREA_ACRES = 1.0;
const CLAIMED_AREA_ACRES = 0.5;
const GEOMETRY = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [0.009, 0],
      [0.009, 0.009],
      [0, 0.009],
      [0, 0],
    ],
  ],
};

const baseClaim = (overrides = {}) => ({
  eventType: "flood",
  eventDate: new Date(NOW.getTime() - 2 * DAY),
  claimedGeometry: GEOMETRY,
  claimedAreaAcres: CLAIMED_AREA_ACRES,
  parcelSnapshot: {
    parcelId: "p1",
    name: "Claim field",
    crop: "Paddy",
    parcelAreaAcres: PARCEL_AREA_ACRES,
  },
  state: "submitted",
  ...overrides,
});

const goodImage = (overrides = {}) => ({
  evidenceId: null,
  uploadId: "img_1",
  observation: {
    cropDetected: "rice",
    damageDetected: true,
    damageType: "flood",
    severity: "moderate",
    visibleAffectedPortion: "lower portion of the visible field shows standing water",
    confidence: "high",
    uncertain: false,
    inconsistencies: [],
    observations: [],
    imageQuality: "good",
    ...overrides,
  },
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
  aiImageAssessments: [goodImage()],
  ...overrides,
});

const noOverlap = () => ({ status: "unchecked", overlapAreaAcres: 0 });

const noDamageAggregate = (overrides = {}) => ({
  damageDetected: false,
  damageType: null,
  severity: null,
  confidence: "high",
  uncertain: false,
  inconsistencies: [],
  imageCount: 1,
  ...overrides,
});

const evaluate = (claim = baseClaim(), assessment = baseAssessment(), extras = {}) =>
  evaluateClaimVerification({
    claim,
    assessment,
    overlap: noOverlap(),
    weatherCorrelation: null,
    evidenceCount: 1,
    now: NOW,
    ...extras,
  });

const clone = (value) => JSON.parse(JSON.stringify(value));

describe("Phase 5 — deterministic claim verification engine", () => {
  describe("V1. baseline & determinism", () => {
    it("P5-E01: all rules pass -> verified with geometry-derived approved values", () => {
      const result = evaluate();
      expect(result.outcome).toBe("verified");
      expect(result.reason).toBe("All deterministic verification rules passed");
      expect(result.approvedGeometry).toEqual(GEOMETRY);
      expect(result.approvedAreaAcres).toBe(CLAIMED_AREA_ACRES);
      expect(result.rules.timelinessCheck).toEqual({ passed: true });
      expect(result.rules.eventTypeCheck).toEqual({ passed: true });
      expect(result.rules.areaCheck).toEqual({ passed: true, remainingEligible: 0.5 });
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
      expect(result.rules.aiCheck.passed).toBe(true);
      expect(result.rules.weatherCheck.passed).toBe(true);
      expect(result.engineVersion).toBe(VERIFICATION_ENGINE_VERSION);
      // crop consistency is informational only (Paddy vs rice) — never blocks
      expect(result.reasons.some((r) => r.includes("informational"))).toBe(true);
    });

    it("P5-E02: deterministic — identical inputs produce identical outputs", () => {
      expect(JSON.stringify(evaluate())).toBe(JSON.stringify(evaluate()));
    });

    it("P5-E03: pure — inputs are never mutated", () => {
      const claim = baseClaim();
      const assessment = baseAssessment();
      const overlap = noOverlap();
      const snapshot = clone({ claim, assessment, overlap });
      evaluate(claim, assessment, { overlap });
      expect(clone({ claim, assessment, overlap })).toEqual(snapshot);
    });

    it("P5-E04: injected `now` is the only time source", () => {
      const claim = baseClaim({ eventDate: new Date(NOW.getTime() - 2 * DAY) });
      const late = new Date(NOW.getTime() + 45 * DAY);
      expect(evaluate(claim, baseAssessment(), { now: NOW }).outcome).toBe("verified");
      expect(evaluate(claim, baseAssessment(), { now: late }).outcome).toBe("rejected");
    });
  });

  describe("V2. timeliness rule (P2)", () => {
    it("P5-E05: event within the claim window passes", () => {
      expect(evaluate(baseClaim({ eventDate: new Date(NOW.getTime() - 5 * DAY) })).outcome).toBe("verified");
    });

    it("P5-E06: exactly at the window boundary passes (inclusive)", () => {
      const result = evaluate(baseClaim({ eventDate: new Date(NOW.getTime() - 30 * DAY) }));
      expect(result.outcome).toBe("verified");
      expect(result.rules.timelinessCheck.passed).toBe(true);
    });

    it("P5-E07: older than the claim window -> rejected", () => {
      const result = evaluate(baseClaim({ eventDate: new Date(NOW.getTime() - 30 * DAY - 1) }));
      expect(result.outcome).toBe("rejected");
      expect(result.rules.timelinessCheck.passed).toBe(false);
      expect(result.reason).toBe("Event date is outside the supported claim window");
    });

    it("P5-E08: future event date -> rejected", () => {
      const result = evaluate(baseClaim({ eventDate: new Date(NOW.getTime() + DAY) }));
      expect(result.outcome).toBe("rejected");
      expect(result.rules.timelinessCheck.passed).toBe(false);
    });

    it("P5-E09: invalid event date -> rejected", () => {
      const result = evaluate(baseClaim({ eventDate: "not-a-date" }));
      expect(result.outcome).toBe("rejected");
      expect(result.rules.timelinessCheck.passed).toBe(false);
    });
  });

  describe("V3. event type rule (frozen vocabulary)", () => {
    it.each(["flood", "storm", "drought", "pest", "disease", "fire", "other"])(
      "P5-E10/11: %s is in the frozen vocabulary -> eventTypeCheck passed",
      (eventType) => {
        const result = evaluate(baseClaim({ eventType }));
        expect(result.rules.eventTypeCheck.passed).toBe(true);
        // The evidence/damage-type rules may independently yield more_evidence_required;
        // the vocabulary rule must never reject a frozen event type.
        expect(result.outcome).not.toBe("rejected");
      }
    );

    it("P5-E12: unknown event type -> rejected", () => {
      const result = evaluate(baseClaim({ eventType: "tsunami" }));
      expect(result.rules.eventTypeCheck.passed).toBe(false);
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toBe("Claim event type is not in the supported vocabulary");
    });

    it("P5-E13: precedence — an out-of-window date wins over an unknown type", () => {
      const result = evaluate(baseClaim({ eventType: "tsunami", eventDate: new Date(NOW.getTime() - 60 * DAY) }));
      expect(result.rules.timelinessCheck.passed).toBe(false);
      expect(result.rules.eventTypeCheck.passed).toBe(false);
      expect(result.outcome).toBe("rejected");
      expect(result.reason).toBe("Event date is outside the supported claim window");
    });
  });

  describe("V4. area rule (P4/P5 — server-derived acreage only)", () => {
    it("P5-E14: claimed within parcel allowance passes, remainingEligible = parcel - claimed", () => {
      const result = evaluate();
      expect(result.rules.areaCheck.passed).toBe(true);
      expect(result.rules.areaCheck.remainingEligible).toBe(0.5);
      expect(result.outcome).toBe("verified");
    });

    it("P5-E15: exact boundary claimed == parcel*(1+overageFraction) passes (inclusive)", () => {
      const result = evaluate(baseClaim({ claimedAreaAcres: PARCEL_AREA_ACRES * 1.05 }));
      expect(result.rules.areaCheck.passed).toBe(true);
      expect(result.outcome).toBe("verified");
    });

    it("P5-E16: one fraction above the allowance -> out_of_limit, remainingEligible negative", () => {
      const result = evaluate(baseClaim({ claimedAreaAcres: PARCEL_AREA_ACRES * 1.05 + 0.001 }));
      expect(result.outcome).toBe("out_of_limit");
      expect(result.rules.areaCheck.passed).toBe(false);
      expect(result.rules.areaCheck.remainingEligible).toBeLessThan(0);
      expect(result.approvedGeometry).toBeNull();
      expect(result.approvedAreaAcres).toBeNull();
      expect(result.reason).toBe("Claimed area exceeds the parcel area allowance");
    });

    it("P5-E17: overage fraction comes from config (0.05), never hardcoded", () => {
      // 1% over the parcel is still within the 5% configured allowance...
      expect(evaluate(baseClaim({ claimedAreaAcres: PARCEL_AREA_ACRES * 1.01 })).rules.areaCheck.passed).toBe(true);
      // ...and a fraction above 5% is not.
      expect(evaluate(baseClaim({ claimedAreaAcres: PARCEL_AREA_ACRES * 1.050001 })).outcome).toBe("out_of_limit");
    });

    it("P5-E18: zero-known parcel area -> any claimed acreage is out_of_limit", () => {
      const result = evaluate(
        baseClaim({ claimedAreaAcres: 1, parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 0 } })
      );
      expect(result.outcome).toBe("out_of_limit");
    });

    it("P5-E19: remainingEligible is rounded to 4 decimals", () => {
      expect(evaluate(baseClaim({ claimedAreaAcres: 0.3333333333 })).rules.areaCheck.remainingEligible).toBe(0.6667);
    });
  });

  describe("V5. overlap rule (P5 — frozen semantics; orchestration passes unchecked)", () => {
    it("P5-E20: unchecked (E9-S3 absent) -> passed with zero overlap, flagged, decision unaffected", () => {
      const result = evaluate();
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
      expect(result.overlapUnchecked).toBe(true);
      expect(result.outcome).toBe("verified");
    });

    it("P5-E21: explicit none -> passed, not flagged unchecked", () => {
      const result = evaluate(baseClaim(), baseAssessment(), { overlap: { status: "none", overlapAreaAcres: 0 } });
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
      expect(result.overlapUnchecked).toBe(false);
    });

    it("P5-E22: overlaps_verified -> duplicate_area", () => {
      const result = evaluate(baseClaim(), baseAssessment(), {
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.2 },
      });
      expect(result.outcome).toBe("duplicate_area");
      expect(result.rules.overlapCheck).toEqual({ passed: false, overlapArea: 0.2 });
      expect(result.reason).toBe("Claim area overlaps an already verified claim");
    });

    it("P5-E23: overlaps_in_flight -> more_evidence_required", () => {
      const result = evaluate(baseClaim(), baseAssessment(), {
        overlap: { status: "overlaps_in_flight", overlapAreaAcres: 0.1 },
      });
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.reason).toBe("Claim area overlaps a claim still in progress");
    });

    it("P5-E24: OVERLAP_STATUSES exposes exactly the four frozen statuses", () => {
      expect(OVERLAP_STATUSES).toEqual(["unchecked", "none", "overlaps_verified", "overlaps_in_flight"]);
    });
  });
describe("V6. evidence / AI evidence-only rule (P4)", () => {
    it("P5-E25: no stored evidence -> more_evidence_required, no fabricated approval", () => {
      const result = evaluate(baseClaim(), null, { evidenceCount: 0 });
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.rules.aiCheck).toEqual({ passed: false, reason: "No stored evidence to assess" });
      expect(result.approvedGeometry).toBeNull();
      expect(result.approvedAreaAcres).toBeNull();
    });

    it("P5-E26: stored evidence but no assessment -> more_evidence_required (never guessed)", () => {
      const result = evaluate(baseClaim(), null, { evidenceCount: 3 });
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.rules.aiCheck.reason).toBe("AI assessment is not available for the submitted evidence");
    });

    it("P5-E27: completed assessment with no aggregate/imageCount -> more_evidence_required", () => {
      const result = evaluate(baseClaim(), baseAssessment({ aiAggregate: null, aiImageAssessments: [] }));
      expect(result.outcome).toBe("more_evidence_required");
    });

    it("P5-E28: confident no damage -> rejected", () => {
      const result = evaluate(baseClaim(), baseAssessment({ aiAggregate: noDamageAggregate() }));
      expect(result.outcome).toBe("rejected");
      expect(result.rules.aiCheck.reason).toBe("AI detected no crop damage in the submitted evidence");
    });

    it("P5-E29: no damage but uncertain -> more_evidence_required, never rejected", () => {
      const result = evaluate(baseClaim(), baseAssessment({ aiAggregate: noDamageAggregate({ uncertain: true }) }));
      expect(result.outcome).toBe("more_evidence_required");
    });

    it("P5-E30: unknown damage (null) -> more_evidence_required", () => {
      const result = evaluate(
        baseClaim(),
        baseAssessment({
          aiAggregate: {
            damageDetected: null,
            damageType: null,
            severity: null,
            confidence: "low",
            uncertain: true,
            inconsistencies: [],
            imageCount: 1,
          },
        })
      );
      expect(result.outcome).toBe("more_evidence_required");
    });

    it("P5-E31: damage confirmed but uncertain -> more_evidence_required", () => {
      const assessment = baseAssessment({ aiAggregate: { ...baseAssessment().aiAggregate, uncertain: true } });
      const result = evaluate(baseClaim(), assessment);
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.rules.aiCheck.reason).toBe("AI is uncertain about the submitted evidence");
    });

    it.each(["low", "unclear"])("P5-E32/33: confidence %s -> more_evidence_required", (confidence) => {
      const assessment = baseAssessment({ aiAggregate: { ...baseAssessment().aiAggregate, confidence } });
      expect(evaluate(baseClaim(), assessment).outcome).toBe("more_evidence_required");
    });

    it("P5-E34: cross-image inconsistencies -> more_evidence_required", () => {
      const assessment = baseAssessment({
        aiAggregate: {
          ...baseAssessment().aiAggregate,
          inconsistencies: ["Different damage types reported across evidence images"],
        },
      });
      expect(evaluate(baseClaim(), assessment).outcome).toBe("more_evidence_required");
    });

    it("P5-E35: all images poor/unclear quality -> more_evidence_required", () => {
      const assessment = baseAssessment({
        aiImageAssessments: [goodImage({ imageQuality: "poor" }), goodImage({ imageQuality: "unclear" })],
        aiAggregate: { ...baseAssessment().aiAggregate, imageCount: 2 },
      });
      const result = evaluate(baseClaim(), assessment);
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.rules.aiCheck.reason).toBe("Evidence image quality is too poor for verification");
    });

    it("P5-E36: at least one good/fair image passes the quality gate", () => {
      const assessment = baseAssessment({
        aiImageAssessments: [goodImage({ imageQuality: "poor" }), goodImage({ imageQuality: "good" })],
        aiAggregate: { ...baseAssessment().aiAggregate, imageCount: 2 },
      });
      expect(evaluate(baseClaim(), assessment).outcome).toBe("verified");
    });

    it("P5-E37: damage-type mismatch (both sides frozen vocabulary) -> more_evidence_required", () => {
      const assessment = baseAssessment({ aiAggregate: { ...baseAssessment().aiAggregate, damageType: "drought" } });
      const result = evaluate(baseClaim({ eventType: "flood" }), assessment);
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.rules.aiCheck.reason).toBe("Reported damage type does not match the claimed event type");
    });

    it("P5-E38: the farmer's `other` event disables the damage-type comparison", () => {
      const assessment = baseAssessment({ aiAggregate: { ...baseAssessment().aiAggregate, damageType: "drought" } });
      expect(evaluate(baseClaim({ eventType: "other" }), assessment).outcome).toBe("verified");
    });
  });

  describe("V7. crop consistency (informational only)", () => {
    it("P5-E39: crop note never blocks — verdict stays verified", () => {
      const result = evaluate();
      expect(result.reasons.some((r) => r.includes("informational"))).toBe(true);
      expect(result.outcome).toBe("verified");
      expect(result.rules.aiCheck.passed).toBe(true);
    });

    it("P5-E40: matching crops produce no informational note", () => {
      const claim = baseClaim({ parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 1.0 } });
      const assessment = baseAssessment({ aiImageAssessments: [goodImage({ cropDetected: "Paddy" })] });
      const result = evaluate(claim, assessment);
      expect(result.reasons.some((r) => r.includes("informational"))).toBe(false);
      expect(result.outcome).toBe("verified");
    });
  });

  describe("V8. weather rule (P3 — supporting only)", () => {
    it("P5-E41: no weather integration -> weather check passes, absence never blocks", () => {
      const result = evaluate();
      expect(result.rules.weatherCheck).toEqual({
        passed: true,
        reason: "Weather is supporting evidence only; its absence never blocks verification",
      });
      expect(result.outcome).toBe("verified");
    });

    it("P5-E42: a supplied (even mismatching) weatherCorrelation never gates", () => {
      const result = evaluate(baseClaim(), baseAssessment(), {
        weatherCorrelation: { eventMatch: false, precipitationMm: 0, weatherCode: 800, source: "open-meteo" },
      });
      expect(result.rules.weatherCheck.passed).toBe(true);
      expect(result.outcome).toBe("verified");
    });
  });

  describe("V9. strict outcome precedence", () => {
    it("P5-E43: out-of-window beats over-area (rejected, not out_of_limit)", () => {
      const result = evaluate(baseClaim({ eventDate: new Date(NOW.getTime() - 60 * DAY), claimedAreaAcres: 5 }));
      expect(result.outcome).toBe("rejected");
    });

    it("P5-E44: over-area beats overlaps_verified (out_of_limit, not duplicate_area)", () => {
      const result = evaluate(baseClaim({ claimedAreaAcres: 5 }), baseAssessment(), {
        overlap: { status: "overlaps_verified", overlapAreaAcres: 0.2 },
      });
      expect(result.outcome).toBe("out_of_limit");
    });

    it("P5-E45: over-area beats confident no-damage (out_of_limit, not rejected)", () => {
      const result = evaluate(
        baseClaim({ claimedAreaAcres: 5 }),
        baseAssessment({ aiAggregate: noDamageAggregate() })
      );
      expect(result.outcome).toBe("out_of_limit");
    });

    it("P5-E46: overlaps_in_flight + failed assessment both resolve to more_evidence_required", () => {
      const result = evaluate(baseClaim(), baseAssessment({ status: "failed" }), {
        overlap: { status: "overlaps_in_flight", overlapAreaAcres: 0.1 },
      });
      expect(result.outcome).toBe("more_evidence_required");
    });

    it("P5-E47: partially_verified is NEVER emitted by any input combination", () => {
      const inputs = [
        evaluate(baseClaim()),
        evaluate(baseClaim({ eventType: "tsunami" })),
        evaluate(baseClaim({ claimedAreaAcres: 5 })),
        evaluate(baseClaim({ eventDate: new Date(NOW.getTime() - 60 * DAY) })),
        evaluate(baseClaim(), null, { evidenceCount: 0 }),
        evaluate(baseClaim(), baseAssessment({ aiAggregate: noDamageAggregate() })),
        evaluate(baseClaim(), baseAssessment({ status: "failed" })),
        evaluate(baseClaim(), baseAssessment({ aiAggregate: null, aiImageAssessments: [] })),
        evaluate(baseClaim(), baseAssessment(), { overlap: { status: "overlaps_verified", overlapAreaAcres: 0.2 } }),
        evaluate(baseClaim(), baseAssessment(), { overlap: { status: "overlaps_in_flight", overlapAreaAcres: 0.1 } }),
      ];
      for (const result of inputs) {
        expect(result.outcome).not.toBe("partially_verified");
      }
    });
  });
describe("V10. AI-must-not-decide guardrails (P4)", () => {
    const LEAKY_AGGREGATE = {
      ...baseAssessment().aiAggregate,
      acreage: 0.02,
      polygon: { type: "Polygon", coordinates: [[[1, 2], [3, 4], [5, 6], [1, 2]]] },
      compensation: 50000,
      approved: true,
      finalStatus: "verified",
      approvedAreaAcres: 999,
    };

    it("P5-E48: AI acreage/polygon/compensation/approval output is ignored — approved values stay geometry-derived", () => {
      const assessment = baseAssessment({ aiAggregate: LEAKY_AGGREGATE });
      const result = evaluate(baseClaim(), assessment);
      expect(result.outcome).toBe("verified");
      expect(result.approvedAreaAcres).toBe(CLAIMED_AREA_ACRES);
      expect(result.approvedGeometry).toEqual(GEOMETRY);
      expect(result.rules.areaCheck.passed).toBe(true);
      const serialized = JSON.stringify(result).toLowerCase();
      expect(serialized).not.toContain("acreage");
      expect(serialized).not.toContain("compensation");
    });

    it("P5-E49: AI-derived acreage never rescues an out-of-parcel claim", () => {
      const assessment = baseAssessment({
        aiAggregate: { ...LEAKY_AGGREGATE, acreage: 0.01, polygon: null },
      });
      const result = evaluate(baseClaim({ claimedAreaAcres: 5 }), assessment);
      expect(result.outcome).toBe("out_of_limit"); // geometry-derived area still governs
      expect(result.approvedAreaAcres).toBeNull();
    });

    it("P5-E50: engine never reads claim.state — outcomes are state-independent", () => {
      for (const state of ["draft", "submitted", "processing", "verified", "withdrawn"]) {
        const result = evaluate(baseClaim({ state }));
        expect(result.outcome).toBe("verified");
        expect(result.approvedAreaAcres).toBe(CLAIMED_AREA_ACRES);
      }
    });

    it("P5-E51: extra client-ish claim keys are structurally ignored (only frozen facts read)", () => {
      const claim = baseClaim({
        claimedGeometry: GEOMETRY,
        validatedAreaOverride: 999,
        approvedValue: true,
        evidenceUploaded: true,
      });
      const result = evaluate(claim, baseAssessment());
      expect(result.outcome).toBe("verified");
      expect(result.approvedAreaAcres).toBe(CLAIMED_AREA_ACRES);
    });
  });
}); // outer verify-engine describe