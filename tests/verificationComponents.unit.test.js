import { describe, expect, it } from "vitest";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { groupEvidence, isReviewCase, resolveComponents } from "../services/verificationComponents.js";

// ADR-020 resolver. PURE unit tests: evidence in, per-component outcomes out.

const NOW = new Date("2026-09-21T00:00:00.000Z");
const GEOMETRY = { type: "Polygon", coordinates: [[[0, 0], [0.009, 0], [0.009, 0.009], [0, 0.009], [0, 0]]] };

const claim = (overrides = {}) => ({
  parcelId: "p1",
  eventType: "flood",
  eventDate: new Date(NOW.getTime() - 2 * 86400000),
  claimedGeometry: GEOMETRY,
  claimedAreaAcres: 0.5,
  parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 1 },
  ...overrides,
});

const goodAssessment = (aggregate = {}, verification = null) => ({
  status: "completed",
  verification,
  aiAggregate: {
    damageDetected: true,
    damageType: "flood",
    confidence: "high",
    uncertain: false,
    inconsistencies: [],
    imageCount: 1,
    ...aggregate,
  },
  aiImageAssessments: [{ observation: { cropDetected: "paddy", imageQuality: "good" } }],
});

let n = 0;
const row = (overrides) => ({
  _id: `row${++n}`,
  claimId: "c1",
  status: "PENDING",
  createdAt: new Date(NOW.getTime() - (1000 - n) * 1000),
  metadata: {},
  result: null,
  ...overrides,
});
const document = (status = "PENDING", result = null) =>
  row({ source: "OWNERSHIP", status, idempotencyKey: `owndoc_${n}`, result });

const spatial = (overrides = {}) => ({ insideParcel: true, overlapStatus: "none", fullyCovered: false, ...overrides });

const resolve = (extra = {}) =>
  resolveComponents({
    claim: claim(),
    assessment: goodAssessment(),
    spatial: spatial(),
    evidenceRows: [],
    evidenceCount: 1,
    policy: resolvePolicy("v2-components"),
    now: NOW,
    ...extra,
  });

