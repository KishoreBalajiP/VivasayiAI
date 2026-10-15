import { describe, expect, it } from "vitest";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { evaluateClaimVerification, applyComponentGate } from "../services/claimVerificationEngine.service.js";
import { resolveComponents } from "../services/verificationComponents.js";

// ADR-020 gate. The frozen rules stay authoritative; the gate can only make an approval more
// cautious and can never produce a rejection.

const NOW = new Date("2026-09-21T00:00:00.000Z");
const GEOMETRY = { type: "Polygon", coordinates: [[[0, 0], [0.009, 0], [0.009, 0.009], [0, 0.009], [0, 0]]] };
const V1 = resolvePolicy("v1-legacy");
const V2 = resolvePolicy("v2-components");

const claim = (overrides = {}) => ({
  parcelId: "p1",
  eventType: "flood",
  eventDate: new Date(NOW.getTime() - 2 * 86400000),
  claimedGeometry: GEOMETRY,
  claimedAreaAcres: 0.5,
  parcelSnapshot: { parcelId: "p1", crop: "Paddy", parcelAreaAcres: 1 },
  ...overrides,
});
const assessment = (aggregate = {}) => ({
  status: "completed",
  aiAggregate: { damageDetected: true, damageType: "flood", confidence: "high", uncertain: false, inconsistencies: [], imageCount: 1, ...aggregate },
  aiImageAssessments: [{ observation: { cropDetected: "paddy", imageQuality: "good" } }],
});
const spatial = (overrides = {}) => ({ insideParcel: true, overlapStatus: "none", overlapAreaAcres: 0, fullyCovered: false, partialApproval: null, ...overrides });
const eligible = { remainingEligibleAcres: 1, previouslyVerifiedAcres: 0, inFlightAreaAcres: 0 };
const ownershipDoc = (status) => ({ _id: `d-${status}`, source: "OWNERSHIP", status, idempotencyKey: "owndoc_1", createdAt: NOW, metadata: {}, result: null });

const evaluate = ({ policy, rows = [], assessmentValue = assessment(), claimValue = claim(), spatialValue = spatial(), crossOverlap = null } = {}) => {
  const components = policy
    ? resolveComponents({ claim: claimValue, assessment: assessmentValue, spatial: spatialValue, crossOverlap, evidenceRows: rows, evidenceCount: 1, policy })
    : null;
  return evaluateClaimVerification({
    claim: claimValue,
    assessment: assessmentValue,
    overlap: { status: "unchecked", overlapAreaAcres: 0 },
    spatial: spatialValue,
    eligibleContext: eligible,
    weatherCorrelation: null,
    evidenceCount: 1,
    now: NOW,
    components,
    policy,
  });
};

