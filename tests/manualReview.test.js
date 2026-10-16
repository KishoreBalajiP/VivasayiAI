import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import LossClaim from "../models/LossClaim.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ImageRecord from "../models/ImageRecord.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { putObject } from "../services/s3.service.js";
import AdminAction from "../models/AdminAction.js";
import VerificationJob from "../models/VerificationJob.js";
import { createReviewCase } from "../services/manualReview.service.js";
import { examineOwnershipDocumentsForClaim } from "../services/landDocumentExamination.service.js";
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

// Manual-review cases (Phase 15) share the OWNERSHIP evidence source with real claimant documents.
// Regressions covered:
//   - the idempotency key embedded Date.now(), so every pipeline run created another case;
//   - review cases appeared in the farmer's ownership list/summary as if they were documents;
//   - land-document examination iterated review cases and reported "document not found" errors.

const sub = (name) => `test-manualreview-${name}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const seedClaim = async (user, key) => {
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Review field", crop: "Paddy", geometry: squareGeometry(0.009) });
  expect(parcel.status).toBe(200);
  const claim = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({
      parcelId: parcel.body.data.parcel.parcelId,
      eventType: "flood",
      eventDate: daysAgo(2),
      geometry: squareGeometry(0.009),
      idempotencyKey: key,
    });
  expect(claim.status).toBe(200);
  return claim.body.data.claim;
};

const attachDocument = async (user, claimId) => {
  const presign = await api()
    .post("/upload/presign")
    .set(authHeader(user))
    .send({ contentType: "image/png", size: PNG.length, filename: "patta.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const record = await ImageRecord.findOne({ uploadId });
  await putObject({ key: record.s3Key, buffer: PNG, mediaType: "image/png" });
  expect((await api().post(`/upload/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);
  const attached = await api()
    .post(`/claims/${claimId}/ownership`)
    .set(authHeader(user))
    .send({ uploadId });
  expect(attached.status).toBe(200);
  return uploadId;
};

