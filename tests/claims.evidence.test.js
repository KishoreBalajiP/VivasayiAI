import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import FarmProfile from "../models/FarmProfile.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { putObject } from "../services/s3.service.js";
import * as claimEvidenceService from "../services/claimEvidence.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// F-49 (ADR-019) — Phase 3: Claim Evidence + Assessment Foundation hardening.
// Covers the 16 mandated security/IDOR/idempotency/validation/lifecycle cases on the claim
// evidence layer (08 §10 evidence endpoints), plus the Phase 3 evidence-audit integration
// (07 §9) and the preserved no-evidence-required submit contract.
//
// Scenarios: P3-01..P3-17. All deterministic (mock S3, mongodb-memory-server).

const sub = (name) => `test-evidence-${name}`;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const TRANSPARENT_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

// A byte sequence that sniffs as image/jpeg (JPEG SOI marker) but is NOT a declared PNG.
const JPEG_MAGIC_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01]);

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

// Pair of independent users, each with a parcel + a draft claim.
const seedPair = async (aName, bName) => {
  const alice = sub(aName);
  const bob = sub(bName);
  const aliceParcel = await seedParcel(alice);
  const bobParcel = await seedParcel(bob);
  const aliceClaim = await createClaimOk(alice, aliceParcel.parcelId, `idem-${aName}`);
  const bobClaim = await createClaimOk(bob, bobParcel.parcelId, `idem-${bName}`);
  return { alice, bob, aliceClaim, bobClaim };
};

const presignEvidence = (user, claimId, body) =>
  api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send(body);

const completeEvidence = (user, claimId, uploadId) =>
  api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));

const deleteEvidence = (user, claimId, uploadId) =>
  api().delete(`/claims/${claimId}/evidence/${uploadId}`).set(authHeader(user));

const evidenceUrl = (user, claimId, uploadId) =>
  api().get(`/claims/${claimId}/evidence/${uploadId}/url`).set(authHeader(user));

// presign + simulate the Browser→S3 PUT into the mock bucket + complete (the full lifecycle).
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
  return { presign, complete: completeResponse, uploadId };
};

const auditCount = async (claimId, action) => ClaimAudit.countDocuments({ claimId, action });

