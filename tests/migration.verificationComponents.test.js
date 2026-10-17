import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import AdminAction from "../models/AdminAction.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import LossClaim from "../models/LossClaim.js";
import User from "../models/User.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { migrate } from "../scripts/migrations/2026-10-verification-components.js";
import { releaseProcessingSlot } from "../services/claimVerification.service.js";
import { clearTestDatabase, startTestDatabase, stopTestDatabase, squareGeometry } from "./helpers.js";

// The migration brings an existing database up to the new data model. It must be safe to run twice
// and must not write anything in --dry-run mode.

const claimBase = (overrides = {}) => ({
  cognitoSub: "mig-user",
  profileId: new mongoose.Types.ObjectId(),
  parcelId: "par_mig",
  parcelSnapshot: { parcelId: "par_mig", crop: "Paddy", parcelAreaAcres: 1 },
  eventType: "flood",
  eventDate: new Date(),
  claimedGeometry: squareGeometry(0.009, [78, 10]),
  claimedAreaAcres: 0.5,
  state: "submitted",
  ...overrides,
});

// Insert a row the way the previous release stored it: no component, no kind.
const legacyEvidence = async (claimId, fields) => {
  const { insertedId } = await VerificationEvidence.collection.insertOne({
    claimId, status: "PENDING", createdAt: new Date(), updatedAt: new Date(), metadata: {}, ...fields,
  });
  return insertedId;
};