describe("component gate", () => {
  it("CG-1: without a policy the engine behaves exactly as before and reports the legacy shape", () => {
    const result = evaluate();
    expect(result.outcome).toBe("verified");
    expect(result.disposition).toBe("decide");
    expect(result.gate).toBeNull();
    expect(result.components).toBeNull();
    expect(result.policy).toBeNull();
  });

  it("CG-2: v1-legacy records component outcomes but cannot change the decision", () => {
    const result = evaluate({ policy: V1 });
    expect(result.outcome).toBe("verified");
    expect(result.disposition).toBe("decide");
    expect(result.gate.applied).toBe(false);
    expect(result.policy).toEqual({ id: "v1-legacy", hash: V1.hash });
    expect(result.components.claimant_rights).toBe("unverified");
  });

  it("CG-3: v2 with no ownership evidence turns an approval into a request for more evidence", () => {
    const result = evaluate({ policy: V2 });
    expect(result.outcome).toBe("more_evidence_required");
    expect(result.disposition).toBe("decide");
    expect(result.gate.blocking.map((item) => item.component)).toEqual(["claimant_rights"]);
    expect(result.approvedGeometry).toBeNull();
    expect(result.approvedAreaAcres).toBeNull();
  });

  it("CG-4: v2 with a document awaiting review HOLDS the claim — no outcome, no approved area", () => {
    const result = evaluate({ policy: V2, rows: [ownershipDoc("PENDING")] });
    expect(result.disposition).toBe("hold");
    expect(result.outcome).toBeNull();
    expect(result.approvedAreaAcres).toBeNull();
    expect(result.gate.blocking[0]).toMatchObject({ component: "claimant_rights", outcome: "pending", action: "hold" });
  });

  it("CG-5: v2 verifies once the required components are satisfied, with the original approved values", () => {
    const result = evaluate({ policy: V2, rows: [ownershipDoc("AVAILABLE")] });
    expect(result.outcome).toBe("verified");
    expect(result.disposition).toBe("decide");
    expect(result.approvedAreaAcres).toBe(0.5);
    expect(result.gate.blocking).toEqual([]);
  });

  it("CG-6: a failed required component asks for more evidence and is never a rejection", () => {
    const result = evaluate({ policy: V2, rows: [ownershipDoc("INCONSISTENT")] });
    expect(result.outcome).toBe("more_evidence_required");
    expect(result.outcome).not.toBe("rejected");
  });

  it("CG-7: the frozen hard rules run first — the gate never overrides a rejection or out_of_limit", () => {
    const outside = evaluate({ policy: V2, spatialValue: spatial({ insideParcel: false }) });
    expect(outside.outcome).toBe("rejected");
    expect(outside.gate.blocking).toEqual([]);
    const tooBig = evaluate({ policy: V2, claimValue: claim({ claimedAreaAcres: 5 }) });
    expect(tooBig.outcome).toBe("out_of_limit");
  });

  it("CG-8: the gate also applies to partially_verified", () => {
    const partial = spatial({
      overlapStatus: "overlaps_verified",
      overlapAreaAcres: 0.2,
      partialApproval: { geometry: GEOMETRY, areaAcres: 0.3 },
    });
    const without = evaluate({ policy: V2, spatialValue: partial });
    expect(["more_evidence_required"]).toContain(without.outcome);
    const withDoc = evaluate({ policy: V2, spatialValue: partial, rows: [ownershipDoc("AVAILABLE")] });
    expect(withDoc.outcome).toBe("partially_verified");
  });

  it("CG-9: a confident AI no-damage reading rejects under v1 but holds for a reviewer under v2", () => {
    const noDamage = assessment({ damageDetected: false, damageType: null });
    expect(evaluate({ policy: V1, assessmentValue: noDamage }).outcome).toBe("rejected");
    expect(evaluate({ assessmentValue: noDamage }).outcome).toBe("rejected");
    const v2 = evaluate({ policy: V2, assessmentValue: noDamage, rows: [ownershipDoc("AVAILABLE")] });
    expect(v2.disposition).toBe("hold");
    expect(v2.outcome).toBeNull();
    expect(v2.gate.blocking[0].reasonCode).toBe("ai_no_damage_needs_review");
  });

  it("CG-10: overlap with another farmer holds the claim for review and never labels it a duplicate", () => {
    const result = evaluate({ policy: V2, rows: [ownershipDoc("AVAILABLE")], crossOverlap: { flagged: true } });
    expect(result.disposition).toBe("hold");
    expect(result.outcome).not.toBe("duplicate_area");
    expect(result.gate.blocking[0].component).toBe("overlap");
  });

  it("CG-11: optional components (satellite, weather) never block an approval", () => {
    const result = evaluate({ policy: V2, rows: [ownershipDoc("AVAILABLE")] });
    expect(result.components.satellite).toBe("unverified");
    expect(result.components.weather).toBe("unverified");
    expect(result.outcome).toBe("verified");
  });

  it("CG-12: a farmer-actionable gap wins over a reviewer hold", () => {
    const result = applyComponentGate({
      candidate: { outcome: "verified", reason: "ok" },
      components: {
        claimant_rights: { outcome: "unverified", required: true, reasonCodes: [] },
        overlap: { outcome: "requires_review", required: true, reasonCodes: [] },
      },
      policy: V2,
    });
    expect(result.outcome).toBe("more_evidence_required");
  });

  it("CG-13: deterministic — identical inputs give identical outputs", () => {
    const args = { policy: V2, rows: [ownershipDoc("PENDING")] };
    expect(JSON.stringify(evaluate(args))).toBe(JSON.stringify(evaluate(args)));
  });

  it("CG-14: the policy's rule values drive the engine (a stricter window rejects an older event)", () => {
    const strict = { ...V1, rules: { ...V1.rules, claimWindowDays: 1 } };
    const result = evaluateClaimVerification({
      claim: claim(),
      assessment: assessment(),
      overlap: { status: "unchecked", overlapAreaAcres: 0 },
      spatial: spatial(),
      eligibleContext: eligible,
      evidenceCount: 1,
      now: NOW,
      components: resolveComponents({ claim: claim(), assessment: assessment(), spatial: spatial(), evidenceRows: [], evidenceCount: 1, policy: strict }),
      policy: strict,
    });
    expect(result.outcome).toBe("rejected");
  });
});
