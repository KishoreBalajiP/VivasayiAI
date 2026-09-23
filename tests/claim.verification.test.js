import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { putObject } from "../services/s3.service.js";
import claimAssessmentService from "../services/claimAssessment.service.js";
import { verifyClaim } from "../services/claimVerification.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// E9-S5 (ADR-019) — Phase 5: Claim Verification orchestration. Internal service (NO public
// endpoint), fully offline: the Phase 4 assessment is produced through the same mock seam, so no
// external AI/storage is ever called. Scenarios P5-01..P5-28 cover ownership/preconditions, the
// no-evidence decision, the assessment gate (retryable internal failures), the happy verified
// path, idempotency, in-flight safety, deterministic decisions, the resubmission loop, and the
// AI-must-not-decide guardrails.

const { mockAnalyze } = vi.hoisted(() => ({ mockAnalyze: vi.fn() }));

vi.mock("../services/claimVision.service.js", () => ({
  analyzeClaimImage: (...args) => mockAnalyze(...args),
}));

const sub = (name) => `test-verify-${name}`;
let testSeq = 0;
let keySeq = 0;
const nextUser = (prefix) => `p5-${prefix}-${(++testSeq).toString(36)}`;
const nextKey = () => `idem-p5-${++keySeq}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const TRANSPARENT_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const CLEAR = {
  cropDetected: "rice",
  damageDetected: true,
  damageType: "flood",
  severity: "moderate",
  visibleAffectedPortion: "lower portion of the visible field shows standing water",
  confidence: "high",
  uncertain: false,
  inconsistencies: [],
  observations: ["standing water in the furrows"],
  imageQuality: "good",
};

const UNSURE = {
  cropDetected: null,
  damageDetected: null,
  damageType: null,
  severity: null,
  visibleAffectedPortion: null,
  confidence: "unclear",
  uncertain: true,
  inconsistencies: ["Image could not be reliably analyzed"],
  observations: [],
  imageQuality: "unclear",
};

const LEAKY = {
  ...CLEAR,
  acreage: 0.02,
  polygon: { type: "Polygon", coordinates: [[[1, 2], [3, 4], [5, 6], [1, 2]]] },
  compensation: 50000,
  approved: true,
  finalStatus: "verified",
  approvedAreaAcres: 999,
};

const seedParcel = async (user, geometry = squareGeometry(0.009)) => {
  expect((await seedProfile(user)).status).toBe(200);
  const response = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Claim field", crop: "Paddy", geometry });
  expect(response.status).toBe(200);
  return response.body.data.parcel;
};

const claimBody = (parcelId, idempotencyKey, overrides = {}) => ({
  parcelId,
  eventType: "flood",
  eventDate: daysAgo(2),
  geometry: squareGeometry(0.009),
  idempotencyKey,
  ...overrides,
});

const createClaimOk = async (user, parcelId, idempotencyKey, overrides = {}) => {
  const response = await api()
    .post("/claims")
    .set(authHeader(user))
    .send(claimBody(parcelId, idempotencyKey, overrides));
  expect(response.status).toBe(200);
  return response.body.data.claim;
};

const submitClaim = async (user, claimId) => {
  const response = await api().post(`/claims/${claimId}/submit`).set(authHeader(user));
  expect(response.status).toBe(200);
  return response.body.data.claim;
};

const presignEvidence = (user, claimId, body) =>
  api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send(body);

const completeEvidence = (user, claimId, uploadId) =>
  api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));

const deleteEvidence = (user, claimId, uploadId) =>
  api().delete(`/claims/${claimId}/evidence/${uploadId}`).set(authHeader(user));

const presignPutComplete = async (user, claimId, contentType = "image/png") => {
  const presign = await presignEvidence(user, claimId, {
    contentType,
    size: TRANSPARENT_PNG_BUFFER.length,
    filename: "photo.png",
  });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const evidence = await ClaimEvidence.findOne({ uploadId });
  expect(evidence).toBeTruthy();
  await putObject({ key: evidence.s3Key, buffer: TRANSPARENT_PNG_BUFFER, mediaType: contentType });
  const completeResponse = await completeEvidence(user, claimId, uploadId);
  expect(completeResponse.status).toBe(200);
  return { claimId, uploadId };
};

const assess = (claimId, cognitoSub) => claimAssessmentService.assessClaimEvidence({ claimId, cognitoSub });

const verify = (claimId, cognitoSub, extra = {}) => verifyClaim({ claimId, cognitoSub, requestId: "test-req", ...extra });

const assessmentDoc = (claimId) => ClaimAssessment.findOne({ claimId }).lean();

const audits = (claimId) => ClaimAudit.find({ claimId }).sort({ createdAt: 1 }).lean();

const countAudit = (claimId, action) =>
  ClaimAudit.countDocuments({ claimId, action });

describe("agricultural loss claim — Phase 5 deterministic verification", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(mongo);
  });

  beforeEach(async () => {
    await clearTestDatabase();
    await LossClaim.deleteMany({});
    await ClaimEvidence.deleteMany({});
    await ClaimAssessment.deleteMany({});
    await ClaimAudit.deleteMany({});
    mockAnalyze.mockReset();
    mockAnalyze.mockResolvedValue({ ...CLEAR });
  });

  const seededSubmittedClaim = async (prefix, overrides = {}, geometry = squareGeometry(0.009)) => {
    const user = nextUser(prefix);
    const key = nextKey();
    const parcel = await seedParcel(user, geometry);
    const claim = await createClaimOk(user, parcel.parcelId, key, overrides);
    await submitClaim(user, claim.id);
    return { user, parcel, claim };
  };

  describe("A. ownership & preconditions", () => {
    it("P5-01: a foreign user cannot verify another user's claim (404, no change, no audit)", async () => {
      const { user, claim } = await seededSubmittedClaim("a1");
      const attacker = sub("a1x");
      const auditsBefore = await ClaimAudit.countDocuments({ claimId: claim.id });
      await expect(verify(claim.id, attacker)).rejects.toMatchObject({
        statusCode: 404,
        message: "Claim not found",
      });
      const claimDoc = await LossClaim.findById(claim.id).lean();
      expect(claimDoc.state).toBe("submitted");
      expect(await ClaimAudit.countDocuments({ claimId: claim.id })).toBe(auditsBefore);
    });

    it("P5-02: a draft claim cannot be verified (409 conflict, no transition)", async () => {
      const user = nextUser("a2");
      const key = nextKey();
      const parcel = await seedParcel(user);
      const claim = await createClaimOk(user, parcel.parcelId, key);
      await expect(verify(claim.id, user)).rejects.toMatchObject({ statusCode: 409 });
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("draft");
    });

    it("P5-03: a withdrawn claim is never verified (409 conflict)", async () => {
      const { user, claim } = await seededSubmittedClaim("a3");
      const withdraw = await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
      expect(withdraw.status).toBe(200);
      await expect(verify(claim.id, user)).rejects.toMatchObject({ statusCode: 409 });
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("withdrawn");
    });
  });

  describe("B. no stored evidence", () => {
    it("P5-04: submitted claim with no evidence -> more_evidence_required decision", async () => {
      const { user, claim } = await seededSubmittedClaim("b1");
      const result = await verify(claim.id, user);

      expect(result.idempotent).toBe(false);
      expect(result.inProgress).toBe(false);
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.rules.aiCheck).toEqual({ passed: false, reason: "No stored evidence to assess" });
      expect(result.rules.weatherCheck.passed).toBe(true);
      expect(result.approvedGeometry).toBeNull();
      expect(result.approvedAreaAcres).toBeNull();
      expect(result.claimState).toBe("more_evidence_required");

      const doc = await assessmentDoc(claim.id);
      expect(doc.state).toBe("more_evidence_required");
      expect(doc.decidedBy).toBe("engine");
      expect(doc.status).toBe("pending"); // no AI stage ever ran
      expect(doc.aiAggregate).toBeNull();
      expect(doc.verification.status).toBe("completed");

      const claimDoc = await LossClaim.findById(claim.id).lean();
      expect(claimDoc.state).toBe("more_evidence_required");
      expect(claimDoc.claimedAreaAcres).toBeGreaterThan(0);
      expect(claimDoc.decidedAt).toBeTruthy();

      expect(await countAudit(claim.id, "verification_started")).toBe(1);
      expect(await countAudit(claim.id, "more_evidence_required")).toBe(1);
    });
  });

  describe("C. assessment gate (evidence present but no usable assessment)", () => {
    it("P5-05: stored evidence with no assessment -> retryable internal failure, claim stays submitted", async () => {
      const { user, claim } = await seededSubmittedClaim("c1");
      await presignPutComplete(user, claim.id);

      await expect(verify(claim.id, user)).rejects.toMatchObject({
        statusCode: 500,
        message: /missing or stale/,
      });
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");
      expect(await ClaimAssessment.countDocuments({ claimId: claim.id })).toBe(0);
      const failed = await ClaimAudit.findOne({ claimId: claim.id, action: "verification_failed" }).lean();
      expect(failed).toBeTruthy();
      expect(failed.metadata.stage).toBe("assessment");
      expect(failed.fromState).toBeNull();
      expect(await countAudit(claim.id, "verified")).toBe(0);
    });

    it("P5-06: a failed assessment -> retryable internal failure, never converted to a rejection", async () => {
      const { user, claim } = await seededSubmittedClaim("c2");
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockRejectedValueOnce(new Error("provider boom"));
      await expect(assess(claim.id, user)).rejects.toMatchObject({ statusCode: 500 });
      expect((await assessmentDoc(claim.id)).status).toBe("failed");

      await expect(verify(claim.id, user)).rejects.toMatchObject({
        statusCode: 500,
        message: /missing or stale/,
      });
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");
      const failed = await ClaimAudit.findOne({ claimId: claim.id, action: "verification_failed" }).lean();
      expect(failed.metadata.stage).toBe("assessment");
      const doc = await assessmentDoc(claim.id);
      expect(doc.verification.status).toBe("failed");
      expect(doc.verification.error.stage).toBe("assessment");
      expect(doc.state).toBeNull(); // no decision was fabricated
    });

    it("P5-07: a stale assessment (new evidence) -> retryable internal failure", async () => {
      const { user, claim } = await seededSubmittedClaim("c3");
      await presignPutComplete(user, claim.id);
      const first = await assess(claim.id, user);
      expect(first.status).toBe("completed");
      await presignPutComplete(user, claim.id); // changes the evidence fingerprint without re-assessing

      await expect(verify(claim.id, user)).rejects.toMatchObject({ statusCode: 500 });
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");
      expect((await ClaimAudit.findOne({ claimId: claim.id, action: "verification_failed" }).lean()).metadata.stage)
        .toBe("assessment");
    });
  });
describe("D. happy path + idempotency + in-flight safety", () => {
    it("P5-08: submitted + completed assessment -> verified with geometry-derived approval", async () => {
      const { user, claim } = await seededSubmittedClaim("d1");
      await presignPutComplete(user, claim.id);
      const assessed = await assess(claim.id, user);
      expect(assessed.status).toBe("completed");

      const result = await verify(claim.id, user, { requestId: "req-d1" });
      expect(result.idempotent).toBe(false);
      expect(result.outcome).toBe("verified");
      expect(result.reason).toBe("All deterministic verification rules passed");
      expect(result.claimState).toBe("verified");
      expect(result.rules.areaCheck).toEqual({ passed: true, remainingEligible: expect.any(Number) });
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
      expect(result.rules.timelinessCheck).toEqual({ passed: true });
      expect(result.rules.eventTypeCheck).toEqual({ passed: true });
      expect(result.rules.weatherCheck.passed).toBe(true);
      expect(result.rules.aiCheck).toEqual({ passed: true, reason: expect.stringContaining("confirm crop damage") });
      expect(result.approvedAreaAcres).toBe(claim.claimedAreaAcres);
      expect(JSON.stringify(result.approvedGeometry)).toBe(JSON.stringify(claim.claimedGeometry));

      const claimDoc = await LossClaim.findById(claim.id).lean();
      expect(claimDoc.state).toBe("verified");
      expect(claimDoc.decidedAt).toBeTruthy();
      expect(claimDoc.processedAt).toBeTruthy();

      const doc = await assessmentDoc(claim.id);
      expect(doc.state).toBe("verified");
      expect(doc.decidedBy).toBe("engine");
      expect(doc.decidedAt).toBeTruthy();
      expect(doc.approvedAreaAcres).toBe(claim.claimedAreaAcres);
      expect(doc.weatherCorrelation).toBeNull();
      expect(doc.verification.status).toBe("completed");
      expect(doc.verification.version).toBe("1");

      expect(await countAudit(claim.id, "verification_started")).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
      // requestId correlation
      const start = await ClaimAudit.findOne({ claimId: claim.id, action: "verification_started" }).lean();
      expect(start.requestId).toBe("req-d1");
      const decision = await ClaimAudit.findOne({ claimId: claim.id, action: "verified" }).lean();
      expect(decision.requestId).toBe("req-d1");
      expect(decision.actor).toBe("engine");
      expect(decision.fromState).toBe("processing");
      expect(decision.toState).toBe("verified");
    });

    it("P5-09: re-verifying an already-decided claim reuses the decision (idempotent, no new audit, no re-analysis)", async () => {
      const { user, claim } = await seededSubmittedClaim("d2");
      await presignPutComplete(user, claim.id);
      await assess(claim.id, user);
      const first = await verify(claim.id, user);
      expect(first.outcome).toBe("verified");
      const analyzeCalls = mockAnalyze.mock.calls.length;

      const second = await verify(claim.id, user);
      expect(second.outcome).toBe("verified");
      expect(second.idempotent).toBe(true);
      expect(second.claimState).toBe("verified");
      expect(await countAudit(claim.id, "verified")).toBe(1);
      expect(await countAudit(claim.id, "verification_started")).toBe(1);
      expect(mockAnalyze.mock.calls.length).toBe(analyzeCalls);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("verified");
    });

    it("P5-10: an in-flight claim (processing, no decision yet) is never duplicated or audited", async () => {
      const { user, claim } = await seededSubmittedClaim("d3");
      await presignPutComplete(user, claim.id);
      await assess(claim.id, user);
      await LossClaim.updateOne({ _id: claim.id }, { $set: { state: "processing" } });
      const auditsBefore = await audits(claim.id);

      const result = await verify(claim.id, user);
      expect(result.inProgress).toBe(true);
      expect(result.outcome).toBeNull();
      expect(result.idempotent).toBe(false);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("processing");
      expect(JSON.stringify(await audits(claim.id))).toBe(JSON.stringify(auditsBefore));
      expect(await ClaimAssessment.countDocuments({ claimId: claim.id })).toBe(1);
    });
  });

  describe("E. deterministic decisions", () => {
    it("P5-11: confident no-damage AI observation -> rejected (AI evidence consulted, not deciding)", async () => {
      const { user, claim } = await seededSubmittedClaim("e1");
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({
        ...CLEAR,
        damageDetected: false,
        damageType: null,
        severity: null,
        observations: [],
      });
      await assess(claim.id, user);

      const result = await verify(claim.id, user);
      expect(result.outcome).toBe("rejected");
      expect(result.claimState).toBe("rejected");
      expect(result.reason).toBe("AI detected no crop damage in the submitted evidence");
      expect(result.approvedAreaAcres).toBeNull();
      expect(await countAudit(claim.id, "rejected")).toBe(1);
    });

    it("P5-12: uncertain AI observation -> more_evidence_required (resubmission path)", async () => {
      const { user, claim } = await seededSubmittedClaim("e2");
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({ ...UNSURE });
      await assess(claim.id, user);

      const result = await verify(claim.id, user);
      expect(result.outcome).toBe("more_evidence_required");
      expect(result.claimState).toBe("more_evidence_required");
      expect(result.reason).toBe("AI could not confirm crop damage from the submitted evidence");
      expect(result.approvedGeometry).toBeNull();
      expect(await countAudit(claim.id, "more_evidence_required")).toBe(1);
    });

    it("P5-13: claimed area beyond the parcel allowance -> out_of_limit (server-derived acreage only)", async () => {
      // Tiny parcel (0.009 deg square) + a much larger claim polygon => claimed > parcel*(1+5%).
      const { user, parcel } = await seededSubmittedClaim("e3", {}, squareGeometry(0.009));
      const bigger = await createClaimOk(user, parcel.parcelId, nextKey(), {
        geometry: squareGeometry(0.05),
      });
      await submitClaim(user, bigger.id);
      const allowed = parcel.calculatedAreaAcres * 1.05;
      expect(bigger.claimedAreaAcres).toBeGreaterThan(allowed);

      const result = await verify(bigger.id, user);
      expect(result.outcome).toBe("out_of_limit");
      expect(result.reason).toBe("Claimed area exceeds the parcel area allowance");
      expect(result.claimState).toBe("out_of_limit");
      expect((await LossClaim.findById(bigger.id).lean()).state).toBe("out_of_limit");
      expect(await countAudit(bigger.id, "out_of_limit")).toBe(1);
    });

    it("P5-14: more_evidence_required -> resubmit -> improved evidence -> verified (full loop)", async () => {
      const { user, claim } = await seededSubmittedClaim("e4");
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({ ...UNSURE });
      await assess(claim.id, user);
      const first = await verify(claim.id, user);
      expect(first.outcome).toBe("more_evidence_required");
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("more_evidence_required");

      // Farmer resubmits and replaces the unusable evidence with a clear image.
      const resubmit = await api().post(`/claims/${claim.id}/resubmit`).set(authHeader(user));
      expect(resubmit.status).toBe(200);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");

      const oldEvidenceDocs = await ClaimEvidence.find({ claimId: claim.id, status: "stored" }).lean();
      expect(oldEvidenceDocs.length).toBe(1);
      await deleteEvidence(user, claim.id, oldEvidenceDocs[0].uploadId);
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({ ...CLEAR });
      const assessed = await assess(claim.id, user);
      expect(assessed.status).toBe("completed");
      expect(assessed.aiAggregate.uncertain).toBe(false);

      const second = await verify(claim.id, user);
      expect(second.outcome).toBe("verified");
      expect(second.claimState).toBe("verified");
      expect(await countAudit(claim.id, "resubmitted")).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
    });
  });
describe("F. verification-gate retry (never a silent rejection)", () => {
    it("P5-15: a gate failure stays retryable — once the assessment completes, verification succeeds", async () => {
      const { user, claim } = await seededSubmittedClaim("f1");
      await presignPutComplete(user, claim.id);

      await expect(verify(claim.id, user)).rejects.toMatchObject({ statusCode: 500 });
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");

      await assess(claim.id, user); // assessment completes now
      const result = await verify(claim.id, user);
      expect(result.outcome).toBe("verified");
      expect(await countAudit(claim.id, "verification_failed")).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
    });
  });

  describe("G. AI-must-not-decide guardrails (P4)", () => {
    it("P5-16: leaky AI output (acreage/polygon/compensation/approved/status) never affects the decision", async () => {
      const { user, claim } = await seededSubmittedClaim("g1");
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({ ...LEAKY });
      await assess(claim.id, user);

      const result = await verify(claim.id, user);
      expect(result.outcome).toBe("verified");
      expect(result.approvedAreaAcres).toBe(claim.claimedAreaAcres); // geometry-derived, not AI
      expect(JSON.stringify(result.approvedGeometry)).toBe(JSON.stringify(claim.claimedGeometry));
      expect(result.rules.areaCheck.passed).toBe(true);

      const doc = await assessmentDoc(claim.id);
      const payload = JSON.stringify({
        aggregate: doc.aiAggregate,
        observations: (doc.aiImageAssessments || []).map((image) => image.observation),
        rules: doc.rules,
        reason: doc.reason,
      }).toLowerCase();
      expect(payload).not.toContain("acreage");
      expect(payload).not.toContain("compensation");
      expect(payload).not.toContain("approved");
      expect(payload).not.toContain("finalstatus");
    });

    it("P5-17: AI-reported tiny acreage cannot rescue an out-of-parcel claim", async () => {
      const { user, parcel } = await seededSubmittedClaim("g2", {}, squareGeometry(0.009));
      const bigger = await createClaimOk(user, parcel.parcelId, nextKey(), { geometry: squareGeometry(0.05) });
      await submitClaim(user, bigger.id);
      mockAnalyze.mockResolvedValue({ ...LEAKY, acreage: 0.01 }); // leaky small acreage
      await presignPutComplete(user, bigger.id);
      await assess(bigger.id, user);

      const result = await verify(bigger.id, user);
      expect(result.outcome).toBe("out_of_limit"); // geometry-derived area still governs
      expect(result.approvedAreaAcres).toBeNull();
    });

    it("P5-18: weather absence never blocks and overlap is recorded as unchecked (documented deferrals)", async () => {
      const { user, claim } = await seededSubmittedClaim("g3");
      await presignPutComplete(user, claim.id);
      await assess(claim.id, user);
      const result = await verify(claim.id, user);
      expect(result.outcome).toBe("verified");
      expect(result.rules.weatherCheck).toEqual({
        passed: true,
        reason: "Weather is supporting evidence only; its absence never blocks verification",
      });
      expect(result.weatherCorrelation).toBeNull();
      expect(result.rules.overlapCheck).toEqual({ passed: true, overlapArea: 0 });
      const decision = await ClaimAudit.findOne({ claimId: claim.id, action: "verified" }).lean();
      expect(decision.metadata.overlapEvaluated).toBe(false);
    });

    it("P5-19: partially_verified is NEVER emitted by this phase's rules", async () => {
      const segments = [];
      {
        const { user, claim } = await seededSubmittedClaim("g4");
        await presignPutComplete(user, claim.id);
        mockAnalyze.mockResolvedValue({ ...CLEAR });
        await assess(claim.id, user);
        segments.push(await verify(claim.id, user));
      }
      {
        const { user, claim } = await seededSubmittedClaim("g5");
        segments.push(await verify(claim.id, user)); // no evidence
      }
      {
        const { user, claim } = await seededSubmittedClaim("g6");
        await presignPutComplete(user, claim.id);
        mockAnalyze.mockResolvedValue({ ...UNSURE });
        await assess(claim.id, user);
        segments.push(await verify(claim.id, user));
      }
      {
        const { user, parcel } = await seededSubmittedClaim("g7", {}, squareGeometry(0.009));
        const bigger = await createClaimOk(user, parcel.parcelId, nextKey(), { geometry: squareGeometry(0.05) });
        await submitClaim(user, bigger.id);
        segments.push(await verify(bigger.id, user));
      }
      for (const result of segments) {
        expect(result.outcome).not.toBe("partially_verified");
      }
    });

    it("P5-20: additional caller-supplied fields are structurally ignored (only {claimId, cognitoSub, requestId} are read)", async () => {
      const { user, claim } = await seededSubmittedClaim("g8");
      await presignPutComplete(user, claim.id);
      await assess(claim.id, user);
      const result = await verify(claim.id, user, {
        state: "verified",
        outcome: "out_of_limit",
        approvedAreaAcres: 999,
        geometry: squareGeometry(0.5),
        attackerCognitoSub: "someone-else",
      });
      expect(result.outcome).toBe("verified"); // decided from persisted claim facts only
      expect(result.approvedAreaAcres).toBe(claim.claimedAreaAcres);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("verified");
    });

    it("P5-21: audit trail stays append-only and carries engine/decision metadata without storage internals", async () => {
      const { user, claim } = await seededSubmittedClaim("g9");
      await presignPutComplete(user, claim.id);
      await assess(claim.id, user);
      const pre = await ClaimAudit.countDocuments({ claimId: claim.id }); // created + submitted + evidence_completed = 3
      await verify(claim.id, user);
      const afterFirst = await ClaimAudit.countDocuments({ claimId: claim.id }); // + verification_started + verified = 5
      expect(afterFirst).toBe(pre + 2);
      const rows = await audits(claim.id);
      const decision = rows.find((row) => row.action === "verified");
      expect(decision).toBeTruthy();
      expect(decision.actor).toBe("engine");
      expect(decision.fromState).toBe("processing");
      expect(decision.toState).toBe("verified");
      expect(decision.metadata).toMatchObject({ overlapEvaluated: false, engineVersion: "1" });
      const serialized = JSON.stringify(rows.map((row) => row.metadata)).toLowerCase();
      expect(serialized).not.toMatch(/s3|bucket|cognito|url|buffer|summary/i);
      // append-only: re-verifying adds nothing
      await verify(claim.id, user);
      const afterSecond = await ClaimAudit.countDocuments({ claimId: claim.id });
      expect(afterSecond).toBe(afterFirst);
    });

    it("P5-22: an `other` event type is verified without any damage-type comparison", async () => {
      const { user, claim } = await seededSubmittedClaim("g10", { eventType: "other" });
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({ ...CLEAR, damageType: "drought" });
      await assess(claim.id, user);
      const result = await verify(claim.id, user);
      expect(result.outcome).toBe("verified");
      expect(result.rules.aiCheck.passed).toBe(true);
    });
  });

  describe("H. claim detail remains contract-stable (additive)", () => {
    it("P5-23: GET /claims/:id returns id/state/area and now the decided assessment additively", async () => {
      const { user, claim } = await seededSubmittedClaim("h1");
      await presignPutComplete(user, claim.id);
      await assess(claim.id, user);
      await verify(claim.id, user);

      const response = await api().get(`/claims/${claim.id}`).set(authHeader(user));
      expect(response.status).toBe(200);
      const body = response.body.data.claim;
      expect(body.id).toBe(claim.id);
      expect(body.state).toBe("verified");
      expect(body.claimedAreaAcres).toBeGreaterThan(0);
      expect(body.cognitoSub).toBeUndefined();
      expect(body.assessment).toBeTruthy();
      expect(body.assessment.state).toBe("verified");
      expect(body.assessment.rules.timelinessCheck.passed).toBe(true);
      expect(body.assessment.approvedAreaAcres).toBeGreaterThan(0);
      // public payload must not include s3 keys / private fields
      expect(JSON.stringify(body)).not.toMatch(/cognitoSub|s3Key/i);
    });
  });
}); // outer Phase 5 verification describe