import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import FarmProfile from "../models/FarmProfile.js";
import LossClaim from "../models/LossClaim.js";
import ImageRecord from "../models/ImageRecord.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import { putObject } from "../services/s3.service.js";
import { OPERATIVE_EVIDENCE_SOURCES } from "../utils/verificationEvidence.js";
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

// Phase 12 (E12) — Land ownership verification workflow.
//
// End-to-end coverage of the first functional ownership flow built on the Phase 11 Verification
// Evidence foundation: a claimant attaches an owned, stored private document to a claim they own;
// only an admin can review it (manually, non-authoritatively); every action is immutably audited;
// and ownership NEVER changes the claim state / decision / area or the deterministic engine.
//
// All deterministic (mock S3, mongodb-memory-server).

const sub = (name) => `test-ownership-${name}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const TRANSPARENT_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const seedParcel = async (user, geometry = squareGeometry(0.009)) => {
  expect((await seedProfile(user)).status).toBe(200);
  const response = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Ownership field", crop: "Paddy", geometry });
  expect(response.status).toBe(200);
  return response.body.data.parcel;
};

const createClaimOk = async (user, parcelId, idempotencyKey) => {
  const response = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({
      parcelId,
      eventType: "flood",
      eventDate: daysAgo(2),
      geometry: squareGeometry(0.009),
      idempotencyKey,
    });
  expect(response.status).toBe(200);
  return response.body.data.claim;
};

// A fully-owned context: user + parcel + draft claim.
const seedOwner = async (name) => {
  const user = sub(name);
  const parcel = await seedParcel(user);
  const claim = await createClaimOk(user, parcel.parcelId, `idem-${name}`);
  return { user, parcel, claim };
};

// Uploads a private document through the EXISTING presigned /upload pipeline and returns uploadId.
const uploadDocument = async (user, contentType = "image/png") => {
  const presign = await api()
    .post("/upload/presign")
    .set(authHeader(user))
    .send({ contentType, size: TRANSPARENT_PNG_BUFFER.length, filename: "doc.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const record = await ImageRecord.findOne({ uploadId });
  expect(record).toBeTruthy();
  await putObject({ key: record.s3Key, buffer: TRANSPARENT_PNG_BUFFER, mediaType: contentType });
  const complete = await api().post(`/upload/${uploadId}/complete`).set(authHeader(user));
  expect(complete.status).toBe(200);
  return uploadId;
};

const attach = (user, claimId, uploadId, documentCategory) =>
  api()
    .post(`/claims/${claimId}/ownership`)
    .set(authHeader(user))
    .send(documentCategory ? { uploadId, documentCategory } : { uploadId });

const listOwnership = (user, claimId) =>
  api().get(`/claims/${claimId}/ownership`).set(authHeader(user));

const ownershipUrl = (user, claimId, evidenceId) =>
  api().get(`/claims/${claimId}/ownership/${evidenceId}/url`).set(authHeader(user));

const adminList = (admin, claimId) =>
  api().get(`/admin/claims/${claimId}/ownership`).set(adminHeader(admin));

const adminReview = (admin, claimId, evidenceId, body) =>
  api()
    .post(`/admin/claims/${claimId}/ownership/${evidenceId}/review`)
    .set(adminHeader(admin))
    .send(body);

const VALID_REASON = "Document reviewed manually against the claimed parcel";

describe("land ownership verification workflow — Phase 12", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase(mongo);
  });

  beforeEach(async () => {
    await clearTestDatabase();
    await Promise.all([
      LossClaim.deleteMany({}),
      ImageRecord.deleteMany({}),
      VerificationEvidence.deleteMany({}),
      ClaimAudit.deleteMany({}),
      AdminAction.deleteMany({}),
    ]);
  });

  it("OW-01: a claimant attaches an owned stored document → PENDING, OWNERSHIP, non-operative, audited", async () => {
    const { user, claim } = await seedOwner("attach");
    const uploadId = await uploadDocument(user);

    const res = await attach(user, claim.id, uploadId, "land_record");
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/attached/i);

    const evidence = res.body.data.evidence;
    expect(evidence.source).toBe("OWNERSHIP");
    expect(evidence.status).toBe("PENDING");
    expect(evidence.reference).toBe(uploadId);
    expect(evidence.operative).toBe(false);
    expect(evidence.metadata.parcelId).toBe(claim.parcelId);
    expect(evidence.metadata.documentCategory).toBe("land_record");

    const row = await VerificationEvidence.findById(evidence.id);
    expect(row.source).toBe("OWNERSHIP");
    expect(row.claimId.toString()).toBe(claim.id);

    expect(
      await ClaimAudit.countDocuments({
        claimId: claim.id,
        action: "ownership_evidence_submitted",
        actor: "farmer",
      })
    ).toBe(1);
  });

  it("OW-02: document category defaults to 'other' when omitted", async () => {
    const { user, claim } = await seedOwner("default-category");
    const uploadId = await uploadDocument(user);
    const res = await attach(user, claim.id, uploadId);
    expect(res.status).toBe(200);
    expect(res.body.data.evidence.metadata.documentCategory).toBe("other");
  });

  it("OW-03: an unknown document category is rejected (400)", async () => {
    const { user, claim } = await seedOwner("bad-category");
    const uploadId = await uploadDocument(user);
    const res = await attach(user, claim.id, uploadId, "not_a_category");
    expect(res.status).toBe(400);
  });

  it("OW-04: a malformed uploadId is rejected (400)", async () => {
    const { user, claim } = await seedOwner("bad-upload-id");
    const res = await attach(user, claim.id, "not-an-upload-id");
    expect(res.status).toBe(400);
  });

  it("OW-05: a foreign uploadId cannot be attached (404, no existence disclosure)", async () => {
    const alice = await seedOwner("foreign-owner");
    const bob = await seedOwner("foreign-thief");
    const bobUpload = await uploadDocument(bob.user);
    const res = await attach(alice.user, alice.claim.id, bobUpload);
    expect(res.status).toBe(404);
  });

  it("OW-06: a user cannot attach evidence to another user's claim (404)", async () => {
    const alice = await seedOwner("cross-claim-a");
    const bob = await seedOwner("cross-claim-b");
    const bobUpload = await uploadDocument(bob.user);
    const res = await attach(bob.user, alice.claim.id, bobUpload);
    expect(res.status).toBe(404);
  });

  it("OW-07: re-attaching the same document is idempotent (one row, one audit)", async () => {
    const { user, claim } = await seedOwner("idempotent");
    const uploadId = await uploadDocument(user);

    const first = await attach(user, claim.id, uploadId);
    const second = await attach(user, claim.id, uploadId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/already attached/i);
    expect(second.body.data.evidence.id).toBe(first.body.data.evidence.id);

    expect(
      await VerificationEvidence.countDocuments({ claimId: claim.id, source: "OWNERSHIP" })
    ).toBe(1);
    expect(
      await ClaimAudit.countDocuments({ claimId: claim.id, action: "ownership_evidence_submitted" })
    ).toBe(1);
  });

  it("OW-08: a farmer cannot review ownership evidence (self-verify blocked, 403)", async () => {
    const { user, claim } = await seedOwner("self-verify");
    const uploadId = await uploadDocument(user);
    const attached = await attach(user, claim.id, uploadId);
    const evidenceId = attached.body.data.evidence.id;

    const res = await api()
      .post(`/admin/claims/${claim.id}/ownership/${evidenceId}/review`)
      .set(authHeader(user))
      .send({ status: "AVAILABLE", reason: VALID_REASON });
    expect(res.status).toBe(403);
  });

  it("OW-09: an admin manual review resolves PENDING → AVAILABLE (non-authoritative) and is audited", async () => {
    const { user, claim } = await seedOwner("review-available");
    const uploadId = await uploadDocument(user);
    const attached = await attach(user, claim.id, uploadId, "ownership_deed");
    const evidenceId = attached.body.data.evidence.id;

    const admin = sub("admin-available");
    const res = await adminReview(admin, claim.id, evidenceId, {
      status: "AVAILABLE",
      reason: VALID_REASON,
    });
    expect(res.status).toBe(200);
    const evidence = res.body.data.evidence;
    expect(evidence.status).toBe("AVAILABLE");
    expect(evidence.result.verificationMethod).toBe("manual_review");
    expect(evidence.result.authoritative).toBe(false);
    expect(evidence.result.reviewedByRole).toBe("admin");

    expect(
      await AdminAction.countDocuments({ claimId: claim.id, action: "manual_review", actorSub: admin })
    ).toBe(1);
    expect(
      await ClaimAudit.countDocuments({
        claimId: claim.id,
        action: "ownership_evidence_reviewed",
        actor: "admin",
      })
    ).toBe(1);
  });

  it("OW-10: VERIFIED is refused (no authoritative provider) and leaves the document PENDING", async () => {
    const { user, claim } = await seedOwner("review-verified");
    const uploadId = await uploadDocument(user);
    const evidenceId = (await attach(user, claim.id, uploadId)).body.data.evidence.id;

    const res = await adminReview(sub("admin-verified"), claim.id, evidenceId, {
      status: "VERIFIED",
      reason: VALID_REASON,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not configured/i);

    const row = await VerificationEvidence.findById(evidenceId);
    expect(row.status).toBe("PENDING");
  });

  it("OW-11: INSUFFICIENT / INCONSISTENT / UNAVAILABLE are each recordable review outcomes", async () => {
    const { user, claim } = await seedOwner("review-outcomes");
    const admin = sub("admin-outcomes");
    for (const status of ["INSUFFICIENT", "INCONSISTENT", "UNAVAILABLE"]) {
      const uploadId = await uploadDocument(user);
      const evidenceId = (await attach(user, claim.id, uploadId)).body.data.evidence.id;
      const res = await adminReview(admin, claim.id, evidenceId, { status, reason: VALID_REASON });
      expect(res.status).toBe(200);
      expect(res.body.data.evidence.status).toBe(status);
      expect(res.body.data.evidence.result.authoritative).toBe(false);
    }
  });

  it("OW-12: a review reason shorter than the minimum is rejected (400)", async () => {
    const { user, claim } = await seedOwner("review-short-reason");
    const uploadId = await uploadDocument(user);
    const evidenceId = (await attach(user, claim.id, uploadId)).body.data.evidence.id;
    const res = await adminReview(sub("admin-short"), claim.id, evidenceId, {
      status: "AVAILABLE",
      reason: "short",
    });
    expect(res.status).toBe(400);
  });

  it("OW-13: a terminally reviewed document cannot be re-reviewed with a different outcome (409), identical replay is idempotent", async () => {
    const { user, claim } = await seedOwner("review-terminal");
    const uploadId = await uploadDocument(user);
    const evidenceId = (await attach(user, claim.id, uploadId)).body.data.evidence.id;
    const admin = sub("admin-terminal");

    expect(
      (await adminReview(admin, claim.id, evidenceId, { status: "AVAILABLE", reason: VALID_REASON }))
        .status
    ).toBe(200);

    const conflict = await adminReview(admin, claim.id, evidenceId, {
      status: "INCONSISTENT",
      reason: VALID_REASON,
    });
    expect(conflict.status).toBe(409);

    const replay = await adminReview(admin, claim.id, evidenceId, {
      status: "AVAILABLE",
      reason: VALID_REASON,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.message).toMatch(/already recorded/i);
    expect(replay.body.data.evidence.status).toBe("AVAILABLE");

    expect(await AdminAction.countDocuments({ claimId: claim.id, action: "manual_review" })).toBe(1);
  });

  it("OW-14: concurrent conflicting reviews apply exactly once (race-safe CAS)", async () => {
    const { user, claim } = await seedOwner("review-race");
    const uploadId = await uploadDocument(user);
    const evidenceId = (await attach(user, claim.id, uploadId)).body.data.evidence.id;
    const admin = sub("admin-race");

    const statuses = ["AVAILABLE", "INSUFFICIENT", "INCONSISTENT", "UNAVAILABLE"];
    const responses = await Promise.all(
      statuses.map((status) => adminReview(admin, claim.id, evidenceId, { status, reason: VALID_REASON }))
    );

    const ok = responses.filter((res) => res.status === 200);
    expect(ok.length).toBe(1);
    expect(responses.filter((res) => res.status === 409).length).toBe(3);

    expect(await AdminAction.countDocuments({ claimId: claim.id, action: "manual_review" })).toBe(1);
    const row = await VerificationEvidence.findById(evidenceId);
    expect(statuses).toContain(row.status);
  });

  it("OW-15: a claimant lists only their own ownership evidence (foreign list → 404)", async () => {
    const alice = await seedOwner("list-a");
    const bob = await seedOwner("list-b");
    const uploadId = await uploadDocument(alice.user);
    await attach(alice.user, alice.claim.id, uploadId, "tax_receipt");

    const mine = await listOwnership(alice.user, alice.claim.id);
    expect(mine.status).toBe(200);
    expect(mine.body.data.evidence.length).toBe(1);
    expect(mine.body.data.summary.total).toBe(1);
    expect(mine.body.data.summary.statusCounts.PENDING).toBe(1);
    expect(mine.body.data.summary.verificationAvailable).toBe(false);

    const foreign = await listOwnership(bob.user, alice.claim.id);
    expect(foreign.status).toBe(404);
  });

  it("OW-16: an admin can list any claim's ownership evidence (with document URLs); non-admin is 403", async () => {
    const { user, claim } = await seedOwner("admin-list");
    const uploadId = await uploadDocument(user);
    await attach(user, claim.id, uploadId);

    const res = await adminList(sub("admin-list"), claim.id);
    expect(res.status).toBe(200);
    expect(res.body.data.evidence.length).toBe(1);
    expect(res.body.data.evidence[0]).toHaveProperty("documentUrl");
    expect(res.body.data.evidence[0].documentUrl.signedUrl).toMatch(/^https:\/\/mock-bucket\.local\//);

    const denied = await api().get(`/admin/claims/${claim.id}/ownership`).set(authHeader(user));
    expect(denied.status).toBe(403);
  });

  it("OW-17: the owner can mint a short-lived URL for their document; a foreign user gets 404", async () => {
    const alice = await seedOwner("url-a");
    const bob = await seedOwner("url-b");
    const uploadId = await uploadDocument(alice.user);
    const evidenceId = (await attach(alice.user, alice.claim.id, uploadId)).body.data.evidence.id;

    const own = await ownershipUrl(alice.user, alice.claim.id, evidenceId);
    expect(own.status).toBe(200);
    expect(own.body.data.signedUrl).toMatch(/^https:\/\/mock-bucket\.local\//);

    const foreign = await ownershipUrl(bob.user, alice.claim.id, evidenceId);
    expect(foreign.status).toBe(404);
  });

  it("OW-18: ownership evidence never changes the claim state, decision, or area", async () => {
    const { user, claim } = await seedOwner("no-effect");
    const originalArea = claim.claimedAreaAcres;
    const uploadId = await uploadDocument(user);
    const evidenceId = (await attach(user, claim.id, uploadId)).body.data.evidence.id;
    await adminReview(sub("admin-no-effect"), claim.id, evidenceId, {
      status: "AVAILABLE",
      reason: VALID_REASON,
    });

    const detail = await api().get(`/claims/${claim.id}`).set(authHeader(user));
    expect(detail.status).toBe(200);
    expect(detail.body.data.claim.state).toBe("draft");
    expect(detail.body.data.claim.claimedAreaAcres).toBe(originalArea);
    expect(detail.body.data.claim.assessment).toBeNull();
  });

  it("OW-19: a legacy claim with no ownership evidence still works (empty view, unchanged claim)", async () => {
    const { user, claim } = await seedOwner("legacy");
    const res = await listOwnership(user, claim.id);
    expect(res.status).toBe(200);
    expect(res.body.data.evidence).toEqual([]);
    expect(res.body.data.summary.total).toBe(0);

    const detail = await api().get(`/claims/${claim.id}`).set(authHeader(user));
    expect(detail.status).toBe(200);
    expect(detail.body.data.claim.state).toBe("draft");
  });

  it("OW-20: only a fully stored upload may be attached (a pending upload → 404)", async () => {
    const { user, claim } = await seedOwner("not-stored");
    const presign = await api()
      .post("/upload/presign")
      .set(authHeader(user))
      .send({ contentType: "image/png", size: TRANSPARENT_PNG_BUFFER.length, filename: "doc.png" });
    const { uploadId } = presign.body.data;
    // No /complete call: the ImageRecord is still `pending`.
    const res = await attach(user, claim.id, uploadId);
    expect(res.status).toBe(404);
  });

  it("OW-21: OWNERSHIP remains non-operative for the deterministic engine (Phase 11 compatibility)", async () => {
    const { user, claim } = await seedOwner("non-operative");
    const uploadId = await uploadDocument(user);
    await attach(user, claim.id, uploadId);

    // The engine's consumable sources are unchanged; OWNERSHIP is stored but never consumed.
    expect(OPERATIVE_EVIDENCE_SOURCES).toEqual(["GEOMETRY", "AI_IMAGE", "WEATHER"]);
    expect(OPERATIVE_EVIDENCE_SOURCES).not.toContain("OWNERSHIP");

    const rows = await VerificationEvidence.find({ claimId: claim.id, source: "OWNERSHIP" });
    expect(rows.length).toBe(1);
  });
});