describe("resolveComponents", () => {
  it("VC-1: every component is always present with a valid outcome", () => {
    const result = resolve();
    expect(Object.keys(result).sort()).toEqual(
      ["claimant_rights", "crop", "geometry", "land_documents", "manual_review", "overlap", "parcel_identity", "photos", "satellite", "weather"]
    );
    for (const value of Object.values(result)) {
      expect(["verified", "failed", "unverified", "unavailable", "inconclusive", "pending", "requires_review"]).toContain(value.outcome);
      expect(Array.isArray(value.reasonCodes)).toBe(true);
    }
  });

  it("VC-2: a registered parcel is verified but never marked verified against an official record", () => {
    const parcel = resolve().parcel_identity;
    expect(parcel.outcome).toBe("verified");
    expect(parcel.reasonCodes).toContain("not_verified_against_official_record");
    expect(parcel.authoritative).toBe(false);
  });

  it("VC-3: geometry is verified inside the parcel, failed outside, unverified when not evaluated — never authoritative", () => {
    expect(resolve().geometry.outcome).toBe("verified");
    expect(resolve().geometry.authoritative).toBe(false);
    expect(resolve({ spatial: spatial({ insideParcel: false }) }).geometry.outcome).toBe("failed");
    expect(resolve({ spatial: null }).geometry.outcome).toBe("unverified");
  });

  describe("claimant_rights", () => {
    it("VC-4: no ownership evidence is unverified and the FARMER can act", () => {
      const rights = resolve().claimant_rights;
      expect(rights.outcome).toBe("unverified");
      expect(rights.actionableBy).toBe("farmer");
    });

    it("VC-5: a document awaiting review is pending and a REVIEWER can act", () => {
      const rights = resolve({ evidenceRows: [document("PENDING")] }).claimant_rights;
      expect(rights.outcome).toBe("pending");
      expect(rights.actionableBy).toBe("reviewer");
    });

    it("VC-6: an admin-accepted document verifies rights but is not authoritative", () => {
      const rights = resolve({ evidenceRows: [document("AVAILABLE")] }).claimant_rights;
      expect(rights.outcome).toBe("verified");
      expect(rights.authoritative).toBe(false);
    });

    it("VC-7: only an authoritative VERIFIED review makes rights authoritative", () => {
      expect(resolve({ evidenceRows: [document("VERIFIED")] }).claimant_rights.authoritative).toBe(true);
    });

    it("VC-8: an inconsistent review fails the component; insufficient asks for a better document", () => {
      expect(resolve({ evidenceRows: [document("INCONSISTENT")] }).claimant_rights.outcome).toBe("failed");
      expect(resolve({ evidenceRows: [document("INSUFFICIENT")] }).claimant_rights.outcome).toBe("unverified");
    });

    it("VC-9: an AI document reading alone can never verify rights", () => {
      const examined = document("PENDING", { aiLandDocumentExamination: { reviewRequired: false, extracted: { surveyNumber: "1/1" } } });
      expect(resolve({ evidenceRows: [examined] }).claimant_rights.outcome).not.toBe("verified");
      expect(resolve({ evidenceRows: [examined] }).land_documents.outcome).toBe("inconclusive");
    });

    it("VC-10: an official record match that is not live-validated does not verify rights; unavailable stays unavailable", () => {
      const official = (status) =>
        row({ source: "OWNERSHIP", status: "AVAILABLE", idempotencyKey: "officialland_c1", result: { officialLandRecord: { status } } });
      expect(resolve({ evidenceRows: [official("matched")] }).claimant_rights.outcome).toBe("inconclusive");
      expect(resolve({ evidenceRows: [official("mismatch")] }).claimant_rights.outcome).toBe("requires_review");
      expect(resolve({ evidenceRows: [official("unavailable")] }).claimant_rights.outcome).toBe("unavailable");
    });

    it("VC-11: review-case rows are never mistaken for documents", () => {
      const reviewCase = row({ source: "OWNERSHIP", status: "PENDING", idempotencyKey: "rv_c1_OWNERSHIP_abc", metadata: { kind: "review_case", reviewRequired: true } });
      const result = resolve({ evidenceRows: [reviewCase] });
      expect(result.claimant_rights.outcome).toBe("unverified");
      expect(result.manual_review.outcome).toBe("requires_review");
    });
  });

  describe("photos", () => {
    it("VC-12: supportive AI observations verify but are flagged non-authoritative", () => {
      const photos = resolve().photos;
      expect(photos.outcome).toBe("verified");
      expect(photos.reasonCodes).toContain("ai_is_not_authoritative");
    });

    it("VC-13: no photographs is unverified (farmer), not failed", () => {
      const photos = resolve({ evidenceCount: 0, assessment: null }).photos;
      expect(photos.outcome).toBe("unverified");
      expect(photos.actionableBy).toBe("farmer");
    });

    it("VC-14: an assessment still running is pending; one that errored is unavailable — never failed", () => {
      expect(resolve({ assessment: { status: "processing", aiAggregate: null } }).photos.outcome).toBe("pending");
      expect(resolve({ assessment: { status: "failed", aiAggregate: null, verification: { status: "failed" } } }).photos.outcome).toBe("unavailable");
    });

    it("VC-15: a confident no-damage reading is `failed` under v1 but `requires_review` under v2", () => {
      const noDamage = goodAssessment({ damageDetected: false, damageType: null });
      expect(resolve({ assessment: noDamage, policy: resolvePolicy("v1-legacy") }).photos.outcome).toBe("failed");
      expect(resolve({ assessment: noDamage, policy: resolvePolicy("v2-components") }).photos.outcome).toBe("requires_review");
    });

    it("VC-16: doubt is inconclusive", () => {
      expect(resolve({ assessment: goodAssessment({ uncertain: true }) }).photos.outcome).toBe("inconclusive");
    });
  });

  describe("overlap", () => {
    it("VC-17: no overlap verifies; in-flight overlap is pending; a full duplicate fails", () => {
      expect(resolve().overlap.outcome).toBe("verified");
      expect(resolve({ spatial: spatial({ overlapStatus: "overlaps_in_flight" }) }).overlap.outcome).toBe("pending");
      expect(resolve({ spatial: spatial({ overlapStatus: "overlaps_verified", fullyCovered: true }) }).overlap.outcome).toBe("failed");
    });

    it("VC-18: overlap with ANOTHER farmer is a review signal, never a failure", () => {
      const overlap = resolve({ crossOverlap: { flagged: true } }).overlap;
      expect(overlap.outcome).toBe("requires_review");
      expect(overlap.reasonCodes).toContain("overlaps_other_farmers_claim");
    });
  });

  describe("supporting evidence (satellite, weather)", () => {
    const sat = (status, result = null) => row({ source: "SATELLITE", status, idempotencyKey: "sat2_c1_x", result });

    it("VC-19: satellite disabled or erroring is unavailable; cloud or coverage gaps are inconclusive; none run is unverified", () => {
      expect(resolve({ evidenceRows: [sat("NOT_CHECKED")] }).satellite.outcome).toBe("unavailable");
      expect(resolve({ evidenceRows: [sat("UNAVAILABLE")] }).satellite.outcome).toBe("unavailable");
      expect(resolve({ evidenceRows: [sat("INSUFFICIENT")] }).satellite.outcome).toBe("inconclusive");
      expect(resolve().satellite.outcome).toBe("unverified");
    });

    it("VC-20: only an interpreted change consistent with loss supports the claim, and it never proves cause", () => {
      const supported = resolve({ evidenceRows: [sat("AVAILABLE", { analysisOutcome: "SUPPORTS_LOSS" })] }).satellite;
      expect(supported.outcome).toBe("verified");
      expect(supported.reasonCodes).toContain("not_proof_of_cause");
      expect(resolve({ evidenceRows: [sat("AVAILABLE", { analysisOutcome: "NO_CHANGE" })] }).satellite.outcome).toBe("inconclusive");
    });

    it("VC-21: satellite and weather can never be `failed`", () => {
      for (const status of ["NOT_CHECKED", "PENDING", "INSUFFICIENT", "AVAILABLE", "INCONSISTENT", "UNAVAILABLE"]) {
        expect(resolve({ evidenceRows: [sat(status)] }).satellite.outcome).not.toBe("failed");
        expect(resolve({ evidenceRows: [row({ source: "WEATHER", status, idempotencyKey: "wx_c1" })] }).weather.outcome).not.toBe("failed");
      }
    });
  });

  describe("required flags and evidence history", () => {
    it("VC-22: `required` follows the policy; manual_review is required only while a case is open", () => {
      const v2 = resolve();
      expect(v2.claimant_rights.required).toBe(true);
      expect(v2.satellite.required).toBe(false);
      expect(v2.manual_review.required).toBe(false);
      const open = row({ source: "OWNERSHIP", status: "PENDING", idempotencyKey: "rv_c1_OWNERSHIP_abc", metadata: { kind: "review_case" } });
      expect(resolve({ evidenceRows: [open] }).manual_review.required).toBe(true);
      expect(Object.values(resolve({ policy: resolvePolicy("v1-legacy") })).every((entry) => entry.required === false)).toBe(true);
    });

    it("VC-23: the NEWEST row per group wins", () => {
      const older = row({ source: "SATELLITE", status: "UNAVAILABLE", idempotencyKey: "sat2_a", createdAt: new Date(NOW.getTime() - 5000) });
      const newer = row({ source: "SATELLITE", status: "INSUFFICIENT", idempotencyKey: "sat2_b", createdAt: new Date(NOW.getTime() - 1000) });
      expect(resolve({ evidenceRows: [older, newer] }).satellite.outcome).toBe("inconclusive");
      expect(resolve({ evidenceRows: [newer, older] }).satellite.outcome).toBe("inconclusive");
    });

    it("VC-24: evidence references snapshot id, status and version so a later change is detectable", () => {
      const doc = document("AVAILABLE");
      const refs = resolve({ evidenceRows: [doc] }).claimant_rights.evidenceRefs;
      expect(refs[0]).toMatchObject({ id: doc._id, status: "AVAILABLE" });
      expect(refs[0]).toHaveProperty("updatedAt");
      expect(refs[0]).toHaveProperty("evidenceVersion");
    });

    it("VC-25: deterministic — identical inputs give identical outputs", () => {
      const rows = [document("PENDING")];
      expect(JSON.stringify(resolve({ evidenceRows: rows }))).toBe(JSON.stringify(resolve({ evidenceRows: rows })));
    });
  });
});

