import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { putObject } from "../services/s3.service.js";
import claimAssessmentService from "../services/claimAssessment.service.js";
import { computeEvidenceVersion } from "../services/claimAssessment.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// E9-S5/E9-S6 (ADR-019, Phase 6 integration) — POST /claims/:claimId/verify.
//
// Phase 5 shipped the deterministic verification orchestration as an INTERNAL service. Phase 6
// exposes that frozen decision engine through the public HTTPS surface with a THIN endpoint: the
// client only requests verification; the server loads the authoritative claim/evidence/assessment,
// runs the pure deterministic rules, persists the decision, and advances the state via the frozen
// machine. Scenarios P6-01..P6-40 (08_API_Documentation §10.8) cover — in order — authorization
// (1-4), request validation INCLUDING the client-tampering guardrail tests (5-10), lifecycle
// (11-18), idempotency (19-22), concurrency/CAS (23-25), persistence (26-32), audit (33-35), and
// security (36-40). Every Phase 1-5 test in the suite stays untouched and green.

const { mockAnalyze } = vi.hoisted(() => ({ mockAnalyze: vi.fn() }));

vi.mock("../services/claimVision.service.js", () => ({
  analyzeClaimImage: (...args) => mockAnalyze(...args),
}));

const sub = (name) => `test-verifyapi-${name}`;
let testSeq = 0;
let keySeq = 0;
const nextUser = (prefix) => `p6-${prefix}-${(++testSeq).toString(36)}`;
const nextKey = () => `idem-p6-${++keySeq}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const TRANSPARENT_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// Frozen AI-contract fixtures (ClaimLossVisionTemplates.js vocabulary). LEAKY carries the P4
// forbidden AI-payload fields (acreage/polygon/compensation/approved/status) to prove the engine
// exposes only server-derived facts.
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

const NO_DAMAGE = {
  ...CLEAR,
  damageDetected: false,
  damageType: null,
  severity: null,
  observations: [],
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

const withdrawClaim = async (user, claimId) => {
  const response = await api().post(`/claims/${claimId}/withdraw`).set(authHeader(user));
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

const verify = (user, claimId, body = {}, agent = api()) =>
  agent.post(`/claims/${claimId}/verify`).set(authHeader(user)).send(body);

const storedEvidence = (claimId) =>
  ClaimEvidence.find({ claimId, status: { $in: ["stored"] } }).sort({ uploadedAt: 1 }).lean();

const assessmentDoc = (claimId) => ClaimAssessment.findOne({ claimId }).lean();

const audits = (claimId) => ClaimAudit.find({ claimId }).sort({ createdAt: 1 }).lean();

const countAudit = (claimId, action) => ClaimAudit.countDocuments({ claimId, action });

const seedSubmitted = async (prefix, overrides = {}, geometry = squareGeometry(0.009)) => {
  const user = nextUser(prefix);
  const key = nextKey();
  const parcel = await seedParcel(user, geometry);
  const claim = await createClaimOk(user, parcel.parcelId, key, overrides);
  await submitClaim(user, claim.id);
  return { user, parcel, claim };
};

const seedSubmittedVerified = async (prefix, analysis = CLEAR) => {
  const seeded = await seedSubmitted(prefix);
  const { user, claim } = seeded;
  await presignPutComplete(user, claim.id);
  mockAnalyze.mockResolvedValue({ ...analysis });
  await assess(claim.id, user);
  return seeded;
};

describe("agricultural loss claim — Phase 6 verification API (POST /claims/:claimId/verify)", () => {
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

  // 1. AUTHORIZATION (P6-01..P6-04)
  describe("1. authorization", () => {
    it("P6-01: an unauthenticated POST /claims/:claimId/verify is rejected (401)", async () => {
      const { claim } = await seedSubmitted("a1");
      const response = await api().post(`/claims/${claim.id}/verify`); // no token
      expect(response.status).toBe(401);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");
    });

    it("P6-02: an authenticated owner can request verification for their own claim (200)", async () => {
      const { user, claim } = await seedSubmitted("a2"); // no evidence -> frozen more_evidence_required
      const response = await verify(user, claim.id);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.claimId).toBe(claim.id);
      expect(verification.outcome).toBe("more_evidence_required");
      expect(verification.claimState).toBe("more_evidence_required");
      expect(verification.decidedBy).toBe("engine");
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("more_evidence_required");
    });

    it("P6-03: a foreign user cannot verify another user's claim (404, no change, no audit)", async () => {
      const { user, claim } = await seedSubmitted("a3");
      const attacker = sub("a3x");
      const auditsBefore = await ClaimAudit.countDocuments({ claimId: claim.id });
      const response = await api().post(`/claims/${claim.id}/verify`).set(authHeader(attacker)).send({});
      expect(response.status).toBe(404);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");
      expect(await ClaimAudit.countDocuments({ claimId: claim.id })).toBe(auditsBefore);
    });

    it("P6-04: an unknown but well-formed claim id returns 404 (no leak)", async () => {
      const user = sub("a4");
      const response = await verify(user, "000000000000000000000000");
      expect(response.status).toBe(404);
    });
  });

  // 2. REQUEST VALIDATION (P6-05..P6-10) — malformed params/body + client-tampering guardrails
  describe("2. request validation & client-tampering guardrails", () => {
    it("P6-05: an invalid claimId format is rejected by param validation (400)", async () => {
      const user = sub("b1");
      const response = await api().post("/claims/not-an-object-id/verify").set(authHeader(user)).send({});
      expect(response.status).toBe(400);
      expect(await ClaimAudit.countDocuments({})).toBe(0);
    });

    it("P6-06: malformed JSON body is rejected (400) without touching the claim", async () => {
      const { user, claim } = await seedSubmitted("b2");
      const auditsBefore = await ClaimAudit.countDocuments({ claimId: claim.id });
      const response = await api()
        .post(`/claims/${claim.id}/verify`)
        .set(authHeader(user))
        .set("Content-Type", "application/json")
        .send("{not valid json");
      expect(response.status).toBe(400);
      expect(response.body.message).toBe("Invalid JSON payload");
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");
      expect(await ClaimAudit.countDocuments({ claimId: claim.id })).toBe(auditsBefore);
    });

    it("P6-07: a client-supplied target state cannot steer the decision (ignored)", async () => {
      const { user, claim } = await seedSubmitted("b3"); // no evidence -> engine says more_evidence_required
      const response = await verify(user, claim.id, { state: "verified", status: "decided" });
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("more_evidence_required");
      expect(verification.claimState).toBe("more_evidence_required");
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("more_evidence_required");
    });

    it("P6-08: a client-supplied verification result cannot forge a decision (ignored)", async () => {
      const { user, claim } = await seedSubmitted("b4");
      const response = await verify(user, claim.id, {
        outcome: "verified",
        approved: true,
        approvedAreaAcres: 999,
        idempotent: true,
        decision: JSON.stringify({ outcome: "verified" }),
      });
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("more_evidence_required");
      expect(verification.approvedAreaAcres).toBeNull();
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("more_evidence_required");
    });

    it("P6-09: a client-supplied acreage cannot alter the server-derived area (ignored)", async () => {
      const { user, claim } = await seedSubmitted("b5");
      const response = await verify(user, claim.id, {
        claimedAreaAcres: 999999,
        area: "999999 acres",
        claimedGeometry: squareGeometry(0.5),
      });
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.claimedAreaAcres).toBe(claim.claimedAreaAcres); // server-derived, not 999999
      expect(verification.claimedAreaAcres).toBeLessThan(999999);
      expect(JSON.stringify(verification)).not.toContain("999999");
    });

    it("P6-10: a client-supplied AI assessment cannot influence the engine (ignored)", async () => {
      const { user, claim } = await seedSubmitted("b6");
      const response = await verify(user, claim.id, {
        aiAggregate: { damageDetected: true, uncertain: false, confidence: "high" },
        observations: [{ observation: { damageDetected: true, confidence: "high" } }],
        aiVerification: { approved: true, score: 0.999 },
      });
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("more_evidence_required"); // engine sees NO server-evidence
      expect(verification.rules.aiCheck).toEqual({ passed: false, reason: "No stored evidence to assess" });
      expect(verification.reason).not.toContain("client");
    });
  });

  // 3. LIFECYCLE (P6-11..P6-18) — the endpoint drives the frozen machine through processing
  describe("3. lifecycle integration", () => {
    it("P6-11: submitted -> processing -> verified through the POST /verify endpoint", async () => {
      const { user, claim } = await seedSubmittedVerified("c1");
      const response = await verify(user, claim.id);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("verified");
      expect(verification.claimState).toBe("verified");
      expect(verification.idempotent).toBe(false);
      expect(verification.inProgress).toBe(false);

      const claimDoc = await LossClaim.findById(claim.id).lean();
      expect(claimDoc.state).toBe("verified");
      expect(claimDoc.processedAt).toBeTruthy();
      expect(claimDoc.decidedAt).toBeTruthy();

      // the frozen machine's processing hop is proven by the audit trail
      const start = await ClaimAudit.findOne({ claimId: claim.id, action: "verification_started" }).lean();
      expect(start.fromState).toBe("submitted");
      expect(start.toState).toBe("processing");
      const decision = await ClaimAudit.findOne({ claimId: claim.id, action: "verified" }).lean();
      expect(decision.fromState).toBe("processing");
      expect(decision.toState).toBe("verified");
      expect(await countAudit(claim.id, "verification_started")).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
    });

    it("P6-12: MORE_EVIDENCE_REQUIRED result is decided deterministically through the API", async () => {
      const { user, claim } = await seedSubmitted("c2"); // no evidence
      const response = await verify(user, claim.id);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("more_evidence_required");
      expect(verification.reason).toBe("No stored evidence to assess");
      expect(verification.approvedGeometry).toBeNull();
      expect(verification.approvedAreaAcres).toBeNull();
      expect(verification.ruleMetrics).toBeUndefined();
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("more_evidence_required");
    });

    it("P6-13: VERIFIED result approves the geometry-derived area (never the AI acreage)", async () => {
      const { user, claim } = await seedSubmittedVerified("c3", LEAKY); // leaky AI tries to plant acreage
      const response = await verify(user, claim.id);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("verified");
      expect(verification.approvedAreaAcres).toBe(claim.claimedAreaAcres);
      expect(JSON.stringify(verification.approvedGeometry)).toBe(JSON.stringify(claim.claimedGeometry));
      expect(verification.rules.areaCheck.passed).toBe(true);
    });

    it("P6-14: PARTIALLY_VERIFIED is never producible through the API (frozen rule set)", async () => {
      const outcomes = [];
      {
        const { user, claim } = await seedSubmittedVerified("c4");
        outcomes.push((await verify(user, claim.id)).body.data.verification.outcome);
      }
      {
        const { user, claim } = await seedSubmitted("c5"); // no evidence
        outcomes.push((await verify(user, claim.id)).body.data.verification.outcome);
      }
      {
        const { user, claim } = await seedSubmittedVerified("c6", UNSURE);
        outcomes.push((await verify(user, claim.id)).body.data.verification.outcome);
      }
      {
        const { user, claim } = await seedSubmitted("c7");
        const response = await verify(user, claim.id, { outcome: "partially_verified" });
        outcomes.push(response.body.data.verification.outcome);
      }
      for (const outcome of outcomes) {
        expect(outcome).not.toBe("partially_verified");
      }
    });

    it("P6-15: REJECTED result for a confident no-damage AI observation", async () => {
      const { user, claim } = await seedSubmittedVerified("c8", NO_DAMAGE);
      const response = await verify(user, claim.id);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("rejected");
      expect(verification.reason).toBe("AI detected no crop damage in the submitted evidence");
      expect(verification.approvedAreaAcres).toBeNull();
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("rejected");
      expect(await countAudit(claim.id, "rejected")).toBe(1);
    });

    it("P6-16: OUT_OF_LIMIT result when the claimed area exceeds the parcel allowance", async () => {
      const { user, parcel } = await seedSubmitted("c9", {}, squareGeometry(0.009));
      const bigger = await createClaimOk(user, parcel.parcelId, nextKey(), { geometry: squareGeometry(0.05) });
      await submitClaim(user, bigger.id);
      const allowed = parcel.calculatedAreaAcres * 1.05;
      expect(bigger.claimedAreaAcres).toBeGreaterThan(allowed);

      const response = await verify(user, bigger.id);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("out_of_limit");
      expect(verification.reason).toBe("Claimed area exceeds the parcel area allowance");
      expect(verification.claimState).toBe("out_of_limit");
      expect((await LossClaim.findById(bigger.id).lean()).state).toBe("out_of_limit");
      expect(await countAudit(bigger.id, "out_of_limit")).toBe(1);
    });

    it("P6-17: DUPLICATE_AREA is never producible through this phase's API (overlap unchecked, E9-S6)", async () => {
      const outcomes = [];
      {
        const { user, claim } = await seedSubmittedVerified("c10");
        outcomes.push((await verify(user, claim.id)).body.data.verification.outcome);
      }
      {
        const { user, claim } = await seedSubmitted("c11");
        const response = await verify(user, claim.id, { overlapStatus: "overlaps_verified", overlapAreaAcres: 1 });
        outcomes.push(response.body.data.verification.outcome);
      }
      for (const outcome of outcomes) {
        expect(outcome).not.toBe("duplicate_area"); // documented deferral, never pretended
      }
    });

    it("P6-18: a terminal claim cannot be re-processed (decision reuse + withdrawn is frozen)", async () => {
      const { user, claim } = await seedSubmittedVerified("c12");
      const first = await verify(user, claim.id);
      expect(first.body.data.verification.outcome).toBe("verified");

      // re-verify: idempotent decision reuse, no new run/audit, state stays verified
      const startAudits = await countAudit(claim.id, "verification_started");
      const second = await verify(user, claim.id);
      expect(second.status).toBe(200);
      expect(second.body.data.verification.idempotent).toBe(true);
      expect(second.body.data.verification.inProgress).toBe(false);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("verified");
      expect(await countAudit(claim.id, "verification_started")).toBe(startAudits);

      // withdrawn is an irreversible terminal state for verification
      const { user: withdrawnUser, claim: wd } = await seedSubmitted("c13");
      await withdrawClaim(withdrawnUser, wd.id);
      const decline = await verify(withdrawnUser, wd.id);
      expect(decline.status).toBe(409);
      expect((await LossClaim.findById(wd.id).lean()).state).toBe("withdrawn");
    });
  });

  // 4. IDEMPOTENCY (P6-19..P6-22)
  describe("4. idempotency", () => {
    it("P6-19: the same verification request twice returns the persisted decision once (no duplicate run)", async () => {
      const { user, claim } = await seedSubmitted("d1"); // no evidence -> more_evidence_required
      const pre = await ClaimAudit.countDocuments({ claimId: claim.id });
      const first = await verify(user, claim.id);
      expect(first.status).toBe(200);
      const afterFirst = await ClaimAudit.countDocuments({ claimId: claim.id }); // + started + decision
      expect(afterFirst).toBe(pre + 2);

      const second = await verify(user, claim.id);
      expect(second.status).toBe(200);
      expect(second.body.data.verification.idempotent).toBe(true);
      expect(second.body.data.verification.outcome).toBe("more_evidence_required");
      expect(await ClaimAudit.countDocuments({ claimId: claim.id })).toBe(afterFirst); // append-only
      expect(await ClaimAssessment.countDocuments({ claimId: claim.id })).toBe(1);
    });

    it("P6-20: the same evidence version yields the identical decision and a single decision record", async () => {
      const { user, claim } = await seedSubmittedVerified("d2");
      const first = await verify(user, claim.id);
      const firstVerification = first.body.data.verification;

      const second = await verify(user, claim.id);
      const secondVerification = second.body.data.verification;
      expect(second.status).toBe(200);
      expect(secondVerification.outcome).toBe(firstVerification.outcome);
      expect(secondVerification.reason).toBe(firstVerification.reason);
      expect(secondVerification.evidenceVersion).toBe(firstVerification.evidenceVersion);
      expect(secondVerification.engineVersion).toBe(firstVerification.engineVersion);
      expect(secondVerification.decidedAt).toBe(firstVerification.decidedAt);

      expect(await ClaimAssessment.countDocuments({ claimId: claim.id })).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
      const doc = await assessmentDoc(claim.id);
      expect(doc.verification.status).toBe("completed");
      expect(doc.verification.completedAt.toISOString()).toBe(firstVerification.decidedAt);
      expect(doc.decidedAt.toISOString()).toBe(firstVerification.decidedAt);
    });

    it("P6-21: new evidence after MORE_EVIDENCE_REQUIRED -> resubmit -> a newly verified decision", async () => {
      const { user, claim } = await seedSubmittedVerified("d3", UNSURE);
      const first = await verify(user, claim.id);
      expect(first.body.data.verification.outcome).toBe("more_evidence_required");

      const resubmit = await api().post(`/claims/${claim.id}/resubmit`).set(authHeader(user));
      expect(resubmit.status).toBe(200);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");

      const oldDocs = await ClaimEvidence.find({ claimId: claim.id, status: "stored" }).lean();
      expect(oldDocs.length).toBe(1);
      await deleteEvidence(user, claim.id, oldDocs[0].uploadId);
      await presignPutComplete(user, claim.id);
      mockAnalyze.mockResolvedValue({ ...CLEAR });
      const assessed = await assess(claim.id, user);
      expect(assessed.status).toBe("completed");

      const second = await verify(user, claim.id);
      expect(second.status).toBe(200);
      expect(second.body.data.verification.outcome).toBe("verified");
      expect(await countAudit(claim.id, "more_evidence_required")).toBe(1);
      expect(await countAudit(claim.id, "resubmitted")).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
    });

    it("P6-22: a retryable gate failure returns 500 and later succeeds — never a silent rejection", async () => {
      const { user, claim } = await seedSubmitted("d4");
      await presignPutComplete(user, claim.id); // evidence without a completed assessment

      const failed = await verify(user, claim.id);
      expect(failed.status).toBe(500);
      expect(failed.body.message).toMatch(/missing or stale/);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("submitted");

      await assess(claim.id, user); // assessment completes now
      const recovered = await verify(user, claim.id);
      expect(recovered.status).toBe(200);
      expect(recovered.body.data.verification.outcome).toBe("verified");
      expect(await countAudit(claim.id, "verification_failed")).toBe(1);
      expect(await countAudit(claim.id, "verified")).toBe(1);
    });
  });

  // 5. CONCURRENCY / CAS (P6-23..P6-25)
  describe("5. concurrency & CAS", () => {
    it("P6-23: concurrent verification requests settle on exactly one decision", async () => {
      const { user, claim } = await seedSubmittedVerified("e1");
      const responses = await Promise.all([
        verify(user, claim.id),
        verify(user, claim.id),
        verify(user, claim.id),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
      // concurrent requests are allowed to OBSERVE the in-flight claim (outcome null, inProgress),
      // but no conflicting decision may ever surface and exactly one worker runs the engine
      const decidedOutcomes = responses
        .map((response) => response.body.data.verification.outcome)
        .filter((outcome) => outcome !== null);
      expect(decidedOutcomes.length).toBeGreaterThan(0);
      for (const outcome of decidedOutcomes) {
        expect(outcome).toBe("verified");
      }
      const winners = responses.filter(
        (response) => response.body.data.verification.idempotent === false
      );
      expect(winners.length).toBeGreaterThan(0);
      expect(await countAudit(claim.id, "verified")).toBe(1);
      expect(await countAudit(claim.id, "verification_started")).toBe(1);
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("verified");
    });

    it("P6-24: the submitted->processing CAS lets exactly one worker run the decision", async () => {
      const { user, claim } = await seedSubmittedVerified("e2");
      await Promise.all([
        verify(user, claim.id),
        verify(user, claim.id),
        verify(user, claim.id),
      ]);
      const doc = await assessmentDoc(claim.id);
      expect(doc.verification.status).toBe("completed");
      const startedRows = await ClaimAudit.find({ claimId: claim.id, action: "verification_started" }).lean();
      const decisionRows = await ClaimAudit.find({ claimId: claim.id, action: "verified" }).lean();
      expect(startedRows.length).toBe(1);
      expect(decisionRows.length).toBe(1); // exactly one persisted decision, no duplicates
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("verified");
    });

    it("P6-25: no stale overwrite — claim, assessment, and response stay mutually consistent", async () => {
      const { user, claim } = await seedSubmittedVerified("e3");
      await Promise.all([
        verify(user, claim.id),
        verify(user, claim.id),
      ]);
      const claimDoc = await LossClaim.findById(claim.id).lean();
      const doc = await assessmentDoc(claim.id);
      expect(claimDoc.state).toBe("verified");
      expect(doc.state).toBe("verified");
      expect(doc.verification.status).toBe("completed");
      expect(doc.verification.startedAt.getTime()).toBeLessThanOrEqual(doc.verification.completedAt.getTime());
      expect(doc.decidedAt.getTime()).toBe(doc.verification.completedAt.getTime());
    });
  });

  // 6. PERSISTENCE (P6-26..P6-32)
  describe("6. persistence & claim surface", () => {
    it("P6-26: the decision is persisted into the claim assessment", async () => {
      const { user, claim } = await seedSubmittedVerified("f1");
      await verify(user, claim.id);
      const doc = await assessmentDoc(claim.id);
      expect(doc.status).toBe("completed");
      expect(doc.state).toBe("verified");
      expect(doc.reason).toBe("All deterministic verification rules passed");
      expect(doc.decidedAt).toBeTruthy();
      expect(doc.decidedBy).toBe("engine");
      expect(doc.rules).toBeTruthy();
      expect(doc.rules.areaCheck.passed).toBe(true);
      expect(doc.verification.status).toBe("completed");
    });

    it("P6-27: the engine version is persisted and exposed", async () => {
      const { user, claim } = await seedSubmittedVerified("f2");
      const response = await verify(user, claim.id);
      expect(response.body.data.verification.engineVersion).toBe("1");
      const doc = await assessmentDoc(claim.id);
      expect(doc.verification.version).toBe("1");
    });

    it("P6-28: the evidence version is computed server-side and persisted for both outcomes", async () => {
      const { user, claim } = await seedSubmittedVerified("f3");
      const response = await verify(user, claim.id);
      const evidenceDocs = await storedEvidence(claim.id);
      const expected = computeEvidenceVersion(evidenceDocs);
      expect(response.body.data.verification.evidenceVersion).toBe(expected);
      const doc = await assessmentDoc(claim.id);
      expect(doc.evidenceVersion).toBe(expected);
    });

    it("P6-29: verification timestamps are persisted as ISO dates and stay coherent", async () => {
      const { user, claim } = await seedSubmittedVerified("f4");
      const response = await verify(user, claim.id);
      const verification = response.body.data.verification;
      expect(new Date(verification.decidedAt).getTime()).toBeGreaterThan(0);
      const doc = await assessmentDoc(claim.id);
      expect(doc.decidedAt).toBeInstanceOf(Date);
      expect(doc.verification.startedAt).toBeInstanceOf(Date);
      expect(doc.verification.completedAt).toBeInstanceOf(Date);
      expect(doc.verification.startedAt.getTime()).toBeLessThanOrEqual(doc.verification.completedAt.getTime());
    });

    it("P6-30: the claim state always matches the persisted verification result", async () => {
      const { user, claim } = await seedSubmittedVerified("f5");
      const response = await verify(user, claim.id);
      const verification = response.body.data.verification;
      const claimDoc = await LossClaim.findById(claim.id).lean();
      const doc = await assessmentDoc(claim.id);
      expect(verification.claimState).toBe("verified");
      expect(verification.outcome).toBe("verified");
      expect(claimDoc.state).toBe("verified");
      expect(doc.state).toBe("verified");
    });

    it("P6-31: claim detail exposes the persisted verification result additively", async () => {
      const { user, claim } = await seedSubmittedVerified("f6");
      await verify(user, claim.id);
      const response = await api().get(`/claims/${claim.id}`).set(authHeader(user));
      expect(response.status).toBe(200);
      const body = response.body.data.claim;
      expect(body.state).toBe("verified");
      expect(body.assessment).toBeTruthy();
      expect(body.assessment.state).toBe("verified");
      expect(body.assessment.reason).toBe("All deterministic verification rules passed");
      expect(body.assessment.approvedAreaAcres).toBeGreaterThan(0);
      expect(body.assessment.rules.timelinessCheck.passed).toBe(true);
      expect(body.cognitoSub).toBeUndefined();
    });

    it("P6-32: claim list stays backward compatible (decided + legacy claims coexist)", async () => {
      const { user, claim } = await seedSubmittedVerified("f7");
      await verify(user, claim.id);
      // a second, older claim that was never verified stays valid (same owner, second parcel)
      const legacyParcel = await seedParcel(user, squareGeometry(0.009));
      const legacy = await createClaimOk(user, legacyParcel.parcelId, nextKey(), {
        eventType: "drought",
      });

      const response = await api().get("/claims").set(authHeader(user));
      expect(response.status).toBe(200);
      const list = response.body.data.claims;
      expect(Array.isArray(list)).toBe(true);
      const decided = list.find((row) => row.id === claim.id);
      const legacyRow = list.find((row) => row.id === legacy.id);
      expect(decided).toBeTruthy();
      expect(decided.state).toBe("verified");
      expect(decided.claimedAreaAcres).toBeGreaterThan(0);
      expect(legacyRow).toBeTruthy();
      expect(legacyRow.state).toBe("draft"); // historical claim untouched
      expect(legacyRow.assessment).toBeNull(); // list never fabricates verification; original contract
      expect(JSON.stringify(list)).not.toMatch(/cognitoSub|s3Key/i);
    });
  });

  // 7. AUDIT (P6-33..P6-35)
  describe("7. audit trail", () => {
    it("P6-33: the decision audit row carries engine identity, transitions, reason, and metadata", async () => {
      const { user, claim } = await seedSubmittedVerified("g1");
      await verify(user, claim.id, {}, undefined);
      const rows = await audits(claim.id);
      const decision = rows.find((row) => row.action === "verified");
      expect(decision).toBeTruthy();
      expect(decision.actor).toBe("engine");
      expect(decision.fromState).toBe("processing");
      expect(decision.toState).toBe("verified");
      expect(decision.reason).toBe("All deterministic verification rules passed");
      expect(decision.metadata).toMatchObject({ overlapEvaluated: false, engineVersion: "1" });
      expect(decision.metadata.evidenceVersion).toBeTruthy();
      const serialized = JSON.stringify(rows.map((row) => row.metadata)).toLowerCase();
      expect(serialized).not.toMatch(/s3|bucket|cognito|url|buffer/i);
    });

    it("P6-34: an external request id is preserved through verification audits", async () => {
      const { user, claim } = await seedSubmittedVerified("g2");
      const response = await api()
        .post(`/claims/${claim.id}/verify`)
        .set(authHeader(user))
        .set("X-Request-Id", "p6-trace-req-34")
        .send({});
      expect(response.status).toBe(200);
      // every audit row generated BY this verification request carries the caller's trace id
      const rows = await audits(claim.id);
      const verificationRows = rows.filter(
        (row) => row.action === "verification_started" || row.action === "verified"
      );
      expect(verificationRows.length).toBe(2);
      for (const row of verificationRows) {
        expect(row.requestId).toBe("p6-trace-req-34");
      }
    });

    it("P6-35: an idempotent request adds no misleading duplicate audit rows", async () => {
      const { user, claim } = await seedSubmittedVerified("g3");
      await verify(user, claim.id);
      const afterFirst = await audits(claim.id);
      await verify(user, claim.id);
      const afterSecond = await audits(claim.id);
      expect(afterSecond.length).toBe(afterFirst.length);
      expect(JSON.stringify(afterSecond)).toBe(JSON.stringify(afterFirst));
    });
  });

  // 8. SECURITY (P6-36..P6-40)
  describe("8. security, ownership & tamper-resistance", () => {
    it("P6-36: ownership isolation — no cross-user leak in the verification response", async () => {
      const { user, claim } = await seedSubmittedVerified("h1");
      const attacker = sub("h1x");
      const foreign = await verify(attacker, claim.id);
      expect(foreign.status).toBe(404); // IDOR-safe, nothing exists for the attacker

      const response = await verify(user, claim.id);
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toMatch(/cognitoSub|s3Key|idempotencyKey|uploadId/i);
    });

    it("P6-37: a client-supplied AI verdict cannot override the engine (no AI override)", async () => {
      const { user, claim } = await seedSubmitted("h2"); // no evidence
      const response = await verify(user, claim.id, {
        aiApproved: true,
        aiConfidence: 0.999,
        aiOutcome: "verified",
        approved: true,
      });
      expect(response.status).toBe(200);
      expect(response.body.data.verification.outcome).toBe("more_evidence_required");
      expect(response.body.data.verification.rules.aiCheck.reason).toBe("No stored evidence to assess");
      expect((await LossClaim.findById(claim.id).lean()).state).toBe("more_evidence_required");
    });

    it("P6-38: a client cannot manipulate the acreage used by the area rule", async () => {
      const { user, parcel } = await seedSubmitted("h3", {}, squareGeometry(0.009));
      const bigger = await createClaimOk(user, parcel.parcelId, nextKey(), { geometry: squareGeometry(0.05) });
      await submitClaim(user, bigger.id);
      // even an absurd under-claim in the body cannot shrink the server-derived claimed area
      const response = await verify(user, bigger.id, { claimedAreaAcres: 0.001, geometry: squareGeometry(0.009) });
      expect(response.status).toBe(200);
      expect(response.body.data.verification.outcome).toBe("out_of_limit");
      expect(response.body.data.verification.claimedAreaAcres).toBe(bigger.claimedAreaAcres);
    });

    it("P6-39: a client cannot force a claim state change outside the frozen machine", async () => {
      const { user, claim } = await seedSubmitted("h4");
      const response = await verify(user, claim.id, {
        state: "verified",
        status: "approved",
        decision: { state: "verified" },
        forcedOutcome: "verified",
      });
      expect(response.status).toBe(200);
      const claimDoc = await LossClaim.findById(claim.id).lean();
      expect(claimDoc.state).toBe("more_evidence_required"); // engine decision, not the guessed state
      expect(response.body.data.verification.claimState).toBe("more_evidence_required");
    });

    it("P6-40: client-supplied evidence references cannot bypass the server's ownership load", async () => {
      const { user, claim } = await seedSubmittedVerified("h5");
      // a foreign claimant's upload id (from a different real claim) is sent in the body
      const { user: other, claim: otherClaim } = await seedSubmittedVerified("h6");
      const otherEvidence = (await storedEvidence(otherClaim.id))[0];

      const response = await verify(user, claim.id, {
        uploadId: otherEvidence.uploadId,
        evidenceId: otherEvidence.uploadId,
        s3Key: "attacker-controlled-key",
        evidenceVersion: "forged",
      });
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.outcome).toBe("verified");
      // the persisted evidence version reflects the OWNER's real stored evidence, never the forged id
      const ownerEvidence = await storedEvidence(claim.id);
      expect(verification.evidenceVersion).toBe(computeEvidenceVersion(ownerEvidence));
      expect(verification.evidenceVersion).not.toBe(otherEvidence.uploadId);
      // the foreign claim and its assessment were untouched by the request
      const otherClaimDoc = await LossClaim.findById(otherClaim.id).lean();
      expect(otherClaimDoc.state).toBe("submitted"); // never verified, never transitioned
      const otherAssessment = await assessmentDoc(otherClaim.id);
      expect(otherAssessment.status).toBe("completed"); // pre-existing Phase 4 assessment
      expect(otherAssessment.state).toBeNull(); // no decision ever fabricated
      const otherRows = await audits(otherClaim.id);
      expect(otherRows.filter((row) => row.action === "verification_failed").length).toBe(0);
    });
  });
});