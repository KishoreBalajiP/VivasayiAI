import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import FarmProfile from "../models/FarmProfile.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { calculateParcelAreaAcres } from "../services/parcelGeometry.service.js";
import { putObject } from "../services/s3.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// F-49 (ADR-019) — Agricultural Loss Claim Phase 2 integration suite.
// Scenarios are numbered 1..58 mirroring the Phase 2 test plan grouping:
// Model (1-6) / Creation (7-16) / Idempotency (17-19) / Ownership (20-24) / State machine
// (25-32) / Submit (33-39) / Evidence (40-45) / Withdraw (46-50) / Legacy (51-53) / Security (54-58).

const sub = (name) => `test-claims-${name}`;
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

const createClaim = (user, body) => api().post("/claims").set(authHeader(user)).send(body);

const createClaimOk = async (user, parcelId, idempotencyKey, overrides = {}) => {
  const response = await createClaim(user, claimBody(parcelId, idempotencyKey, overrides));
  expect(response.status).toBe(200);
  return response.body.data.claim;
};

const setClaimState = (claimId, state) =>
  LossClaim.updateOne({ _id: claimId }, { $set: { state } });
const setClaimDate = (claimId, date) =>
  LossClaim.updateOne({ _id: claimId }, { $set: { eventDate: date } });
const setClaimGeometry = (claimId, coordinates) =>
  LossClaim.updateOne({ _id: claimId }, { $set: { "claimedGeometry.coordinates": coordinates } });

const auditCount = async (claimId, action) =>
  ClaimAudit.countDocuments({ claimId, action });

const presignEvidence = (user, claimId, body) =>
  api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send(body);

const completeEvidence = (user, claimId, uploadId) =>
  api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));

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
  const complete = await completeEvidence(user, claimId, uploadId);
  return { presign, complete, uploadId };
};