describe("verification components migration", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [LossClaim, ClaimAssessment, ClaimAudit, VerificationEvidence, VerificationJob, AdminAction]) await model.deleteMany({});
  });

  it("MG-1: backfills component and kind, telling documents, official rows and review cases apart", async () => {
    const claim = await LossClaim.create(claimBase());
    const doc = await legacyEvidence(claim._id, { source: "OWNERSHIP", idempotencyKey: "owndoc_abc12345" });
    const official = await legacyEvidence(claim._id, { source: "OWNERSHIP", idempotencyKey: "officialland_x1" });
    const review = await legacyEvidence(claim._id, { source: "OWNERSHIP", idempotencyKey: "review_x_OWNERSHIP_1700000000", metadata: { reviewRequired: true } });
    const sat = await legacyEvidence(claim._id, { source: "SATELLITE", idempotencyKey: "satellite_x1" });
    const geo = await legacyEvidence(claim._id, { source: "GEOMETRY", status: "AVAILABLE", idempotencyKey: "geometry_x1" });

    const { summary } = await migrate();
    expect(summary.evidenceUpdated).toBe(5);
    const get = (id) => VerificationEvidence.findById(id).lean();
    const documentRow = await get(doc);
    expect(documentRow.component).toBe("claimant_rights");
    expect(documentRow.kind).not.toBe("review_case");
    expect((await get(official)).component).toBe("claimant_rights");
    expect(await get(review)).toMatchObject({ component: "manual_review", kind: "review_case" });
    expect((await get(sat)).component).toBe("satellite");
    const geometry = await get(geo);
    expect(geometry.component).toBe("geometry");
    expect(geometry.metadata.legacyUnverified).toBe(true);
  });

  it("MG-2: backfills claim bounding boxes", async () => {
    const claim = await LossClaim.create(claimBase());
    await LossClaim.collection.updateOne({ _id: claim._id }, { $unset: { bbox: "" } });
    expect((await migrate()).summary.bboxBackfilled).toBe(1);
    expect((await LossClaim.findById(claim._id).lean()).bbox).toEqual({ minLon: 78, minLat: 10, maxLon: 78.009, maxLat: 10.009 });
  });

  it("MG-3: rebuilds the old adminactions and users indexes, and the new definitions then hold", async () => {
    await AdminAction.collection.dropIndex("claimId_1_idempotencyKey_1").catch(() => {});
    await AdminAction.collection.createIndex({ claimId: 1, idempotencyKey: 1 }, { unique: true, sparse: true, name: "claimId_1_idempotencyKey_1" });
    await User.collection.dropIndex("email_1").catch(() => {});
    await User.collection.createIndex({ email: 1 }, { unique: true, name: "email_1" });

    const dry = await migrate({ dryRun: true });
    expect(dry.summary.indexesRebuilt).toBe(2);
    expect((await AdminAction.collection.indexes()).find((i) => i.name === "claimId_1_idempotencyKey_1").sparse).toBe(true); // untouched

    expect((await migrate()).summary.indexesRebuilt).toBe(2);
    const adminIndex = (await AdminAction.collection.indexes()).find((i) => i.name === "claimId_1_idempotencyKey_1");
    expect(adminIndex.partialFilterExpression).toBeTruthy();
    expect(adminIndex.sparse).toBeUndefined();
    expect((await User.collection.indexes()).find((i) => i.name === "email_1").sparse).toBe(true);

    // The point of the change: two key-less actions on one claim no longer collide.
    const claimId = new mongoose.Types.ObjectId();
    const base = { claimId, action: "override", actorSub: "a", reason: "a long enough reason" };
    await AdminAction.create(base);
    await expect(AdminAction.create(base)).resolves.toBeTruthy();
  });

  it("MG-4: returns claims stuck in processing, leaves finished ones, and audits the release", async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const stuck = await LossClaim.create(claimBase({ state: "processing", processedAt: old, idempotencyKey: "k-stuck" }));
    const fresh = await LossClaim.create(claimBase({ state: "processing", processedAt: new Date(), idempotencyKey: "k-fresh" }));
    const finished = await LossClaim.create(claimBase({ state: "processing", processedAt: old, idempotencyKey: "k-done" }));
    await ClaimAssessment.create({ claimId: finished._id, state: "verified", verification: { status: "completed" } });

    expect((await migrate()).summary.claimsReleased).toBe(1);
    expect((await LossClaim.findById(stuck._id)).state).toBe("submitted");
    expect((await LossClaim.findById(fresh._id)).state).toBe("processing");
    expect((await LossClaim.findById(finished._id)).state).toBe("processing");
    expect(await ClaimAudit.countDocuments({ claimId: stuck._id, action: "verification_released" })).toBe(1);
  });

  it("MG-5: running twice changes nothing the second time", async () => {
    const claim = await LossClaim.create(claimBase({ state: "processing", processedAt: new Date(Date.now() - 3600000), idempotencyKey: "k-twice" }));
    await legacyEvidence(claim._id, { source: "SATELLITE", idempotencyKey: "satellite_t" });
    await migrate();
    const second = (await migrate()).summary;
    expect(second).toMatchObject({ evidenceUpdated: 0, bboxBackfilled: 0, indexesRebuilt: 0, claimsReleased: 0 });
  });

  it("MG-6: --dry-run writes nothing", async () => {
    const claim = await LossClaim.create(claimBase({ state: "processing", processedAt: new Date(Date.now() - 3600000), idempotencyKey: "k-dry" }));
    const row = await legacyEvidence(claim._id, { source: "SATELLITE", idempotencyKey: "satellite_d" });
    await LossClaim.collection.updateOne({ _id: claim._id }, { $unset: { bbox: "" } });
    const { summary } = await migrate({ dryRun: true });
    expect(summary.evidenceUpdated).toBe(1);
    expect(summary.claimsReleased).toBe(1);
    expect((await VerificationEvidence.findById(row).lean()).component).toBeFalsy();
    expect((await LossClaim.findById(claim._id)).state).toBe("processing");
    expect((await LossClaim.findById(claim._id).lean()).bbox?.minLon).toBeUndefined();
  });

  it("MG-7: --enqueue queues an engine job only for undecided submitted claims", async () => {
    const waiting = await LossClaim.create(claimBase({ idempotencyKey: "k-wait" }));
    const decided = await LossClaim.create(claimBase({ idempotencyKey: "k-decided" }));
    await ClaimAssessment.create({ claimId: decided._id, state: "verified", verification: { status: "completed" } });
    expect((await migrate({ enqueueEngine: true })).summary.jobsEnqueued).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId: waiting._id, step: "engine" })).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId: decided._id })).toBe(0);
  });

  it("MG-8: releaseProcessingSlot only releases a claim that is still locked", async () => {
    const locked = await LossClaim.create(claimBase({ state: "processing", idempotencyKey: "k-lock" }));
    const decided = await LossClaim.create(claimBase({ state: "verified", idempotencyKey: "k-verified" }));
    expect(await releaseProcessingSlot({ claimId: locked._id, reason: "test release" })).toBe(true);
    expect(await releaseProcessingSlot({ claimId: decided._id, reason: "test release" })).toBe(false);
    expect((await LossClaim.findById(decided._id)).state).toBe("verified");
  });
});

describe("components migration — remote write guard (audit B-D2)", () => {
  it("MG-9: a write run against a database not on this machine is refused; dry runs and local writes are allowed", async () => {
    const { assertWriteAllowed } = await import("../scripts/migrations/2026-10-verification-components.js");
    const atlas = "mongodb+srv://user:secret@cluster0.example.invalid/vivasayi";
    const remote = "mongodb://db.example.invalid:27017/vivasayi";
    const local = "mongodb://127.0.0.1:27017/vivasayi";
    expect(() => assertWriteAllowed({ dryRun: false, mongoUri: atlas, environment: {} })).toThrow(/Refusing to write/);
    expect(() => assertWriteAllowed({ dryRun: false, mongoUri: remote, environment: {} })).toThrow(/Refusing to write/);
    expect(() => assertWriteAllowed({ dryRun: true, mongoUri: atlas, environment: {} })).not.toThrow();
    expect(() => assertWriteAllowed({ dryRun: false, mongoUri: local, environment: {} })).not.toThrow();
    expect(() => assertWriteAllowed({ dryRun: false, mongoUri: atlas, environment: { MIGRATION_ALLOW_REMOTE_APPLY: "true" } })).not.toThrow();
  });
});
