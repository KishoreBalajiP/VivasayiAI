import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ApiError from "../utils/ApiError.js";
import { putObject } from "../services/s3.service.js";
import claimAssessmentService from "../services/claimAssessment.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// E9-S4 (ADR-019) — Phase 4: Claim Evidence AI Assessment. Internal service (NO public endpoint),
// deterministic and fully offline: S3 is the existing mock seam, Gemini is replaced by a
// controllable fake at the claimVision boundary, so no external AI/storage is ever called.
//
// Scenarios P4-01..P4-34 map 1:1 to the §21 mandated cases (A. ownership / B. evidence state /
// C. model adapter / D. AI guardrails / E. uncertainty / F. lifecycle / G. claim state / H. security).

const { mockAnalyze } = vi.hoisted(() => ({ mockAnalyze: vi.fn() }));

vi.mock("../services/claimVision.service.js", () => ({
  analyzeClaimImage: (...args) => mockAnalyze(...args),
}));

const sub = (name) => `test-assessment-${name}`;
let testSeq = 0;
const nextUser = (prefix) => `p4-${prefix}-${(++testSeq).toString(36)}`;
const nextKey = () => `idem-p4-${testSeq}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const TRANSPARENT_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const FROZEN_FIELDS = [
  "cropDetected",
  "damageDetected",
  "damageType",
  "severity",
  "visibleAffectedPortion",
  "confidence",
  "uncertain",
  "inconsistencies",
  "observations",
  "imageQuality",
].sort();

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

const DROUGHT = { ...CLEAR, damageType: "drought", severity: "severe" };

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

// Deliberately leaky adapter output (would arrive already-stripped from the real normalizer; the
// persistence scrub must make it structurally impossible to store authoritative fields).
const LEAKY = {
  ...CLEAR,
  acreage: 3.2,
  polygon: { type: "Polygon", coordinates: [[[1, 2], [3, 4], [5, 6], [1, 2]]] },
  compensation: 50000,
  approved: true,
  finalStatus: "verified",
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

const seedPair = async (aName, bName) => {
  const alice = sub(aName);
  const bob = sub(bName);
  const aliceParcel = await seedParcel(alice);
  const bobParcel = await seedParcel(bob);
  const aliceClaim = await createClaimOk(alice, aliceParcel.parcelId, `idem-p4-${aName}`);
  const bobClaim = await createClaimOk(bob, bobParcel.parcelId, `idem-p4-${bName}`);
  return { alice, bob, aliceClaim, bobClaim };
};

const presignEvidence = (user, claimId, body) =>
  api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send(body);

const completeEvidence = (user, claimId, uploadId) =>
  api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));

// presign + simulate the Browser→S3 PUT into the mock bucket + complete (full lifecycle).
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
  await putObject({
    key: evidence.s3Key,
    buffer: TRANSPARENT_PNG_BUFFER,
    mediaType: contentType,
  });
  const completeResponse = await completeEvidence(user, claimId, uploadId);
  expect(completeResponse.status).toBe(200);
  return { claimId, uploadId };
};

const storedEvidence = (claimId) =>
  ClaimEvidence.find({ claimId, status: "stored" }).sort({ uploadedAt: 1 }).lean();

const storedBytes = async (claimId) => {
  const { getObject } = await import("../services/s3.service.js");
  const list = await storedEvidence(claimId);
  return (await getObject(list[0].s3Key)).buffer;
};

const assess = (claimId, cognitoSub, extra = {}) =>
  claimAssessmentService.assessClaimEvidence({ claimId, cognitoSub, ...extra });

const assessmentDoc = (claimId) => ClaimAssessment.findOne({ claimId }).lean();

const audit = (claimId, action) => ClaimAudit.findOne({ claimId, action }).lean();

describe("agricultural loss claim — Phase 4 AI evidence assessment", () => {
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

  describe("A. ownership", () => {
    let alice, bob, aliceClaim, bobClaim;
    beforeEach(async () => {
      ({ alice, bob, aliceClaim, bobClaim } = await seedPair("a1", "b1"));
    });

    it("P4-01: user A cannot assess user B's claim (404, no vision call)", async () => {
      await expect(assess(aliceClaim.id, bob)).rejects.toMatchObject({
        statusCode: 404,
        message: "Claim not found",
      });
      expect(mockAnalyze).not.toHaveBeenCalled();
    });

    it("P4-02: user A cannot assess user B's evidence (no evidenceId path; foreign claimId → 404)", async () => {
      await presignPutComplete(bob, bobClaim.id);
      await expect(
        assess(aliceClaim.id, bob, { evidenceId: bobClaim.id })
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(mockAnalyze).not.toHaveBeenCalled();
    });
  });

  describe("B. evidence state", () => {
    let alice, aliceClaim;
    beforeEach(async () => {
      const user = nextUser("b");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
      await submitClaim(alice, aliceClaim.id);
    });

    it("P4-03: missing evidence fails safely (400, no assessment created)", async () => {
      await expect(assess(aliceClaim.id, alice)).rejects.toMatchObject({
        statusCode: 400,
        message: "No stored evidence to assess",
      });
      expect(await ClaimAssessment.countDocuments({ claimId: aliceClaim.id })).toBe(0);
      expect(mockAnalyze).not.toHaveBeenCalled();
    });

    it("P4-04: incomplete/pending evidence is rejected (400)", async () => {
      // presign only — the object was never PUT, so the evidence stays "pending".
      const presign = await presignEvidence(alice, aliceClaim.id, {
        contentType: "image/png",
        size: TRANSPARENT_PNG_BUFFER.length,
        filename: "photo.png",
      });
      expect(presign.status).toBe(200);
      await expect(assess(aliceClaim.id, alice)).rejects.toMatchObject({
        statusCode: 400,
        message: "No stored evidence to assess",
      });
      expect(mockAnalyze).not.toHaveBeenCalled();
    });

    it("P4-05: completed/stored evidence is accepted and every stored image is analyzed", async () => {
      await presignPutComplete(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
      const stored = await storedEvidence(aliceClaim.id);
      expect(stored.length).toBe(2);

      const result = await assess(aliceClaim.id, alice);
      expect(result.status).toBe("completed");
      expect(result.imageCount).toBe(2);
      expect(mockAnalyze).toHaveBeenCalledTimes(2);
      const analyzedUploads = mockAnalyze.mock.calls.map(([args]) => {
        expect(args).toHaveProperty("imageBuffer");
        expect(args).toHaveProperty("mediaType");
        return args;
      });
      expect(analyzedUploads.length).toBe(2);
    });

    it("P4-06: a foreign upload cannot be used (IDOR-safe even with evidence present)", async () => {
      const { alice: a2, bob: b2, aliceClaim: aC2, bobClaim: bC2 } = await seedPair("b6a", "b6b");
      await presignPutComplete(a2, aC2.id);
      await expect(assess(aC2.id, b2, { evidenceId: bC2.id })).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(mockAnalyze).not.toHaveBeenCalled();
    });
  });

  describe("C. Gemini/model adapter behaviour", () => {
    let alice, aliceClaim;
    const setUp2Images = async () => {
      await submitClaim(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
    };
    beforeEach(async () => {
      const user = nextUser("c");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
    });

    it("P4-07: successful structured responses are parsed, aggregated, and persisted per image", async () => {
      await setUp2Images();
      mockAnalyze.mockImplementation(async () => ({ ...CLEAR }));
      const result = await assess(aliceClaim.id, alice);
      expect(result.status).toBe("completed");
      expect(result.aiAggregate.imageCount).toBe(2);
      expect(result.aiAggregate.damageDetected).toBe(true);
      expect(result.aiAggregate.damageType).toBe("flood");
      expect(result.assessments).toHaveLength(2);
      expect(result.assessments[0].observation.damageDetected).toBe(true);
    });

    it("P4-08: malformed/unsure output is composed, not fatal — aggregate uncertainty surfaces", async () => {
      await setUp2Images();
      mockAnalyze
        .mockResolvedValueOnce({ ...UNSURE })
        .mockResolvedValueOnce({ ...CLEAR });
      const result = await assess(aliceClaim.id, alice);
      expect(result.status).toBe("completed");
      expect(result.assessments).toHaveLength(2);
      expect(result.aiAggregate.uncertain).toBe(true);
    });

    it("P4-09: persisted per-image observations contain exactly the frozen fields", async () => {
      await setUp2Images();
      const result = await assess(aliceClaim.id, alice);
      const doc = await assessmentDoc(aliceClaim.id);
      for (const image of doc.aiImageAssessments) {
        expect(Object.keys(image.observation).sort()).toEqual(FROZEN_FIELDS);
      }
      expect(result.assessments[0]).toHaveProperty("evidenceId");
      expect(result.assessments[0]).toHaveProperty("uploadId");
    });

    it("P4-10: provider error → sanitized assessment failure (status failed, stage provider)", async () => {
      await setUp2Images();
      mockAnalyze.mockRejectedValue(ApiError.internal("Failed to analyze claim evidence image"));
      await expect(assess(aliceClaim.id, alice)).rejects.toMatchObject({ statusCode: 500 });
      const doc = await assessmentDoc(aliceClaim.id);
      expect(doc.status).toBe("failed");
      expect(doc.error.stage).toBe("provider");
      expect(doc.error.message).not.toMatch(/gemini|stack|secret|url/i);
      expect((await audit(aliceClaim.id, "assessment_failed")).action).toBe("assessment_failed");
    });

    it("P4-11: provider timeout → same sanitized assessment failure (retryable)", async () => {
      await setUp2Images();
      mockAnalyze.mockRejectedValue(new Error("deadline exceeded"));
      await expect(assess(aliceClaim.id, alice)).rejects.toMatchObject({ statusCode: 500 });
      const doc = await assessmentDoc(aliceClaim.id);
      expect(doc.status).toBe("failed");
      expect(doc.error.stage).toBe("provider");
      expect(doc.error.message).toBe("Claim evidence assessment failed");
    });
  });

  describe("D. AI guardrails", () => {
    let alice, aliceClaim, before;
    beforeEach(async () => {
      const user = nextUser("d");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
      await submitClaim(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
      before = await LossClaim.findById(aliceClaim.id).lean();
    });

    it("P4-12..15: acreage/polygon/compensation/approval output never reaches persistence", async () => {
      mockAnalyze.mockResolvedValue({ ...LEAKY });
      const result = await assess(aliceClaim.id, alice);
      const doc = await assessmentDoc(aliceClaim.id);
      const aiPayload = JSON.stringify({
        aggregate: doc.aiAggregate,
        observations: (doc.aiImageAssessments || []).map((image) => image.observation),
        resultObservations: result.assessments.map((image) => image.observation),
      }).toLowerCase();
      expect(aiPayload).not.toContain("acreage");
      expect(aiPayload).not.toContain("polygon");
      expect(aiPayload).not.toContain("compensation");
      expect(aiPayload).not.toContain("approved");
      expect(aiPayload).not.toContain("finalstatus");
      for (const image of doc.aiImageAssessments) {
        expect(Object.keys(image.observation).sort()).toEqual(FROZEN_FIELDS);
      }
    });

    it("P4-16: no severity-to-acreage calculation exists — area stays backend-derived and untouched", async () => {
      mockAnalyze.mockResolvedValue({ ...DROUGHT });
      await assess(aliceClaim.id, alice);
      const after = await LossClaim.findById(aliceClaim.id).lean();
      expect(after.claimedAreaAcres).toBe(before.claimedAreaAcres);
      const doc = await assessmentDoc(aliceClaim.id);
      const aiPayload = JSON.stringify({
        aggregate: doc.aiAggregate,
        observations: (doc.aiImageAssessments || []).map((image) => image.observation),
      }).toLowerCase();
      expect(aiPayload).not.toContain("affectedacres");
      expect(aiPayload).not.toContain("acre");
    });

    it("P4-17: visibleAffectedPortion stays a qualitative, non-authoritative string", async () => {
      mockAnalyze.mockResolvedValue({ ...CLEAR });
      const result = await assess(aliceClaim.id, alice);
      expect(result.assessments[0].observation.visibleAffectedPortion).toContain("portion of the visible field");
      const after = await LossClaim.findById(aliceClaim.id).lean();
      expect(after.claimedAreaAcres).toBe(before.claimedAreaAcres);
      expect(JSON.stringify(after.claimedGeometry)).toBe(JSON.stringify(before.claimedGeometry));
    });
  });

  describe("E. uncertainty", () => {
    let alice, aliceClaim;
    beforeEach(async () => {
      const user = nextUser("e");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
      await submitClaim(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
    });

    it("P4-18: uncertain=true is persisted correctly", async () => {
      mockAnalyze.mockResolvedValue({ ...UNSURE });
      const result = await assess(aliceClaim.id, alice);
      expect(result.aiAggregate.uncertain).toBe(true);
      const doc = await assessmentDoc(aliceClaim.id);
      expect(doc.aiImageAssessments.every((img) => img.observation.uncertain === true)).toBe(true);
    });

    it("P4-19: poor image quality is represented correctly", async () => {
      mockAnalyze.mockResolvedValue({ ...UNSURE });
      await assess(aliceClaim.id, alice);
      const doc = await assessmentDoc(aliceClaim.id);
      expect(doc.aiImageAssessments.every((img) => img.observation.imageQuality === "unclear")).toBe(true);
    });

    it("P4-20: conflicting evidence is represented deterministically in the aggregate", async () => {
      mockAnalyze
        .mockResolvedValueOnce({ ...CLEAR })
        .mockResolvedValueOnce({ ...DROUGHT });
      const result = await assess(aliceClaim.id, alice);
      expect(result.aiAggregate.inconsistencies).toContain(
        "Different damage types reported across evidence images"
      );
    });

    it("P4-21: insufficient evidence does not transition the claim", async () => {
      mockAnalyze.mockResolvedValue({ ...UNSURE });
      const result = await assess(aliceClaim.id, alice);
      expect(result.status).toBe("completed");
      const claim = await LossClaim.findById(aliceClaim.id).lean();
      expect(claim.state).toBe("submitted");
    });
  });

  describe("F. assessment lifecycle", () => {
    let alice, aliceClaim;
    beforeEach(async () => {
      const user = nextUser("f");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
      await submitClaim(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
    });

    it("P4-22: first assessment creates exactly one assessment row", async () => {
      await assess(aliceClaim.id, alice);
      expect(await ClaimAssessment.countDocuments({ claimId: aliceClaim.id })).toBe(1);
    });

    it("P4-23/25: repeated request is idempotent and the completed assessment is reused", async () => {
      const first = await assess(aliceClaim.id, alice);
      expect(first.status).toBe("completed");
      expect(mockAnalyze).toHaveBeenCalledTimes(1);

      const second = await assess(aliceClaim.id, alice);
      expect(second.status).toBe("completed");
      expect(second.evidenceVersion).toBe(first.evidenceVersion);
      expect(await ClaimAssessment.countDocuments({ claimId: aliceClaim.id })).toBe(1);
      expect(mockAnalyze).toHaveBeenCalledTimes(1); // no re-analysis
    });

    it("P4-24: an in-flight processing assessment is never duplicated", async () => {
      await assess(aliceClaim.id, alice);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      await ClaimAssessment.updateOne(
        { claimId: aliceClaim.id },
        { $set: { status: "processing", startedAt: new Date() } }
      );
      const result = await assess(aliceClaim.id, alice);
      expect(result.status).toBe("processing");
      expect(await ClaimAssessment.countDocuments({ claimId: aliceClaim.id })).toBe(1);
      expect(mockAnalyze).toHaveBeenCalledTimes(1); // untouched by the concurrent request
    });

    it("P4-26: a failed assessment can be retried according to the contract", async () => {
      mockAnalyze.mockRejectedValueOnce(ApiError.internal("Failed to analyze claim evidence image"));
      await expect(assess(aliceClaim.id, alice)).rejects.toMatchObject({ statusCode: 500 });
      expect((await assessmentDoc(aliceClaim.id)).status).toBe("failed");

      mockAnalyze.mockResolvedValue({ ...CLEAR });
      const retried = await assess(aliceClaim.id, alice);
      expect(retried.status).toBe("completed");
      expect(await ClaimAssessment.countDocuments({ claimId: aliceClaim.id })).toBe(1);
      expect(mockAnalyze).toHaveBeenCalledTimes(2); // failed attempt + retry
    });
  });

  describe("G. claim state is never decided here", () => {
    let alice, aliceClaim, before;
    beforeEach(async () => {
      const user = nextUser("g");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
      await submitClaim(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
      before = await LossClaim.findById(aliceClaim.id).lean();
      expect(before.state).toBe("submitted");
    });

    it("P4-27/28/29/30: assessment changes neither state, area, nor geometry", async () => {
      mockAnalyze.mockResolvedValue({ ...CLEAR });
      const result = await assess(aliceClaim.id, alice);
      expect(result.status).toBe("completed");
      const after = await LossClaim.findById(aliceClaim.id).lean();
      expect(after.state).toBe("submitted");
      expect(["verified", "partially_verified", "rejected", "out_of_limit", "duplicate_area"]).not.toContain(after.state);
      expect(after.claimedAreaAcres).toBe(before.claimedAreaAcres);
      expect(JSON.stringify(after.claimedGeometry)).toBe(JSON.stringify(before.claimedGeometry));
      // assessment decision fields stay reserved
      const doc = await assessmentDoc(aliceClaim.id);
      expect(doc.state).toBeNull();
      expect(doc.approvedAreaAcres).toBeNull();
      expect(doc.decidedAt).toBeNull();
    });
  });

  describe("H. security", () => {
    let alice, aliceClaim;
    beforeEach(async () => {
      const user = nextUser("h");
      const key = nextKey();
      alice = user;
      const parcel = await seedParcel(user);
      aliceClaim = await createClaimOk(user, parcel.parcelId, key);
      await submitClaim(alice, aliceClaim.id);
      await presignPutComplete(alice, aliceClaim.id);
    });

    it("P4-31: no arbitrary S3 URL accepted — only claim-owned bytes reach vision", async () => {
      await assess(aliceClaim.id, alice, {
        imageUrl: "https://evil.example.com/stolen.jpg",
      });
      const stored = await storedEvidence(aliceClaim.id);
      expect(mockAnalyze).toHaveBeenCalledTimes(1);
      const args = mockAnalyze.mock.calls[0][0];
      expect(args).not.toHaveProperty("url");
      expect(args.imageBuffer.equals(await storedBytes(aliceClaim.id))).toBe(true);
      expect(stored.length).toBe(1);
    });

    it("P4-32: no arbitrary S3 key accepted — keys derive from persisted records only", async () => {
      await assess(aliceClaim.id, alice, { s3Key: "claims/rogue/image.png" });
      const stored = await storedEvidence(aliceClaim.id);
      expect(stored.length).toBe(1);
      const args = mockAnalyze.mock.calls[0][0];
      expect(args.imageBuffer.equals(await storedBytes(aliceClaim.id))).toBe(true);
    });

    it("P4-33: no client-provided cognitoSub accepted — ownership comes from the caller argument", async () => {
      const result = await assess(aliceClaim.id, alice, { attackerCognitoSub: "bob-the-farmer" });
      expect(result.status).toBe("completed");
      const doc = await assessmentDoc(aliceClaim.id);
      expect(doc.claimId.toString()).toBe(aliceClaim.id);
    });

    it("P4-34: no client-provided claim state accepted — state is never mutated", async () => {
      await assess(aliceClaim.id, alice, { state: "verified" });
      const claim = await LossClaim.findById(aliceClaim.id).lean();
      expect(claim.state).toBe("submitted");
    });

    it("audit: ai_completed/assessment_failed metadata never contains storage internals", async () => {
      await assess(aliceClaim.id, alice);
      const row = await audit(aliceClaim.id, "ai_completed");
      expect(row.actor).toBe("engine");
      const serialized = JSON.stringify(row.metadata);
      expect(serialized).not.toMatch(/s3|bucket|key|cognito|url|buffer/i);
    });
  });
});