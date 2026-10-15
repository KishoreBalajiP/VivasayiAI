import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CLAIM_VERIFICATION_POLICY = "v2-components";
});

import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ImageRecord from "../models/ImageRecord.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { putObject } from "../services/s3.service.js";
import claimAssessmentService from "../services/claimAssessment.service.js";
import { findCrossFarmerOverlap } from "../services/crossFarmerOverlap.service.js";
import {
  api,
  adminHeader,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// ADR-020: overlap with ANOTHER farmer's claim is a review signal. It must never become an
// automatic duplicate verdict, never reject, and never reveal the other farmer's claim.

const { mockAnalyze } = vi.hoisted(() => ({ mockAnalyze: vi.fn() }));
vi.mock("../services/claimVision.service.js", () => ({
  analyzeClaimImage: (...args) => mockAnalyze(...args),
}));

const CLEAR = {
  cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate",
  visibleAffectedPortion: "standing water", confidence: "high", uncertain: false,
  inconsistencies: [], observations: ["water"], imageQuality: "good",
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const THRESHOLDS = { minOverlapAcres: 0.05, minShare: 0.1 };
let seq = 0;
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

const seedClaim = async (label, { origin = [0, 0], submit = true, photo = false } = {}) => {
  const user = `xfo-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const geometry = squareGeometry(0.009, origin);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "Field", crop: "Paddy", geometry });
  const created = await api().post("/claims").set(authHeader(user)).send({
    parcelId: parcel.body.data.parcel.parcelId, eventType: "flood", eventDate: daysAgo(2), geometry, idempotencyKey: `idem-xfo-${seq}`,
  });
  expect(created.status).toBe(200);
  const claimId = created.body.data.claim.id;
  if (photo) {
    const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user))
      .send({ contentType: "image/png", size: PNG.length, filename: "p.png" });
    const { uploadId } = presign.body.data;
    const evidence = await ClaimEvidence.findOne({ uploadId });
    await putObject({ key: evidence.s3Key, buffer: PNG, mediaType: "image/png" });
    await api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));
  }
  if (submit) expect((await api().post(`/claims/${claimId}/submit`).set(authHeader(user))).status).toBe(200);
  if (photo && submit) {
    mockAnalyze.mockResolvedValue({ ...CLEAR });
    await claimAssessmentService.assessClaimEvidence({ claimId, cognitoSub: user });
  }
  return { user, claimId };
};

const attachDoc = async (user, claimId) => {
  const presign = await api().post("/upload/presign").set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "d.png" });
  const { uploadId } = presign.body.data;
  const record = await ImageRecord.findOne({ uploadId });
  await putObject({ key: record.s3Key, buffer: PNG, mediaType: "image/png" });
  await api().post(`/upload/${uploadId}/complete`).set(authHeader(user));
  return (await api().post(`/claims/${claimId}/ownership`).set(authHeader(user)).send({ uploadId })).body.data.evidence.id;
};

describe("cross-farmer overlap", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [LossClaim, ClaimEvidence, ClaimAssessment, ClaimAudit, ImageRecord, VerificationEvidence]) await model.deleteMany({});
    mockAnalyze.mockReset();
    mockAnalyze.mockResolvedValue({ ...CLEAR });
  });

  it("XF-1: a claim's bounding box is derived server-side on creation", async () => {
    const { claimId } = await seedClaim("bbox", { origin: [78, 10], submit: false });
    const stored = await LossClaim.findById(claimId).lean();
    expect(stored.bbox).toEqual({ minLon: 78, minLat: 10, maxLon: 78.009, maxLat: 10.009 });
  });

  it("XF-2: finds another farmer's overlapping claim and never the claimant's own", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b", { submit: false });
    const claim = await LossClaim.findById(b.claimId);
    const found = await findCrossFarmerOverlap({ claim, cognitoSub: b.user, thresholds: THRESHOLDS });
    expect(found.flagged).toBe(true);
    expect(found.matches.map((match) => match.claimId)).toEqual([a.claimId]);
    expect(found.maxShare).toBeGreaterThan(0.9);

    // From A's side, B is only a draft (not occupying the land), and A's own claim is never a match.
    const own = await findCrossFarmerOverlap({ claim: await LossClaim.findById(a.claimId), cognitoSub: a.user, thresholds: THRESHOLDS });
    expect(own.flagged).toBe(false);
    expect(own.matches).toEqual([]);
  });

  it("XF-3: distant claims, withdrawn claims and sub-threshold slivers are not flagged", async () => {
    await seedClaim("far", { origin: [80, 12] });
    const b = await seedClaim("near", { submit: false });
    const claim = await LossClaim.findById(b.claimId);
    expect((await findCrossFarmerOverlap({ claim, cognitoSub: b.user, thresholds: THRESHOLDS })).flagged).toBe(false);

    const a = await seedClaim("withdrawn");
    await api().post(`/claims/${a.claimId}/withdraw`).set(authHeader(a.user));
    expect((await findCrossFarmerOverlap({ claim, cognitoSub: b.user, thresholds: THRESHOLDS })).flagged).toBe(false);

    await seedClaim("sliver", { origin: [0.0089, 0.0089] });
    expect((await findCrossFarmerOverlap({ claim, cognitoSub: b.user, thresholds: { minOverlapAcres: 5, minShare: 0.1 } })).flagged).toBe(false);
  });

  it("XF-4: overlap with another farmer HOLDS the claim for review — not a duplicate, not a rejection", async () => {
    await seedClaim("holder");
    const b = await seedClaim("claimant", { photo: true });
    const docId = await attachDoc(b.user, b.claimId);
    await api().post(`/admin/claims/${b.claimId}/ownership/${docId}/review`).set(adminHeader("xfo-admin"))
      .send({ status: "AVAILABLE", reason: "Reviewed the document manually" });

    const response = await api().post(`/claims/${b.claimId}/verify`).set(authHeader(b.user)).send({});
    expect(response.status).toBe(200);
    const decision = response.body.data.verification;
    expect(decision.held).toBe(true);
    expect(decision.claimState).toBe("submitted");
    expect(decision.claimState).not.toBe("duplicate_area");
    expect(decision.pendingComponents).toEqual([{ component: "overlap", outcome: "requires_review", action: "hold" }]);
  });

  it("XF-5: nothing about the other farmer's claim reaches the claimant", async () => {
    const a = await seedClaim("secret-holder");
    const b = await seedClaim("claimant2", { photo: true });
    const docId = await attachDoc(b.user, b.claimId);
    await api().post(`/admin/claims/${b.claimId}/ownership/${docId}/review`).set(adminHeader("xfo-admin")).send({ status: "AVAILABLE", reason: "Reviewed the document manually" });

    const verify = await api().post(`/claims/${b.claimId}/verify`).set(authHeader(b.user)).send({});
    const detail = await api().get(`/claims/${b.claimId}`).set(authHeader(b.user));
    const verification = await api().get(`/claims/${b.claimId}/verification`).set(authHeader(b.user));
    for (const response of [verify, detail, verification]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(a.claimId);
      expect(text).not.toContain(a.user);
    }
  });

  it("XF-6: the match details are recorded for admins, once per situation", async () => {
    const a = await seedClaim("holder3");
    const b = await seedClaim("claimant3", { photo: true });
    for (let i = 0; i < 3; i += 1) await api().post(`/claims/${b.claimId}/verify`).set(authHeader(b.user)).send({});
    const rows = await ClaimAudit.find({ claimId: b.claimId, action: "cross_farmer_overlap_flagged" }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.matches[0].claimId).toBe(a.claimId);

    const admin = await api().get(`/admin/claims/${b.claimId}`).set(adminHeader("xfo-admin"));
    expect(admin.status).toBe(200);
    expect(JSON.stringify(admin.body)).toContain(a.claimId);
  });
});