describe("claimant relationship", () => {
  const doc = (status, category) => row({ source: "OWNERSHIP", status, idempotencyKey: `owndoc_${++n}`, metadata: { documentCategory: category } });
  const rights = (relationship, rows) => resolve({ claim: claim({ claimantRelationship: relationship }), evidenceRows: rows }).claimant_rights;

  it("CR-1: with no declared relationship the historical behaviour is unchanged", () => {
    expect(rights(null, [doc("AVAILABLE", "other")]).outcome).toBe("verified");
  });

  it("CR-2: an owner needs a land record or deed — an ID card alone does not satisfy it", () => {
    const missing = rights("owner", [doc("AVAILABLE", "identity_proof")]);
    expect(missing.outcome).toBe("unverified");
    expect(missing.actionableBy).toBe("farmer");
    expect(missing.reasonCodes).toContain("missing_document_category:land_record|ownership_deed");
    expect(rights("owner", [doc("AVAILABLE", "ownership_deed")]).outcome).toBe("verified");
  });

  it("CR-3: a tenant is asked for a lease, and the landowner's deed alone is not enough", () => {
    const result = rights("tenant", [doc("AVAILABLE", "ownership_deed")]);
    expect(result.outcome).toBe("unverified");
    expect(result.reasonCodes).toContain("missing_document_category:lease_agreement");
    expect(rights("tenant", [doc("AVAILABLE", "lease_agreement"), doc("AVAILABLE", "land_record")]).outcome).toBe("verified");
  });

  it("CR-4: an authorised cultivator needs an authorization letter", () => {
    expect(rights("authorised_cultivator", [doc("AVAILABLE", "land_record")]).reasonCodes).toContain("missing_document_category:authorization_letter");
    expect(rights("authorised_cultivator", [doc("AVAILABLE", "authorization_letter")]).outcome).toBe("verified");
  });

  it("CR-5: an heir needs both a land record and a second supporting document", () => {
    expect(rights("heir", [doc("AVAILABLE", "land_record")]).outcome).toBe("unverified");
    expect(rights("heir", [doc("AVAILABLE", "land_record"), doc("AVAILABLE", "identity_proof")]).outcome).toBe("verified");
  });

  it("CR-6: the right documents attached but still awaiting review is pending, not unverified", () => {
    expect(rights("owner", [doc("PENDING", "ownership_deed")]).outcome).toBe("pending");
  });

  it("CR-7: no documents at all names what is expected", () => {
    const result = rights("tenant", []);
    expect(result.outcome).toBe("unverified");
    expect(result.reasonCodes.filter((code) => code.startsWith("missing_document_category")).length).toBe(2);
  });
});