describe("agricultural loss claim — Phase 2", () => {
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

  // ------------------------------------------------------------------ MODEL (1-6)
  it("1: lossclaim exposes the 10-state enum and 7-event enum", () => {
    expect(LossClaim.schema.path("state").enumValues).toHaveLength(10);
    expect(LossClaim.schema.path("eventType").enumValues).toEqual([
      "flood",
      "storm",
      "drought",
      "pest",
      "disease",
      "fire",
      "other",
    ]);
  });

  it("2: persists a claim with defaults (state draft, null timestamps, evidence [])", async () => {
    const parcel = await seedParcel(sub("model-default"));
    const claim = await LossClaim.create({
      cognitoSub: sub("model-default"),
      profileId: new FarmProfile({})._id,
      parcelId: parcel.parcelId,
      parcelSnapshot: { parcelId: parcel.parcelId, crop: "Paddy", parcelAreaAcres: parcel.calculatedAreaAcres },
      eventType: "flood",
      eventDate: new Date(),
      claimedGeometry: squareGeometry(0.009),
      claimedAreaAcres: calculateParcelAreaAcres(squareGeometry(0.009)),
    });
    expect(claim.state).toBe("draft");
    expect(claim.evidence).toEqual([]);
    expect(claim.submittedAt).toBeNull();
    expect(claim.processedAt).toBeNull();
    expect(claim.decidedAt).toBeNull();
    expect(claim.createdAt).toBeTruthy();
  });

  it("3: rejects an unknown eventType at the model layer", async () => {
    const parcel = await seedParcel(sub("model-event"));
    await expect(
      LossClaim.create({
        cognitoSub: sub("model-event"),
        profileId: new FarmProfile({})._id,
        parcelId: parcel.parcelId,
        parcelSnapshot: { parcelId: parcel.parcelId, crop: null, parcelAreaAcres: 1 },
        eventType: "hail",
        eventDate: new Date(),
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: calculateParcelAreaAcres(squareGeometry(0.009)),
      })
    ).rejects.toThrow();
  });

  it("4: rejects a negative server-calculated area at the model layer", async () => {
    const parcel = await seedParcel(sub("model-area"));
    await expect(
      LossClaim.create({
        cognitoSub: sub("model-area"),
        profileId: new FarmProfile({})._id,
        parcelId: parcel.parcelId,
        parcelSnapshot: { parcelId: parcel.parcelId, crop: null, parcelAreaAcres: 1 },
        eventType: "flood",
        eventDate: new Date(),
        claimedGeometry: squareGeometry(0.009),
        claimedAreaAcres: -1,
      })
    ).rejects.toThrow();
  });

  it("5: evidence refs default to [] and accept ClaimEvidence ObjectIds", async () => {
    const parcel = await seedParcel(sub("model-evidence"));
    const ev = await ClaimEvidence.create({
      claimId: new LossClaim({})._id,
      uploadId: "img_00000000-0000-4000-8000-000000000001",
      s3Key: "uploads/claims/x/img_1/image.png",
      mediaType: "image/png",
      size: 10,
      status: "pending",
    });
    const claim = await LossClaim.create({
      cognitoSub: sub("model-evidence"),
      profileId: new FarmProfile({})._id,
      parcelId: parcel.parcelId,
      parcelSnapshot: { parcelId: parcel.parcelId, crop: null, parcelAreaAcres: 1 },
      eventType: "flood",
      eventDate: new Date(),
      claimedGeometry: squareGeometry(0.009),
      claimedAreaAcres: calculateParcelAreaAcres(squareGeometry(0.009)),
    });
    claim.evidence.push(ev._id);
    await claim.save();
    const reloaded = await LossClaim.findById(claim._id);
    expect(reloaded.evidence).toEqual([ev._id]);
  });

  it("6: idempotencyKey uniqueness is owner-scoped (same key allowed across users)", async () => {
    const key = "idem-model-unique-key";
    const parcel = await seedParcel(sub("model-idem"));
    const base = {
      profileId: new FarmProfile({})._id,
      parcelId: parcel.parcelId,
      parcelSnapshot: { parcelId: parcel.parcelId, crop: null, parcelAreaAcres: 1 },
      eventType: "flood",
      eventDate: new Date(),
      claimedGeometry: squareGeometry(0.009),
      claimedAreaAcres: calculateParcelAreaAcres(squareGeometry(0.009)),
    };
    await LossClaim.create({ ...base, cognitoSub: "owner-a", idempotencyKey: key });
    await expect(
      LossClaim.create({ ...base, cognitoSub: "owner-a", idempotencyKey: key })
    ).rejects.toMatchObject({ code: 11000 });
    // A different owner reusing the same key must NOT collide.
    const other = await LossClaim.create({ ...base, cognitoSub: "owner-b", idempotencyKey: key });
    expect(other.idempotencyKey).toBe(key);
  });

  // -------------------------------------------------------------- CREATION (7-16)
  it("7: creates a draft claim with server snapshot, computed area and clean serialization", async () => {
    const user = sub("create-ok");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-create-ok-07");

    expect(claim.state).toBe("draft");
    expect(claim.id).toBeTruthy();
    expect(claim.parcelId).toBe(parcel.parcelId);
    expect(claim.parcelSnapshot.parcelId).toBe(parcel.parcelId);
    expect(claim.eventType).toBe("flood");
    expect(claim.claimedGeometry.type).toBe("Polygon");
    expect(claim.submittedAt).toBeNull();
    expect(claim.assessment).toBeNull();
    // private / authoritative-only fields are never serialized
    expect(claim).not.toHaveProperty("_id");
    expect(claim).not.toHaveProperty("cognitoSub");
    expect(claim).not.toHaveProperty("profileId");
    expect(claim).not.toHaveProperty("idempotencyKey");
  });

  it("8: claimedAreaAcres equals the server-computed area for the submitted geometry", async () => {
    const user = sub("create-area");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-create-area-08");
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(squareGeometry(0.009)));
    expect(claim.claimedAreaAcres).toBeGreaterThan(0);
  });

  it("9: parcelSnapshot captures the server-owned parcel fields (parcelId, name, crop, parcelAreaAcres)", async () => {
    const user = sub("create-snapshot");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-create-snap-09");
    expect(claim.parcelSnapshot).toEqual({
      parcelId: parcel.parcelId,
      name: "Claim field",
      crop: "Paddy",
      parcelAreaAcres: parcel.calculatedAreaAcres,
    });
  });

  it("10: client-supplied area is stripped — the server-computed value always wins (P4)", async () => {
    const user = sub("create-area-strip");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-create-strip-10", {
      claimedAreaAcres: 99999,
      area: 555,
    });
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(squareGeometry(0.009)));
    expect(claim.claimedAreaAcres).not.toBe(99999);
  });

  it("11: creating against an unknown parcel returns 404", async () => {
    const user = sub("create-404");
    await seedProfile(user);
    const response = await createClaim(user, claimBody("par_00000000-0000-4000-8000-000000000000", "idem-create-404"));
    expect(response.status).toBe(404);
  });

  it("12: creating against a foreign (not-owned) parcel returns 404", async () => {
    const alice = sub("create-foreign-a");
    const bob = sub("create-foreign-b");
    const bobParcel = await seedParcel(bob);
    const response = await createClaim(alice, claimBody(bobParcel.parcelId, "idem-foreign-12"));
    expect(response.status).toBe(404);
  });

  it("13: an invalid eventType is rejected with 400", async () => {
    const user = sub("create-eventtype");
    const parcel = await seedParcel(user);
    const response = await createClaim(user, claimBody(parcel.parcelId, "idem-eventtype-13", { eventType: "hail" }));
    expect(response.status).toBe(400);
  });

  it("14: a future event date is rejected with 400 (P2)", async () => {
    const user = sub("create-future");
    const parcel = await seedParcel(user);
    const response = await createClaim(user, claimBody(parcel.parcelId, "idem-future-14", {
      eventDate: daysAgo(-1),
    }));
    expect(response.status).toBe(400);
  });

  it("15: an event date outside the claim window is rejected with 400 (P2)", async () => {
    const user = sub("create-window");
    const parcel = await seedParcel(user);
    const response = await createClaim(user, claimBody(parcel.parcelId, "idem-window-15", {
      eventDate: daysAgo(31),
    }));
    expect(response.status).toBe(400);
  });

  it("16: an invalid idempotency key is rejected with 400", async () => {
    const user = sub("create-idem-invalid");
    const parcel = await seedParcel(user);
    const response = await createClaim(user, claimBody(parcel.parcelId, "", { idempotencyKey: "x" }));
    expect(response.status).toBe(400);
  });

  // ----------------------------------------------------------- IDEMPOTENCY (17-19)
  it("17: retrying the same idempotencyKey creates no duplicate claim", async () => {
    const user = sub("idem-retry");
    const parcel = await seedParcel(user);
    const first = await createClaimOk(user, parcel.parcelId, "idem-retry-key-17");
    const second = await createClaim(user, claimBody(parcel.parcelId, "idem-retry-key-17"));
    expect(second.status).toBe(200);
    expect(second.body.message).toBe("Claim already exists");
    expect(await LossClaim.countDocuments({ cognitoSub: user })).toBe(1);
  });

  it("18: a retried create returns the EXISTING claim (same id)", async () => {
    const user = sub("idem-same");
    const parcel = await seedParcel(user);
    const first = await createClaimOk(user, parcel.parcelId, "idem-same-key-18");
    const second = await createClaim(user, claimBody(parcel.parcelId, "idem-same-key-18"));
    expect(second.body.data.claim.id).toBe(first.id);
  });

  it("19: different users may reuse the same idempotencyKey without collision", async () => {
    const alice = sub("idem-alice");
    const bob = sub("idem-bob");
    const aliceParcel = await seedParcel(alice);
    const bobParcel = await seedParcel(bob);
    const a = await createClaimOk(alice, aliceParcel.parcelId, "idem-shared-key-19");
    const b = await createClaimOk(bob, bobParcel.parcelId, "idem-shared-key-19");
    expect(a.id).not.toBe(b.id);
    const bobList = await api().get("/claims").set(authHeader(bob));
    expect(bobList.body.data.claims).toHaveLength(1);
    expect(bobList.body.data.claims[0].id).toBe(b.id);
  });

  // ------------------------------------------------------------ OWNERSHIP (20-24)
  const seedPairWithClaims = async (aliceName, bobName) => {
    const alice = sub(aliceName);
    const bob = sub(bobName);
    const aliceParcel = await seedParcel(alice);
    const bobParcel = await seedParcel(bob);
    const aliceClaim = await createClaimOk(alice, aliceParcel.parcelId, `idem-${aliceName}`);
    const bobClaim = await createClaimOk(bob, bobParcel.parcelId, `idem-${bobName}`);
    return { alice, bob, aliceClaim, bobClaim };
  };

  it("20: claiming another user's claim via detail returns 404", async () => {
    const { alice, bobClaim } = await seedPairWithClaims("own-a", "own-b");
    const response = await api().get(`/claims/${bobClaim.id}`).set(authHeader(alice));
    expect(response.status).toBe(404);
  });

  it("21: submitting another user's claim returns 404", async () => {
    const { alice, bobClaim } = await seedPairWithClaims("submit-a", "submit-b");
    const response = await api().post(`/claims/${bobClaim.id}/submit`).set(authHeader(alice));
    expect(response.status).toBe(404);
  });

  it("22: presigning evidence on another user's claim returns 404", async () => {
    const { alice, bobClaim } = await seedPairWithClaims("ev-a", "ev-b");
    const response = await presignEvidence(alice, bobClaim.id, {
      contentType: "image/png",
      size: 100,
    });
    expect(response.status).toBe(404);
  });

  it("23: list only returns the caller's own claims", async () => {
    const { alice, aliceClaim, bob } = await seedPairWithClaims("list-a", "list-b");
    const response = await api().get("/claims").set(authHeader(alice));
    expect(response.body.data.claims).toHaveLength(1);
    expect(response.body.data.claims[0].id).toBe(aliceClaim.id);
    expect(await LossClaim.countDocuments({ cognitoSub: bob })).toBe(1); // bob unaffected
  });

  it("24: deleting evidence on another user's claim returns 404", async () => {
    const { alice, bobClaim } = await seedPairWithClaims("del-a", "del-b");
    const response = await api()
      .delete(`/claims/${bobClaim.id}/evidence/img_00000000-0000-4000-8000-000000000099`)
      .set(authHeader(alice));
    expect(response.status).toBe(404);
  });

  // ---------------------------------------------------------- STATE MACHINE (25-32)
  it("25: the client cannot set claim state — a state field in the body is ignored (draft)", async () => {
    const user = sub("sm-client-state");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-state-25", { state: "verified" });
    expect(claim.state).toBe("draft");
  });

  it("26: no draft-update (PATCH /claims/:id) endpoint exists — returns 404", async () => {
    const user = sub("sm-patch");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-patch-26");
    const response = await api()
      .patch(`/claims/${claim.id}`)
      .set(authHeader(user))
      .send({ eventType: "fire" });
    expect(response.status).toBe(404);
  });

  it("27: submitting a terminal (withdrawn) claim is rejected with 409", async () => {
    const user = sub("sm-terminal-submit");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-term-27");
    await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.status).toBe(409);
  });

  it("28: withdrawing from draft is legal, and the withdrawn claim can never be submitted", async () => {
    const user = sub("sm-withdraw-then");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-wd-28");
    const draw = await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    expect(draw.status).toBe(200);
    expect(draw.body.data.claim.state).toBe("withdrawn");
  });

  it("29: submitting from more_evidence_required is rejected — resubmit is the documented path", async () => {
    const user = sub("sm-mer-submit");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-mer-29");
    await setClaimState(claim.id, "more_evidence_required");
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.status).toBe(409);
  });

  it("30: resubmitting a submitted claim is rejected (only from more_evidence_required)", async () => {
    const user = sub("sm-resubmitted");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-resub-30");
    await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    const response = await api().post(`/claims/${claim.id}/resubmit`).set(authHeader(user));
    expect(response.status).toBe(409);
  });

  it("31: resubmitting from more_evidence_required → submitted is valid and audited", async () => {
    const user = sub("sm-resubmit-ok");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-resub31");
    await setClaimState(claim.id, "more_evidence_required");
    const response = await api().post(`/claims/${claim.id}/resubmit`).set(authHeader(user));
    expect(response.status).toBe(200);
    expect(response.body.data.claim.state).toBe("submitted");
    expect(await auditCount(claim.id, "resubmitted")).toBe(1);
  });

  it("32: resubmission hits the configured maximum and is rejected (P6)", async () => {
    const user = sub("sm-resubmit-max");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sm-resub32");
    await setClaimState(claim.id, "more_evidence_required");
    await ClaimAudit.create({
      claimId: claim.id,
      actor: "farmer",
      action: "resubmitted",
      fromState: "more_evidence_required",
      toState: "submitted",
    });
    await ClaimAudit.create({
      claimId: claim.id,
      actor: "farmer",
      action: "resubmitted",
      fromState: "more_evidence_required",
      toState: "submitted",
    });
    const response = await api().post(`/claims/${claim.id}/resubmit`).set(authHeader(user));
    expect(response.status).toBe(409);
    expect(response.body.message).toBe("Maximum resubmissions reached");
  });

  // ----------------------------------------------------------------- SUBMIT (33-39)
  it("33: submit transitions draft → submitted and stamps submittedAt", async () => {
    const user = sub("submit-ok");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-33");
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.status).toBe(200);
    expect(response.body.data.claim.state).toBe("submitted");
    expect(response.body.data.claim.submittedAt).toBeTruthy();
  });

  it("34: submit writes a farmer-scoped audit entry (action submitted)", async () => {
    const user = sub("submit-audit");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-34");
    await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    const audit = await ClaimAudit.findOne({ claimId: claim.id, action: "submitted" });
    expect(audit).toBeTruthy();
    expect(audit.actor).toBe("farmer");
    expect(audit.fromState).toBe("draft");
    expect(audit.toState).toBe("submitted");
  });

  it("35: the creation audit exists alongside a single submitted audit on retry-safe submit", async () => {
    const user = sub("submit-idem");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-35");
    const first = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    const second = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(first.body.data.claim.state).toBe("submitted");
    expect(second.body.message).toBe("Claim already submitted");
    expect(await auditCount(claim.id, "submitted")).toBe(1);
    expect(await auditCount(claim.id, "created")).toBe(1);
  });

  it("36: submit revalidates the event date (P2) and rejects an out-of-window claim", async () => {
    const user = sub("submit-revalidate-date");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-36");
    await setClaimDate(claim.id, daysAgo(31));
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("claim window");
  });

  it("37: submit revalidates the geometry (P4) and rejects a corrupted polygon", async () => {
    const user = sub("submit-revalidate-geom");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-37");
    const bowtie = [
      [0, 0], [0.01, 0.01], [0, 0.01], [0.01, 0], [0, 0],
    ];
    await setClaimGeometry(claim.id, [bowtie]);
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.status).toBe(400);
  });

  it("38: submit response keeps the clean serialization (no s3Key/idempotencyKey/authority fields)", async () => {
    const user = sub("submit-clean");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-38");
    const { presign } = await presignPutComplete(user, claim.id);
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.body.data.claim).not.toHaveProperty("profileId");
    expect(response.body.data.claim).not.toHaveProperty("idempotencyKey");
    expect(response.body.data.claim).not.toHaveProperty("cognitoSub");
    expect(presign.body.data).not.toHaveProperty("s3Key");
  });

  it("39: submit recomputes and re-stores the authoritative area for the stored geometry", async () => {
    const user = sub("submit-area");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-submit-39");
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(squareGeometry(0.009)));
    const response = await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    expect(response.body.data.claim.claimedAreaAcres).toBe(
      calculateParcelAreaAcres(squareGeometry(0.009))
    );
  });

  // --------------------------------------------------------------- EVIDENCE (40-45)
  it("40: presign accepts the allowed image types (jpeg/png/webp) with a scoped capability", async () => {
    const user = sub("ev-types");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ev-types-40");
    for (const contentType of ["image/jpeg", "image/png", "image/webp"]) {
      const response = await presignEvidence(user, claim.id, { contentType, size: 100 });
      expect(response.status).toBe(200);
      expect(response.body.data.uploadId).toMatch(/^img_/);
      expect(response.body.data.uploadUrl).toContain("mock-bucket.local");
      expect(response.body.data.expiresIn).toBe(300000);
    }
  });

  it("41: a non-image evidence type is rejected with 400", async () => {
    const user = sub("ev-non-image");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ev-nonimg-41");
    const response = await presignEvidence(user, claim.id, {
      contentType: "application/pdf",
      size: 100,
    });
    expect(response.status).toBe(400);
  });

  it("42: evidence lifecycle completes while the claim is draft (pending → stored)", async () => {
    const user = sub("ev-draft");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ev-draft-42");
    const { complete, uploadId } = await presignPutComplete(user, claim.id);
    expect(complete.status).toBe(200);
    expect(complete.body.data.evidence.status).toBe("stored");
    expect(complete.body.data.evidence.uploadedAt).toBeTruthy();
    expect(complete.body.data.evidence.width).toBeGreaterThan(0);
    const stored = await ClaimEvidence.findOne({ uploadId });
    expect(stored.status).toBe("stored");
  });

  it("43: evidence mutation is still allowed while the claim is submitted", async () => {
    const user = sub("ev-submitted");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ev-sub-43");
    await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    const response = await presignEvidence(user, claim.id, { contentType: "image/png", size: 100 });
    expect(response.status).toBe(200);
  });

  it("44: evidence mutation is allowed from more_evidence_required", async () => {
    const user = sub("ev-mer");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ev-mer-44");
    await setClaimState(claim.id, "more_evidence_required");
    const response = await presignEvidence(user, claim.id, { contentType: "image/png", size: 100 });
    expect(response.status).toBe(200);
  });

  it("45: evidence mutation is blocked once the claim reaches a terminal state", async () => {
    const user = sub("ev-terminal");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-ev-term-45");
    const { uploadId } = await presignPutComplete(user, claim.id);
    await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    const presign = await presignEvidence(user, claim.id, { contentType: "image/png", size: 100 });
    expect(presign.status).toBe(409);
    const complete = await completeEvidence(user, claim.id, uploadId);
    expect(complete.status).toBe(409);
    const remove = await api()
      .delete(`/claims/${claim.id}/evidence/${uploadId}`)
      .set(authHeader(user));
    expect(remove.status).toBe(409);
  });

  // ---------------------------------------------------------------- WITHDRAW (46-50)
  it("46: withdraw from draft → withdrawn with an audit entry", async () => {
    const user = sub("wd-draft");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-wd-draft-46");
    const response = await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    expect(response.status).toBe(200);
    expect(response.body.data.claim.state).toBe("withdrawn");
    const audit = await ClaimAudit.findOne({ claimId: claim.id, action: "withdrawn" });
    expect(audit.actor).toBe("farmer");
    expect(audit.fromState).toBe("draft");
    expect(audit.toState).toBe("withdrawn");
  });

  it("47: withdraw from submitted → withdrawn (legal transition)", async () => {
    const user = sub("wd-submitted");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-wd-sub-47");
    await api().post(`/claims/${claim.id}/submit`).set(authHeader(user));
    const response = await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    expect(response.status).toBe(200);
    expect(response.body.data.claim.state).toBe("withdrawn");
  });

  it("48: withdraw from a processing/terminal state is rejected with 409", async () => {
    const user = sub("wd-processing");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-wd-proc-48");
    await setClaimState(claim.id, "processing");
    const response = await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    expect(response.status).toBe(409);
  });

  it("49: a withdrawn claim's detail reports state withdrawn (get reflects the transition)", async () => {
    const user = sub("wd-detail");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-wd-detail-49");
    await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    const detail = await api().get(`/claims/${claim.id}`).set(authHeader(user));
    expect(detail.body.data.claim.state).toBe("withdrawn");
  });

  it("50: withdrawing an already-withdrawn claim is rejected (terminal is immutable)", async () => {
    const user = sub("wd-twice");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-wd-twice-50");
    await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    const response = await api().post(`/claims/${claim.id}/withdraw`).set(authHeader(user));
    expect(response.status).toBe(409);
  });

  // ------------------------------------------------------------------- LEGACY (51-53)
  it("51: root liveness and /health still respond unauthenticated", async () => {
    const root = await api().get("/");
    expect(root.status).toBe(200);
    const health = await api().get("/health");
    expect(health.status).toBe(200);
    expect(health.body.data.status).toBe("ok");
  });

  it("52: existing /profile (parcel) endpoints still function alongside /claims", async () => {
    const user = sub("legacy-profile");
    const parcel = await seedParcel(user);
    const list = await api().get("/profile").set(authHeader(user));
    expect(list.status).toBe(200);
    expect(list.body.data.profile.parcels).toHaveLength(1);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-legacy-52");
    expect(claim.state).toBe("draft");
  });

  it("53: the app still enforces auth across routes (401 without a token)", async () => {
    for (const target of ["/claims", "/profile", "/upload/presign", "/chatsessions/list"]) {
      const response = await api().get(target);
      expect(response.status).toBe(401);
    }
  });

  // ---------------------------------------------------------------- SECURITY (54-58)
  it("54: unauthenticated claim create and list are rejected with 401", async () => {
    const create = await api().post("/claims").send({});
    expect(create.status).toBe(401);
    const list = await api().get("/claims");
    expect(list.status).toBe(401);
  });

  it("55: claim endpoints carry the per-user rate-limit headers (claimLimiter/evidenceLimiter)", async () => {
    const user = sub("sec-ratelimit");
    await seedParcel(user);
    const list = await api().get("/claims").set(authHeader(user));
    // express-rate-limit standardHeaders (draft-6): RateLimit-Limit / RateLimit-Remaining.
    expect(list.headers["ratelimit-limit"]).toBeTruthy();
    expect(list.headers["ratelimit-remaining"]).toBeTruthy();
  });

  it("56: responses never leak storage internals (s3Key/bucket) or authority fields", async () => {
    const user = sub("sec-leak");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sec-leak-56");
    const { complete, uploadId } = await presignPutComplete(user, claim.id);
    expect(complete.body.data.evidence).not.toHaveProperty("s3Key");
    const detail = await api().get(`/claims/${claim.id}`).set(authHeader(user));
    expect(detail.body.data.claim.evidence[0].uploadId).toBe(uploadId);
    expect(detail.body.data.claim.evidence[0]).not.toHaveProperty("s3Key");
    const url = await api()
      .get(`/claims/${claim.id}/evidence/${uploadId}/url`)
      .set(authHeader(user));
    expect(url.status).toBe(200);
    expect(url.body.data.url).toContain("mock-bucket.local");
    expect(url.body.data.url).not.toContain("signature");
  });

  it("57: guessing a foreign claim id (detail + evidence url) returns 404 — IDOR-safe", async () => {
    const { alice, bobClaim } = await seedPairWithClaims("idor-a", "idor-b");
    const detail = await api().get(`/claims/${bobClaim.id}`).set(authHeader(alice));
    expect(detail.status).toBe(404);
    const url = await api()
      .get(`/claims/${bobClaim.id}/evidence/img_00000000-0000-4000-8000-000000000077/url`)
      .set(authHeader(alice));
    expect(url.status).toBe(404);
  });

  it("58: unexpected authority fields in the body are silently ignored", async () => {
    const user = sub("sec-unknown-fields");
    const parcel = await seedParcel(user);
    const claim = await createClaimOk(user, parcel.parcelId, "idem-sec-58", {
      state: "verified",
      claimedAreaAcres: 12345,
      cognitoSub: "attacker-999",
      profileId: "000000000000000000000000",
      submittedAt: new Date(),
    });
    expect(claim.state).toBe("draft");
    expect(claim.submittedAt).toBeNull();
    expect(claim.claimedAreaAcres).toBe(calculateParcelAreaAcres(squareGeometry(0.009)));
  });
});