describe("agricultural loss claim — Phase 3 evidence hardening", () => {
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
    await ClaimAudit.deleteMany({});
  });

  it("P3-01: user A cannot read user B's evidence (complete/url/detail all 404)", async () => {
    const { alice, bob, bobClaim } = await seedPair("read-a", "read-b");
    const { uploadId } = await presignPutComplete(bob, bobClaim.id);
    // B's own evidence is stored and viewable by B.
    expect((await evidenceUrl(bob, bobClaim.id, uploadId)).status).toBe(200);
    // A cannot complete, view, or find B's evidence anywhere.
    expect((await completeEvidence(alice, bobClaim.id, uploadId)).status).toBe(404);
    expect((await evidenceUrl(alice, bobClaim.id, uploadId)).status).toBe(404);
    const list = await api().get("/claims").set(authHeader(alice));
    const ids = list.body.data.claims.flatMap((c) =>
      (c.evidence || []).map((e) => e.uploadId)
    );
    expect(ids).not.toContain(uploadId);
    expect(await ClaimEvidence.findOne({ uploadId })).toBeTruthy(); // B's evidence intact
  });

  it("P3-02: user A cannot delete user B's evidence (404, evidence survives)", async () => {
    const { alice, bob, bobClaim } = await seedPair("del-a", "del-b");
    const { uploadId } = await presignPutComplete(bob, bobClaim.id);
    const response = await deleteEvidence(alice, bobClaim.id, uploadId);
    expect(response.status).toBe(404);
    expect(await ClaimEvidence.findOne({ uploadId })).toBeTruthy();
    expect((await evidenceUrl(bob, bobClaim.id, uploadId)).status).toBe(200);
  });

  it("P3-03: user A cannot generate user B's evidence signed URL (404)", async () => {
    const { alice, bob, bobClaim } = await seedPair("url-a", "url-b");
    const { uploadId } = await presignPutComplete(bob, bobClaim.id);
    expect((await evidenceUrl(alice, bobClaim.id, uploadId)).status).toBe(404);
    // And a fabricated id on B's claim is equally denied.
    expect(
      (
        await evidenceUrl(alice, bobClaim.id, "img_00000000-0000-4000-8000-000000000077")
      ).status
    ).toBe(404);
  });

  it("P3-04: user A cannot attach user B's upload to A's claim (complete/delete/url all 404)", async () => {
    const { alice, bob, aliceClaim, bobClaim } = await seedPair("attach-a", "attach-b");
    const { uploadId } = await presignPutComplete(bob, bobClaim.id); // stored under B's claim
    expect((await completeEvidence(alice, aliceClaim.id, uploadId)).status).toBe(404);
    expect((await deleteEvidence(alice, aliceClaim.id, uploadId)).status).toBe(404);
    expect((await evidenceUrl(alice, aliceClaim.id, uploadId)).status).toBe(404);
    // A's own lifecycle still works with a fresh, own-scoped upload.
    const { uploadId: ownId } = await presignPutComplete(alice, aliceClaim.id);
    expect((await evidenceUrl(alice, aliceClaim.id, ownId)).status).toBe(200);
    const claim = await LossClaim.findById(aliceClaim.id);
    expect(claim.evidence).toHaveLength(1);
    expect(claim.evidence[0]).not.toBe(uploadId);
  });

  it("P3-05: cognitoSub/state/s3Key in the presign body cannot be manipulated", async () => {
    const alice = sub("owner-body-a");
    const parcel = await seedParcel(alice);
    const claim = await createClaimOk(alice, parcel.parcelId, "idem-owner-body-05");
    const response = await presignEvidence(alice, claim.id, {
      contentType: "image/png",
      size: 100,
      cognitoSub: "attacker-999",
      claimOwner: "attacker-999",
      state: "verified",
      s3Key: "uploads/attacker/evil.png",
      s3Bucket: "attacker-bucket",
    });
    expect(response.status).toBe(200);
    expect(response.body.data).not.toHaveProperty("cognitoSub");
    expect(response.body.data).not.toHaveProperty("s3Key");
    expect(response.body.data).not.toHaveProperty("s3Bucket");
    const evidence = await ClaimEvidence.findOne({ uploadId: response.body.data.uploadId });
    expect(String(evidence.claimId)).toBe(claim.id); // bound to ALICE's claim
    const storedClaim = await LossClaim.findById(claim.id);
    expect(storedClaim.state).toBe("draft"); // state field ignored
  });

  it("P3-06: evidence mutation is rejected in every terminal/processing claim state (409)", async () => {
    const user = sub("term-states");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-term-06");
    // The state guard lives in the service (single source of truth); prove all 7 blocked
    // states at the service boundary (no HTTP limiter budget involved), then one HTTP 409.
    const blocked = ["processing", "verified", "partially_verified", "rejected",
      "out_of_limit", "duplicate_area", "withdrawn"];
    for (const state of blocked) {
      await LossClaim.updateOne({ _id: claim.id }, { $set: { state } });
      await expect(
        claimEvidenceService.presignEvidence({
          claimId: claim.id,
          cognitoSub: user,
          contentType: "image/png",
          size: 100,
        })
      ).rejects.toMatchObject({ statusCode: 409 });
    }
    await LossClaim.updateOne({ _id: claim.id }, { $set: { state: "withdrawn" } });
    const response = await presignEvidence(user, claim.id, {
      contentType: "image/png",
      size: 100,
    });
    expect(response.status).toBe(409);
    expect(response.body.message).toContain("Evidence can only be modified");
  });

  it("P3-07: claim ownership cannot be retargeted via the create body (owner stays the caller)", async () => {
    const alice = sub("owner-claim-a");
    const parcel = await seedParcel(alice);
    const claim = await createClaimOk(alice, parcel.parcelId, "idem-owner-claim-07", {
      cognitoSub: "attacker-999",
      profileId: "000000000000000000000000",
      state: "verified",
      claimedAreaAcres: 99999,
    });
    expect(claim.state).toBe("draft");
    const stored = await LossClaim.findById(claim.id);
    expect(stored.cognitoSub).toBe(alice);
    expect(claim.claimedAreaAcres).not.toBe(99999);
  });

  it("P3-08: an unsupported evidence file type is rejected (400)", async () => {
    const user = sub("type-a");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-type-08");
    const response = await presignEvidence(user, claim.id, {
      contentType: "application/pdf",
      size: 100,
    });
    expect(response.status).toBe(400);
  });

  it("P3-09: MIME/signature mismatch is rejected — bytes vs declared and header vs declared", async () => {
    const user = sub("mismatch");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-mismatch-09a");

    // (a) PRESIGN PNG, upload JPEG bytes under the PNG content type → magic-byte signature
    //     does not match the declared type.
    const p1 = await presignEvidence(user, claim.id, { contentType: "image/png", size: 100 });
    expect(p1.status).toBe(200);
    const e1 = await ClaimEvidence.findOne({ uploadId: p1.body.data.uploadId });
    await putObject({ key: e1.s3Key, buffer: JPEG_MAGIC_BUFFER, mediaType: "image/png" });
    const c1 = await completeEvidence(user, claim.id, p1.body.data.uploadId);
    expect(c1.status).toBe(400);
    expect(c1.body.message).toContain("declared type");
    expect((await ClaimEvidence.findById(e1._id)).status).toBe("failed");

    // (b) PRESIGN PNG, upload PNG bytes but with a JPEG S3 header → stored media type does not
    //     match the declared type (headObject check).
    const p2 = await presignEvidence(user, claim.id, { contentType: "image/png", size: 100 });
    expect(p2.status).toBe(200);
    const e2 = await ClaimEvidence.findOne({ uploadId: p2.body.data.uploadId });
    await putObject({ key: e2.s3Key, buffer: TRANSPARENT_PNG_BUFFER, mediaType: "image/jpeg" });
    const c2 = await completeEvidence(user, claim.id, p2.body.data.uploadId);
    expect(c2.status).toBe(400);
    expect(c2.body.message).toContain("declared type");
    expect((await ClaimEvidence.findById(e2._id)).status).toBe("failed");
  });

  it("P3-10: oversized evidence is rejected — at presign (413) and at complete (400)", async () => {
    const user = sub("oversize");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-oversize-10");
    const presign = await presignEvidence(user, claim.id, {
      contentType: "image/png",
      size: 6 * 1024 * 1024,
    });
    expect(presign.status).toBe(413);
    expect(presign.body.message).toContain("maximum allowed size");
    // Browser uploads an object larger than the cap → server-measured size wins.
    const small = await presignEvidence(user, claim.id, { contentType: "image/png", size: 100 });
    expect(small.status).toBe(200);
    const evidence = await ClaimEvidence.findOne({ uploadId: small.body.data.uploadId });
    await putObject({
      key: evidence.s3Key,
      buffer: Buffer.alloc(6 * 1024 * 1024 + 1, 0xff),
      mediaType: "image/png",
    });
    const complete = await completeEvidence(user, claim.id, small.body.data.uploadId);
    expect(complete.status).toBe(400);
    expect(complete.body.message).toContain("maximum allowed size");
    expect((await ClaimEvidence.findById(evidence._id)).status).toBe("failed");
  });

  it("P3-11: repeated complete is idempotent — returns the stored metadata, no re-processing", async () => {
    const user = sub("idem-complete");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-complete-11");
    const { uploadId } = await presignPutComplete(user, claim.id);
    const second = await completeEvidence(user, claim.id, uploadId);
    expect(second.status).toBe(200);
    expect(second.body.data.evidence.status).toBe("stored");
    expect(second.body.data.evidence.uploadId).toBe(uploadId);
    expect(second.body.data.evidence.width).toBeGreaterThan(0);
  });

  it("P3-12: repeated complete creates no duplicate evidence record", async () => {
    const user = sub("no-dup");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-nodup-12");
    const { uploadId } = await presignPutComplete(user, claim.id);
    await completeEvidence(user, claim.id, uploadId);
    expect(await ClaimEvidence.countDocuments({ claimId: claim.id })).toBe(1);
    const stored = await LossClaim.findById(claim.id);
    expect(stored.evidence).toHaveLength(1);
  });

  it("P3-13: missing S3 object is rejected, record stays pending, and the same presign retries cleanly", async () => {
    const user = sub("missing");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-missing-13");
    const presign = await presignEvidence(user, claim.id, {
      contentType: "image/png",
      size: TRANSPARENT_PNG_BUFFER.length,
    });
    expect(presign.status).toBe(200);
    const uploadId = presign.body.data.uploadId;
    const evidence = await ClaimEvidence.findOne({ uploadId });
    // No PUT simulated → object absent.
    const first = await completeEvidence(user, claim.id, uploadId);
    expect(first.status).toBe(400);
    expect(first.body.message).toContain("not been uploaded");
    expect((await ClaimEvidence.findById(evidence._id)).status).toBe("pending"); // retryable
    // Now the browser uploads and the SAME presigned capability completes.
    await putObject({
      key: evidence.s3Key,
      buffer: TRANSPARENT_PNG_BUFFER,
      mediaType: "image/png",
    });
    const second = await completeEvidence(user, claim.id, uploadId);
    expect(second.status).toBe(200);
    expect(second.body.data.evidence.status).toBe("stored");
  });

  it("P3-14: arbitrary S3 keys cannot be requested — regex rejects, unknown ids 404", async () => {
    const user = sub("arbitrary");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-arb-14");
    const presign = await presignEvidence(user, claim.id, {
      contentType: "image/png",
      size: 100,
    });
    expect(presign.status).toBe(200);
    // Non-uploadId strings that still fit the route shape are rejected by the params schema.
    for (const evil of ["image.png", "uploads_etc_passwd", "img_short", "just-a-name"]) {
      const response = await evidenceUrl(user, claim.id, evil);
      expect(response.status).toBe(400);
    }
    // Path-shaped arbitrary keys never even route (extra segments / traversal) → 404, so no
    // client-supplied S3 path can reach the signed-URL generator.
    const traversal = await evidenceUrl(user, claim.id, "uploads/../../etc/passwd");
    expect(traversal.status).toBe(404);
    // A well-formed but never-issued upload id is simply not found.
    const unknown = await evidenceUrl(
      user,
      claim.id,
      "img_00000000-0000-4000-8000-0000000000aa"
    );
    expect(unknown.status).toBe(404);
  });

  it("P3-15: the evidence rate limit returns 429 exactly at its configured limit", async () => {
    const user = sub("rate-limit");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ratelimit-15");
    const body = { contentType: "image/png", size: 100 };
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      lastStatus = (await presignEvidence(user, claim.id, body)).status;
    }
    expect(lastStatus).toBe(200);
    const blocked = await presignEvidence(user, claim.id, body);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe("Too many requests, please try again later.");
    expect(blocked.headers["ratelimit-limit"]).toBe("6");
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
  });

  it("P3-16: evidence mutations append-only audit rows (presigned/completed/deleted, requestId, no storage internals)", async () => {
    const user = sub("audit");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-audit-16");
    const { uploadId } = await presignPutComplete(user, claim.id);
    await deleteEvidence(user, claim.id, uploadId);

    expect(await auditCount(claim.id, "evidence_presigned")).toBe(1);
    expect(await auditCount(claim.id, "evidence_completed")).toBe(1);
    expect(await auditCount(claim.id, "evidence_deleted")).toBe(1);
    const rows = await ClaimAudit.find({ claimId: claim.id }).sort({ createdAt: 1 });
    expect(rows.map((r) => r.action)).toEqual([
      "created",
      "evidence_presigned",
      "evidence_completed",
      "evidence_deleted",
    ]);
    for (const row of rows) {
      expect(row.actor).toBe("farmer");
      if (row.action.startsWith("evidence")) {
        expect(row.requestId).toBeTruthy();
        expect(row.metadata).not.toHaveProperty("s3Key");
        expect(row.metadata).not.toHaveProperty("s3Bucket");
        expect(row.metadata).not.toHaveProperty("cognitoSub");
        expect(row.metadata).toHaveProperty("uploadId");
      }
    }
    // Audit rows are never returned to clients in any claim response shape.
    const detail = await api().get(`/claims/${claim.id}`).set(authHeader(user));
    expect(detail.body.data.claim).not.toHaveProperty("audit");
  });

  it("P3-17: submission without evidence remains allowed — the Phase 2 contract is preserved, and client evidenceUploaded is never trusted", async () => {
    const user = sub("no-evidence-submit");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-noev-17");
    const response = await api()
      .post(`/claims/${claim.id}/submit`)
      .set(authHeader(user))
      .send({ evidenceUploaded: true, submitted: true }); // body ignored
    expect(response.status).toBe(200);
    expect(response.body.data.claim.state).toBe("submitted");
    expect(await ClaimEvidence.countDocuments({ claimId: claim.id })).toBe(0);
    // There is still no way for the client to mark evidence as uploaded: evidence status is
    // server-derived from persisted ClaimEvidence rows only.
    const detail = await api().get(`/claims/${claim.id}`).set(authHeader(user));
    expect(detail.body.data.claim.evidence).toEqual([]);
  });
});