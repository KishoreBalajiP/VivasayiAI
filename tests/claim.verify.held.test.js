import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The policy is read once at import time (config/env.js).
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

// ADR-020 end to end (policy v2-components). A claim whose photographs support it is still not
// approved until claimant rights are resolved. Unresolved means HELD: the claim stays `submitted`
// (withdrawable), no decision exists, and the reason is recorded once, not once per poll.

const { mockAnalyze } = vi.hoisted(() => ({ mockAnalyze: vi.fn() }));
vi.mock("../services/claimVision.service.js", () => ({
  analyzeClaimImage: (...args) => mockAnalyze(...args),
}));

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
const NO_DAMAGE = { ...CLEAR, damageDetected: false, damageType: null, severity: null, observations: [] };

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const REASON = "Reviewed the document manually against the parcel";
let seq = 0;
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

const seedSubmittedClaimWithPhoto = async (label) => {
  const user = `held-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Held field", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({
      parcelId: parcel.body.data.parcel.parcelId,
      eventType: "flood",
      eventDate: daysAgo(2),
      geometry: squareGeometry(0.009),
      idempotencyKey: `idem-held-${seq}`,
    });
  expect(created.status).toBe(200);
  const claimId = created.body.data.claim.id;

  // one stored photograph
  const presign = await api()
    .post(`/claims/${claimId}/evidence/presign`)
    .set(authHeader(user))
    .send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const evidence = await ClaimEvidence.findOne({ uploadId });
  await putObject({ key: evidence.s3Key, buffer: PNG, mediaType: "image/png" });
  expect((await api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);

  expect((await api().post(`/claims/${claimId}/submit`).set(authHeader(user))).status).toBe(200);
  mockAnalyze.mockResolvedValue({ ...CLEAR });
  await claimAssessmentService.assessClaimEvidence({ claimId, cognitoSub: user });
  return { user, claimId };
};

const attachOwnershipDocument = async (user, claimId) => {
  const presign = await api()
    .post("/upload/presign")
    .set(authHeader(user))
    .send({ contentType: "image/png", size: PNG.length, filename: "patta.png" });
  const { uploadId } = presign.body.data;
  const record = await ImageRecord.findOne({ uploadId });
  await putObject({ key: record.s3Key, buffer: PNG, mediaType: "image/png" });
  expect((await api().post(`/upload/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);
  const attached = await api().post(`/claims/${claimId}/ownership`).set(authHeader(user)).send({ uploadId });
  expect(attached.status).toBe(200);
  return attached.body.data.evidence.id;
};

const verify = (user, claimId) => api().post(`/claims/${claimId}/verify`).set(authHeader(user)).send({});
// The controller nests the decision under `data.verification`.
const decisionOf = (response) => response.body.data.verification;
const review = (admin, claimId, evidenceId, status) =>
  api()
    .post(`/admin/claims/${claimId}/ownership/${evidenceId}/review`)
    .set(adminHeader(admin))
    .send({ status, reason: REASON });
const auditCount = (claimId, action) => ClaimAudit.countDocuments({ claimId, action });