describe("review cases are never read as supporting evidence", () => {
  it("VC-26: a SATELLITE- or WEATHER-labelled review case is ignored by the satellite and weather components", () => {
    const reviewCase = (source) =>
      row({
        source,
        status: "PENDING",
        idempotencyKey: `rv_c1_${source}_0123456789abcdef`,
        metadata: { component: "manual_review", kind: "review_case", reviewRequired: true, failedStep: source.toLowerCase() },
        createdAt: new Date(NOW.getTime() - 1000),
      });
    const satCase = reviewCase("SATELLITE");
    const wxCase = reviewCase("WEATHER");

    const groups = groupEvidence([satCase, wxCase]);
    expect(groups.satelliteRows).toHaveLength(0);
    expect(groups.weatherRows).toHaveLength(0);
    expect(groups.reviewRows).toHaveLength(2);
    expect(isReviewCase(satCase)).toBe(true);

    const result = resolve({ evidenceRows: [satCase, wxCase] });
    expect(result.satellite.outcome).toBe("unverified");
    expect(result.satellite.reasonCodes).toEqual(["satellite_not_run"]);
    expect(result.weather.reasonCodes).toEqual(["weather_not_retrieved"]);
    expect(result.manual_review.outcome).toBe("requires_review");

    // A real (older) satellite reading next to a newer case still decides the satellite component.
    const reading = row({
      source: "SATELLITE",
      status: "AVAILABLE",
      idempotencyKey: "sat2_c1_real",
      result: { analysisOutcome: "SUPPORTS_LOSS" },
      createdAt: new Date(NOW.getTime() - 5000),
    });
    expect(resolve({ evidenceRows: [satCase, reading] }).satellite.outcome).toBe("verified");
  });
});