describe("manual review cases — regressions", () => {
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
    await VerificationEvidence.deleteMany({});
    await ClaimAudit.deleteMany({});
    await ImageRecord.deleteMany({});
    await AdminAction.deleteMany({});
    await VerificationJob.deleteMany({});
  });

  it("MR-1: the same review reasons are idempotent — one case, one audit row", async () => {
    const user = sub("idem");
    const claim = await seedClaim(user, "idem-mr-1");
    const args = { claimId: claim.id ?? claim._id, cognitoSub: user, source: "OWNERSHIP", reasons: ["official_land_record_unavailable"] };

    const first = await createReviewCase(args);
    const second = await createReviewCase(args);

    expect(String(second._id)).toBe(String(first._id));
    expect(await VerificationEvidence.countDocuments({ claimId: claim.id ?? claim._id, "metadata.reviewRequired": true })).toBe(1);
    expect(await ClaimAudit.countDocuments({ claimId: claim.id ?? claim._id, action: "review_required" })).toBe(1);
  });

  it("MR-2: different reasons open a separate case", async () => {
    const user = sub("reasons");
    const claim = await seedClaim(user, "idem-mr-2");
    const base = { claimId: claim.id ?? claim._id, cognitoSub: user, source: "OWNERSHIP" };

    await createReviewCase({ ...base, reasons: ["official_land_record_unavailable"] });
    await createReviewCase({ ...base, reasons: ["inconclusive_land_document_examination"] });

    expect(await VerificationEvidence.countDocuments({ claimId: claim.id ?? claim._id, "metadata.reviewRequired": true })).toBe(2);
  });

  it("MR-3: the farmer's ownership list and summary exclude review cases; admins still see them", async () => {
    const user = sub("list");
    const claim = await seedClaim(user, "idem-mr-3");
    const claimId = claim.id ?? claim._id;
    const uploadId = await attachDocument(user, claimId);
    await createReviewCase({ claimId, cognitoSub: user, source: "OWNERSHIP", reasons: ["inconclusive_land_document_examination"] });

    const farmer = await api().get(`/claims/${claimId}/ownership`).set(authHeader(user));
    expect(farmer.status).toBe(200);
    expect(farmer.body.data.evidence).toHaveLength(1);
    expect(farmer.body.data.evidence[0].reference ?? farmer.body.data.evidence[0].uploadId).toBe(uploadId);
    expect(farmer.body.data.summary.total).toBe(1);

    const admin = await api().get(`/admin/claims/${claimId}/ownership`).set(adminHeader("mr-admin"));
    expect(admin.status).toBe(200);
    expect(admin.body.data.evidence).toHaveLength(2);
  });

  it("MR-4: land-document examination only iterates real documents, not review cases", async () => {
    const user = sub("exam");
    const claim = await seedClaim(user, "idem-mr-4");
    const claimId = claim.id ?? claim._id;
    await attachDocument(user, claimId);
    await createReviewCase({ claimId, cognitoSub: user, source: "OWNERSHIP", reasons: ["x_review_reason"] });

    const result = await examineOwnershipDocumentsForClaim({ claimId, cognitoSub: user });
    expect(result.count).toBe(1);
    expect(result.results.every((entry) => !entry.error)).toBe(true);
  });

  describe("admin review-case decisions", () => {
    const REASON = "Reviewed the automated finding and the documents manually";
    const decide = (admin, claimId, evidenceId, body) =>
      api()
        .post(`/admin/claims/${claimId}/review-cases/${evidenceId}/decision`)
        .set(adminHeader(admin))
        .send(body);

    const openCase = async (label) => {
      const user = sub(label);
      const claim = await seedClaim(user, `idem-mr-${label}`);
      const claimId = claim.id ?? claim._id;
      const row = await createReviewCase({ claimId, cognitoSub: user, source: "OWNERSHIP", reasons: ["official_land_record_unavailable"] });
      return { user, claimId, evidenceId: String(row._id) };
    };

    it("MR-5: an admin can list and resolve a review case; it is recorded as an AdminAction and audited", async () => {
      const { claimId, evidenceId } = await openCase("resolve");
      const list = await api().get(`/admin/claims/${claimId}/review-cases`).set(adminHeader("mr-admin"));
      expect(list.status).toBe(200);
      expect(list.body.data.cases).toHaveLength(1);

      const response = await decide("mr-admin", claimId, evidenceId, { decision: "AVAILABLE", reason: REASON });
      expect(response.status).toBe(200);
      expect((await VerificationEvidence.findById(evidenceId)).status).toBe("AVAILABLE");
      expect(await AdminAction.countDocuments({ claimId, action: "manual_review", actorSub: "mr-admin" })).toBe(1);
      expect(await ClaimAudit.countDocuments({ claimId, action: "manual_review_resolved" })).toBe(1);
    });

    it("MR-6: VERIFIED is refused — a manual review can never create authoritative evidence", async () => {
      const { claimId, evidenceId } = await openCase("verified");
      const response = await decide("mr-admin", claimId, evidenceId, { decision: "VERIFIED", reason: REASON });
      expect(response.status).toBe(400);
      expect((await VerificationEvidence.findById(evidenceId)).status).toBe("PENDING");
    });

    it("MR-7: a case resolves only once (409), and only through the claim it belongs to (404)", async () => {
      const first = await openCase("once");
      expect((await decide("mr-admin", first.claimId, first.evidenceId, { decision: "AVAILABLE", reason: REASON })).status).toBe(200);
      expect((await decide("mr-admin", first.claimId, first.evidenceId, { decision: "INCONSISTENT", reason: REASON })).status).toBe(409);

      const other = await openCase("other");
      expect((await decide("mr-admin", other.claimId, first.evidenceId, { decision: "AVAILABLE", reason: REASON })).status).toBe(404);
    });

    it("MR-8: farmers cannot use the review endpoints (403) and a short reason is refused (400)", async () => {
      const { user, claimId, evidenceId } = await openCase("gate");
      const asFarmer = await api()
        .post(`/admin/claims/${claimId}/review-cases/${evidenceId}/decision`)
        .set(authHeader(user))
        .send({ decision: "AVAILABLE", reason: REASON });
      expect(asFarmer.status).toBe(403);
      expect((await decide("mr-admin", claimId, evidenceId, { decision: "AVAILABLE", reason: "short" })).status).toBe(400);
    });
  });

});