describe("verification policy v2-components — required-component gate end to end", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [LossClaim, ClaimEvidence, ClaimAssessment, ClaimAudit, ImageRecord, VerificationEvidence]) {
      await model.deleteMany({});
    }
    mockAnalyze.mockReset();
    mockAnalyze.mockResolvedValue({ ...CLEAR });
  });

  it("HD-1: supportive photos with NO ownership evidence ask the farmer for more evidence, never approve", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("none");
    const response = await verify(user, claimId);
    expect(response.status).toBe(200);
    const data = decisionOf(response);
    expect(data.claimState).toBe("more_evidence_required");
    expect(data.policyId).toBe("v2-components");
    expect(data.components.claimant_rights.outcome).toBe("unverified");
    expect(data.approvedAreaAcres).toBeNull();
  });

  it("HD-2: a document awaiting review HOLDS the claim: still submitted, no decision, withdrawable", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("pending");
    await attachOwnershipDocument(user, claimId);

    const response = await verify(user, claimId);
    expect(response.status).toBe(200);
    const data = decisionOf(response);
    expect(data.held).toBe(true);
    expect(data.claimState).toBe("submitted");
    expect(data.outcome).toBeNull();
    expect(data.approvedAreaAcres).toBeNull();
    expect(data.pendingComponents).toEqual([{ component: "claimant_rights", outcome: "pending", action: "hold" }]);
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");

    const stored = await ClaimAssessment.findOne({ claimId });
    expect(stored.state).toBeNull();
    expect(stored.verification.status).toBe("held");
    expect(stored.hold.blocking[0].component).toBe("claimant_rights");

    const withdrawn = await api().post(`/claims/${claimId}/withdraw`).set(authHeader(user));
    expect(withdrawn.status).toBe(200);
  });

  it("HD-3: polling a held claim does not flood the audit trail", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("poll");
    await attachOwnershipDocument(user, claimId);
    for (let i = 0; i < 4; i += 1) expect((await verify(user, claimId)).status).toBe(200);
    expect(await auditCount(claimId, "verification_held")).toBe(1);
    expect(await auditCount(claimId, "verification_started")).toBe(0);
  });

  it("HD-4: once an admin accepts the document the next verify approves, and the decision is explainable", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("approve");
    const evidenceId = await attachOwnershipDocument(user, claimId);
    expect(decisionOf(await verify(user, claimId)).held).toBe(true);

    expect((await review("held-admin", claimId, evidenceId, "AVAILABLE")).status).toBe(200);
    const decided = await verify(user, claimId);
    expect(decided.status).toBe(200);
    const data = decisionOf(decided);
    expect(data.held).toBe(false);
    expect(data.claimState).toBe("verified");
    expect(data.components.claimant_rights.outcome).toBe("verified");
    expect(data.components.claimant_rights.authoritative).toBe(false);

    const stored = await ClaimAssessment.findOne({ claimId });
    expect(stored.hold).toBeNull();
    expect(stored.policy.id).toBe("v2-components");
    expect(stored.policy.hash).toMatch(/^[0-9a-f]{64}$/);
    const audit = await ClaimAudit.findOne({ claimId, action: "verified" });
    expect(audit.metadata.policyId).toBe("v2-components");
    expect(audit.metadata.policyHash).toBe(stored.policy.hash);
    expect(audit.metadata.componentOutcomes.claimant_rights).toBe("verified");
    const reviewed = audit.metadata.evidenceRefs.find((ref) => ref.id === evidenceId);
    expect(reviewed).toMatchObject({ status: "AVAILABLE" });
  });

  it("HD-5: an inconsistent document asks for more evidence and never rejects", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("inconsistent");
    const evidenceId = await attachOwnershipDocument(user, claimId);
    expect((await review("held-admin-2", claimId, evidenceId, "INCONSISTENT")).status).toBe(200);
    const data = decisionOf(await verify(user, claimId));
    expect(data.claimState).toBe("more_evidence_required");
    expect(data.claimState).not.toBe("rejected");
  });

  it("HD-6: a confident AI no-damage reading holds for a reviewer instead of rejecting", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("nodamage");
    const evidenceId = await attachOwnershipDocument(user, claimId);
    expect((await review("held-admin-3", claimId, evidenceId, "AVAILABLE")).status).toBe(200);
    // Re-assess the same photos with a no-damage reading.
    await ClaimAssessment.deleteMany({ claimId });
    mockAnalyze.mockResolvedValue({ ...NO_DAMAGE });
    await claimAssessmentService.assessClaimEvidence({ claimId, cognitoSub: user });

    const data = decisionOf(await verify(user, claimId));
    expect(data.held).toBe(true);
    expect(data.claimState).toBe("submitted");
    expect(data.pendingComponents[0]).toMatchObject({ component: "photos", outcome: "requires_review" });
  });

  it("HD-7: a decision made under the v2 policy is idempotent on replay", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("replay");
    const evidenceId = await attachOwnershipDocument(user, claimId);
    await review("held-admin-4", claimId, evidenceId, "AVAILABLE");
    const first = decisionOf(await verify(user, claimId));
    const second = decisionOf(await verify(user, claimId));
    expect(second.idempotent).toBe(true);
    expect(second.claimState).toBe(first.claimState);
    expect(await auditCount(claimId, "verified")).toBe(1);
  });

  it("HD-8: claim detail shows the held state and component outcomes, so a status page can render them", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("detail");
    await attachOwnershipDocument(user, claimId);
    await verify(user, claimId);

    const detail = await api().get(`/claims/${claimId}`).set(authHeader(user));
    expect(detail.status).toBe(200);
    const assessment = detail.body.data.claim.assessment;
    expect(assessment.held).toBe(true);
    expect(assessment.pendingComponents).toEqual([{ component: "claimant_rights", outcome: "pending", action: "hold" }]);
    expect(assessment.components.claimant_rights.outcome).toBe("pending");
    expect(assessment.policyId).toBe("v2-components");
    expect(assessment.state).toBeNull();
  });

});
