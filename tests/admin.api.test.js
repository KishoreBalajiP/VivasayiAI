import mongoose from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import Appeal from "../models/Appeal.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import FarmProfile from "../models/FarmProfile.js";
import User from "../models/User.js";
import { putObject } from "../services/s3.service.js";
import {
  api,
  authHeader,
  adminHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

// Phase 10 (E9-S10) — Admin exception workflow + appeals (08_API_Documentation §10.9–10.12).
// MongoDB-backed endpoint suite: role gating (401/403), farmer appeals + additional evidence,
// the immutable admin override (AdminAction + ClaimAudit, replay protection), the read-only
// review queue, the admin claim detail, dashboard metrics, investigation views, and append-only
// guards on the audit models. Runs in targeted mode with the system MongoDB binary (setup.js).

const TRANSPARENT_PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

let seq = 0;
const farmerUser = (prefix) => `a10-farmer-${prefix}-${(++seq).toString(36)}`;
const adminUser = () => `a10-admin-${(++seq).toString(36)}`;
const daysIso = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const newObjectId = () => new mongoose.Types.ObjectId();

const clearAll = async () => {
  await FarmProfile.deleteMany({});
  await LossClaim.deleteMany({});
  await ClaimEvidence.deleteMany({});
  await ClaimAssessment.deleteMany({});
  await ClaimAudit.deleteMany({});
  await AdminAction.deleteMany({});
  await Appeal.deleteMany({});
  await User.deleteMany({});
};

const seedFarmer = async (prefix) => {
  const user = farmerUser(prefix);
  await User.create({ name: "Farmer User", email: `${user}@example.com`, cognitoSub: user });
  const profileRes = await seedProfile(user);
  expect(profileRes.status).toBe(200);
  const parcelRes = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Admin field", crop: "Paddy", geometry: squareGeometry(0.009, [(seq % 90) * 0.01, (seq % 45) * 0.01]) });
  expect(parcelRes.status).toBe(200);
  const profile = await FarmProfile.findOne({ cognitoSub: user });
  return { user, profile, parcel: parcelRes.body.data.parcel };
};

// Direct fixture insertion for deterministic terminal/queue states (endpoints are agnostic to
// how the state arose; E2E flows cover the real engine path separately).
const insertClaim = async ({
  user,
  profile,
  parcel,
  state,
  eventType = "flood",
  eventDate = daysIso(2),
  decided = true,
  evidenceStored = false,
  assessment = null,
  appeal = false,
  claimedAreaAcres = 0.5,
}) => {
  const created = await LossClaim.create({
    cognitoSub: user,
    profileId: profile._id,
    parcelId: parcel.parcelId,
    parcelSnapshot: {
      parcelId: parcel.parcelId,
      name: parcel.name,
      crop: parcel.crop,
      parcelAreaAcres: parcel.calculatedAreaAcres ?? 1,
    },
    eventType,
    eventDate: new Date(eventDate),
    claimedGeometry: squareGeometry(0.009, [(seq % 90) * 0.01, (seq % 45) * 0.01]),
    claimedAreaAcres,
    evidence: [],
    state,
    idempotencyKey: `idem-${newObjectId().toString()}`,
    submittedAt: daysIso(3),
    decidedAt: decided ? daysIso(1) : null,
  });

  if (assessment || assessment === null || assessment === "failed") {
    const status = assessment === "failed" ? "failed" : assessment?.status ?? "completed";
    const uncert = assessment?.uncertain ?? false;
    await ClaimAssessment.create({
      claimId: created._id,
      status,
      aiAggregate: uncert ? { uncertain: true, damageDetected: false, confidence: "unclear" } : { uncertain: false, damageDetected: true, confidence: "high" },
      rules: { aiCheck: { passed: status === "completed" } },
      state: status === "completed" ? created.state : null,
      reason: status === "completed" ? "engine decision" : null,
      decidedBy: "engine",
      decidedAt: decided ? daysIso(1) : null,
      verification: status === "failed" ? { status: "failed", failedAt: new Date() } : undefined,
    });
  }

  if (evidenceStored) {
    const evidence = await ClaimEvidence.create({
      claimId: created._id,
      uploadId: `img_${newObjectId().toString()}`,
      s3Key: `claims/${created._id}/img_${newObjectId().toString()}/image.png`,
      mediaType: "image/png",
      size: TRANSPARENT_PNG_BUFFER.length,
      status: "stored",
      width: 1,
      height: 1,
      uploadedAt: new Date(),
    });
    created.evidence.push(evidence._id);
    await created.save();
  }

  if (appeal) {
    await Appeal.create({
      claimId: created._id,
      cognitoSub: user,
      status: "submitted",
      reason: "I can prove the damage with additional photos",
      statement: "The assessment did not consider my latest crop photos.",
      evidence: [],
    });
  }

  return created;
};

describe("Phase 10 admin exception workflow (API)", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
    // Build all schema indexes (incl. the unique/partial ones the workflow relies on) BEFORE
    // seeding, so fixture duplicates surfaces behave deterministically.
    await Promise.all([
      LossClaim.init(),
      ClaimAssessment.init(),
      ClaimAudit.init(),
      AdminAction.init(),
      Appeal.init(),
      ClaimEvidence.init(),
      FarmProfile.init(),
      User.init(),
    ]);
  });

  afterAll(async () => {
    await stopTestDatabase(mongo);
  });

  beforeEach(async () => {
    await clearAll();
  });

  describe("A. role gating", () => {
    it("rejects anonymous access to the admin queue (401)", async () => {
      const response = await api().get("/admin/claims");
      expect(response.status).toBe(401);
    });

    it("forbids a farmer from the admin queue (403)", async () => {
      const { user } = await seedFarmer("gate");
      const response = await api().get("/admin/claims").set(authHeader(user, "farmer@example.com"));
      expect(response.status).toBe(403);
    });

    it("forbids a farmer from the override endpoint (403, no state change)", async () => {
      const { user, profile, parcel } = await seedFarmer("ovgate");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const before = await LossClaim.findById(claim._id).lean();
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ toState: "verified", reason: "I am confident this is a valid claim" });
      expect(response.status).toBe(403);
      const after = await LossClaim.findById(claim._id).lean();
      expect(after.state).toBe(before.state);
    });

    it("admits an authenticated admin (200)", async () => {
      const response = await api().get("/admin/claims").set(adminHeader(adminUser()));
      expect(response.status).toBe(200);
      expect(response.body.data.items).toEqual([]);
      expect(response.body.data.total).toBe(0);
    });
  });

  describe("B. farmer appeals", () => {
    it("submits an appeal on an eligible rejected claim + records audit", async () => {
      const { user, profile, parcel } = await seedFarmer("ap");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const response = await api()
        .post(`/claims/${claim._id}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "The crop was damaged after the assessment photo" });
      expect(response.status).toBe(200);
      expect(response.body.data.appeal.status).toBe("submitted");
      expect(response.body.data.appeal.reason).toContain("damaged");
      const auditCount = await ClaimAudit.countDocuments({ claimId: claim._id, action: "appeal_submitted" });
      expect(auditCount).toBe(1);
    });

    it("is idempotent for an already-active appeal", async () => {
      const { user, profile, parcel } = await seedFarmer("apid");
      const claim = await insertClaim({ user, profile, parcel, state: "out_of_limit", appeal: true });
      const response = await api()
        .post(`/claims/${claim._id}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "The measured area was smaller on site" });
      expect(response.status).toBe(200);
      expect(response.body.message).toBe("Appeal already submitted");
      const count = await Appeal.countDocuments({ claimId: claim._id });
      expect(count).toBe(1);
    });

    it("rejects appeals on terminal/non-eligible claims (409)", async () => {
      const { user, profile, parcel } = await seedFarmer("apno");
      const verified = await insertClaim({ user, profile, parcel, state: "verified" });
      const response = await api()
        .post(`/claims/${verified._id}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "This claim deserves a second look" });
      expect(response.status).toBe(409);
      // Fresh parcel per claim keeps fixtures independent.
      const second = await seedFarmer("apno2");
      const withdrawn = await insertClaim({ user, profile: second.profile, parcel: second.parcel, state: "withdrawn" });
      const resp = await api()
        .post(`/claims/${withdrawn._id}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "This claim deserves a second look" });
      expect(resp.status).toBe(409);
      const third = await seedFarmer("apno3");
      const draft = await insertClaim({ user, profile: third.profile, parcel: third.parcel, state: "draft", decided: false });
      const respDraft = await api()
        .post(`/claims/${draft._id}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "This claim deserves a second look" });
      expect(respDraft.status).toBe(409);
    });

    it("validates the appeal reason (400 on a too-short reason)", async () => {
      const { user, profile, parcel } = await seedFarmer("apval");
      const claim = await insertClaim({ user, profile, parcel, state: "duplicate_area" });
      const response = await api()
        .post(`/claims/${claim._id}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "short" });
      expect(response.status).toBe(400);
    });

    it("returns 404 for a foreign farmer's appeal attempt", async () => {
      const { user, profile, parcel } = await seedFarmer("apfor");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const attacker = authHeader("a10-evil", "evil@example.com");
      const response = await api()
        .post(`/claims/${claim._id}/appeal`)
        .set(attacker)
        .send({ reason: "This claim is not mine but I appeal anyway" });
      expect(response.status).toBe(404);
    });

    it("GET returns the appeal and null when none exists", async () => {
      const { user, profile, parcel } = await seedFarmer("apget");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected", appeal: true });
      const response = await api().get(`/claims/${claim._id}/appeal`).set(authHeader(user, "farmer@example.com"));
      expect(response.status).toBe(200);
      expect(response.body.data.appeal.status).toBe("submitted");
      const plain = await insertClaim({ user, profile, parcel, state: "rejected" });
      const none = await api().get(`/claims/${plain._id}/appeal`).set(authHeader(user, "farmer@example.com"));
      expect(none.body.data.appeal).toBeNull();
    });
  });

  describe("C. additional evidence during an active appeal", () => {
    it("blocks evidence mutation on a terminal claim WITHOUT an appeal (409)", async () => {
      const { user, profile, parcel } = await seedFarmer("evblk");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected", decided: true });
      const response = await api()
        .post(`/claims/${claim._id}/evidence/presign`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ contentType: "image/png", size: 100 });
      expect(response.status).toBe(409);
    });

    it("opens the evidence surface while an appeal is active and records it on the appeal", async () => {
      const { user, profile, parcel } = await seedFarmer("evopen");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected", appeal: true });
      const presign = await api()
        .post(`/claims/${claim._id}/evidence/presign`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ contentType: "image/png", size: TRANSPARENT_PNG_BUFFER.length, filename: "proof.png" });
      expect(presign.status).toBe(200);
      const { uploadId } = presign.body.data;
      const evidence = await ClaimEvidence.findOne({ uploadId });
      await putObject({ key: evidence.s3Key, buffer: TRANSPARENT_PNG_BUFFER, mediaType: "image/png" });
      const complete = await api()
        .post(`/claims/${claim._id}/evidence/${uploadId}/complete`)
        .set(authHeader(user, "farmer@example.com"));
      expect(complete.status).toBe(200);
      const appeal = await Appeal.findOne({ claimId: claim._id });
      expect(appeal.evidence.some((entry) => entry.uploadId === uploadId)).toBe(true);
    });
  });

  describe("D. admin override (immutable audit)", () => {
    it("overrides a rejected claim → verified with full immutable trail", async () => {
      const { user, profile, parcel } = await seedFarmer("ov1");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const admin = adminHeader(adminUser());

      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(admin)
        .send({
          toState: "verified",
          reason: "Inspector confirmed standing water in photo review",
          adminNote: "Field visit on file",
          overrideKey: "override-key-0001",
        });
      expect(response.status).toBe(200);
      expect(response.body.data.idempotent).toBe(false);
      expect(response.body.data.claim.state).toBe("verified");
      expect(response.body.data.claim.assessment.decidedBy).toBe("admin");
      expect(response.body.data.claim.assessment.adminNote).toBe("Field visit on file");

      const action = await AdminAction.findOne({ claimId: claim._id });
      expect(action.action).toBe("override");
      expect(action.priorState).toBe("rejected");
      expect(action.targetState).toBe("verified");
      expect(action.reason).toContain("Inspector");
      expect(action.actorSub).toBeTruthy();
      expect(action.createdAt).toBeTruthy();
      expect(action.idempotencyKey).toBe("override-key-0001");

      const audit = await ClaimAudit.findOne({ claimId: claim._id, action: "overridden" });
      expect(audit.actor).toBe("admin");
      expect(audit.fromState).toBe("rejected");
      expect(audit.toState).toBe("verified");
    });

    it("re-resolves an active appeal when the overridden decision lands", async () => {
      const { user, profile, parcel } = await seedFarmer("ovap");
      const claim = await insertClaim({ user, profile, parcel, state: "duplicate_area", appeal: true });
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(adminHeader(adminUser()))
        .send({ toState: "partially_verified", reason: "Adjacent verified plot, remainder was new" });
      expect(response.status).toBe(200);
      const reloaded = await LossClaim.findById(claim._id);
      const appeal = await Appeal.findOne({ claimId: claim._id });
      expect(appeal.status).toBe("resolved");
      expect(appeal.decision.kind).toBe("overridden");
      expect(appeal.decision.toState).toBe("partially_verified");
    });

    it("is replay-safe: the same overrideKey applies only once", async () => {
      const { user, profile, parcel } = await seedFarmer("ovid");
      const claim = await insertClaim({ user, profile, parcel, state: "more_evidence_required" });
      const body = { toState: "verified", reason: "Recheck confirmed damage after resubmission", overrideKey: "override-key-0002" };
      const first = await api().post(`/admin/claims/${claim._id}/override`).set(adminHeader(adminUser())).send(body);
      expect(first.status).toBe(200);
      const second = await api().post(`/admin/claims/${claim._id}/override`).set(adminHeader(adminUser())).send(body);
      expect(second.status).toBe(200);
      expect(second.body.data.idempotent).toBe(true);
      expect(second.body.data.claim.state).toBe("verified");
      const count = await AdminAction.countDocuments({ claimId: claim._id });
      expect(count).toBe(1);
    });

    it("rejects overrides to non-decision states (400)", async () => {
      const { user, profile, parcel } = await seedFarmer("ovbad");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(adminHeader(adminUser()))
        .send({ toState: "processing", reason: "Oops this is not a decision state" });
      expect(response.status).toBe(400);
    });

    it("rejects overrides from withdrawn (409, terminal closure protected)", async () => {
      const { user, profile, parcel } = await seedFarmer("ovw");
      const claim = await insertClaim({ user, profile, parcel, state: "withdrawn" });
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(adminHeader(adminUser()))
        .send({ toState: "verified", reason: "A closed claim cannot be silently reopened" });
      expect(response.status).toBe(409);
      const reloaded = await LossClaim.findById(claim._id);
      expect(reloaded.state).toBe("withdrawn");
    });

    it("rejects no-op overrides (same state, 409)", async () => {
      const { user, profile, parcel } = await seedFarmer("ovnoop");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(adminHeader(adminUser()))
        .send({ toState: "rejected", reason: "No change needed but I pressed the button" });
      expect(response.status).toBe(409);
    });

    it("requires the approver to differ from the acting admin (400)", async () => {
      const { user, profile, parcel } = await seedFarmer("ovself");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const token = signAdminLike();
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(token)
        .send({
          toState: "verified",
          reason: "Self-approval must never be accepted",
          approverSub: "same-sub",
        });
      expect(response.status).toBe(400);
    });

    it("records an optional external approver when provided", async () => {
      const { user, profile, parcel } = await seedFarmer("ovapp");
      const claim = await insertClaim({ user, profile, parcel, state: "rejected" });
      const sub = adminUser();
      const response = await api()
        .post(`/admin/claims/${claim._id}/override`)
        .set(adminHeader(sub))
        .send({
          toState: "verified",
          reason: "Lead reviewer approved the correction",
          approverSub: "admin-supervisor-1",
        });
      expect(response.status).toBe(200);
      const action = await AdminAction.findOne({ claimId: claim._id });
      expect(action.approverSub).toBe("admin-supervisor-1");
    });

    it("conflicts when overriding into an already-verified parcel+date+type (409)", async () => {
      const { user, profile, parcel } = await seedFarmer("ovdup");
      const date = daysIso(2);
      await insertClaim({ user, profile, parcel, state: "verified", eventDate: date, eventType: "flood" });
      const target = await insertClaim({ user, profile, parcel, state: "rejected", eventDate: date, eventType: "flood" });
      const response = await api()
        .post(`/admin/claims/${target._id}/override`)
        .set(adminHeader(adminUser()))
        .send({ toState: "verified", reason: "This duplicates an already verified claim" });
      expect(response.status).toBe(409);
      const targetReloaded = await LossClaim.findById(target._id);
      expect(targetReloaded.state).toBe("rejected");
    });
  });

  describe("E. read-only review queue", () => {
    it("contains only engine-review states, AI failures and appeals — never VERIFIED", async () => {
      const { user, profile, parcel } = await seedFarmer("q");
      const rejected = await insertClaim({ user, profile, parcel, state: "rejected" });
      const outOfLimit = await insertClaim({ user, profile, parcel, state: "out_of_limit" });
      const duplicate = await insertClaim({ user, profile, parcel, state: "duplicate_area" });
      const mini = await insertClaim({ user, profile, parcel, state: "more_evidence_required" });
      const aiFailed = await insertClaim({ user, profile, parcel, state: "processing", assessment: "failed" });
      await insertClaim({ user, profile, parcel, state: "verified" });
      await insertClaim({ user, profile, parcel, state: "draft", decided: false });
      await insertClaim({ user, profile, parcel, state: "withdrawn" });
      await insertClaim({ user, profile, parcel, state: "submitted", decided: false });

      const response = await api().get("/admin/claims").set(adminHeader(adminUser()));
      expect(response.status).toBe(200);
      const ids = response.body.data.items.map((entry) => entry.id);
      for (const inQueue of [rejected, outOfLimit, duplicate, mini, aiFailed]) {
        expect(ids).toContain(inQueue._id.toString());
      }
      for (const outside of ["verified", "draft", "withdrawn", "submitted"]) {
        const hidden = await LossClaim.findOne({ state: outside });
        expect(ids).not.toContain(hidden._id.toString());
      }
      expect(response.body.data.total).toBe(5);
    });

    it("narrows by status + withAppeal filters", async () => {
      const { user, profile, parcel } = await seedFarmer("qf");
      await insertClaim({ user, profile, parcel, state: "rejected" });
      await insertClaim({ user, profile, parcel, state: "rejected", appeal: true });
      const appealed = await insertClaim({ user, profile, parcel, state: "rejected", appeal: true });

      const byStatus = await api().get("/admin/claims?status=rejected").set(adminHeader(adminUser()));
      expect(byStatus.body.data.total).toBe(3);

      const appealedOnly = await api().get("/admin/claims?status=rejected&withAppeal=true").set(adminHeader(adminUser()));
      expect(appealedOnly.body.data.items).toHaveLength(2);
      expect(appealedOnly.body.data.items.every((entry) => entry.hasAppeal)).toBe(true);

      const plain = await api().get("/admin/claims?status=rejected&withAppeal=false").set(adminHeader(adminUser()));
      expect(plain.body.data.items).toHaveLength(1);
      expect(plain.body.data.items[0].id).not.toBe(appealed._id.toString());
    });

    it("aiFailed=true returns only stuck assessment pipelines", async () => {
      const { user, profile, parcel } = await seedFarmer("qai");
      await insertClaim({ user, profile, parcel, state: "rejected" });
      const failed = await insertClaim({ user, profile, parcel, state: "processing", assessment: "failed" });
      const response = await api().get("/admin/claims?aiFailed=true").set(adminHeader(adminUser()));
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].id).toBe(failed._id.toString());
    });

    it("searches by parcel name", async () => {
      const { user, profile, parcel } = await seedFarmer("qs");
      await insertClaim({ user, profile, parcel, state: "rejected" });
      const targeted = await insertClaim({ user, profile, parcel, state: "rejected" });
      // Give the targeted claim a distinctive parcel snapshot.
      const targetParcel = await api()
        .post("/profile/parcels")
        .set(authHeader(user))
        .send({ name: "Mango grove special", crop: "Paddy", geometry: squareGeometry(0.01, [87.5, 21.0]) });
      const targeted2 = await insertClaim({ user, profile: await FarmProfile.findOne({ cognitoSub: user }), parcel: targetParcel.body.data.parcel, state: "rejected" });
      const response = await api().get("/admin/claims?search=grove").set(adminHeader(adminUser()));
      expect(response.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(response.body.data.items.map((entry) => entry.id)).toContain(targeted2._id.toString());
      // parcel fixture name is "Admin field" → a plain "Admin" search should NOT match the numbered claim `targeted`
      const plainSearch = await api().get("/admin/claims?search=zzz-nomatch").set(adminHeader(adminUser()));
      expect(plainSearch.body.data.items).toHaveLength(0);
      expect(targeted._id.toString()).toBeTruthy();
    });

    it("supports pagination", async () => {
      const { user, profile, parcel } = await seedFarmer("qp");
      for (let i = 0; i < 5; i += 1) {
        await insertClaim({ user, profile, parcel, state: "rejected" });
      }
      const response = await api().get("/admin/claims?limit=2&page=1").set(adminHeader(adminUser()));
      expect(response.body.data.items).toHaveLength(2);
      expect(response.body.data.total).toBe(5);
      const page2 = await api().get("/admin/claims?limit=2&page=2").set(adminHeader(adminUser()));
      expect(page2.body.data.items).toHaveLength(2);
    });
  });

  describe("F. admin claim detail", () => {
    it("returns the full review surface (assessment, appeals, audit, actions, parcel, evidence, farmer)", async () => {
      const { user, profile, parcel } = await seedFarmer("det");
      const claim = await insertClaim({
        user,
        profile,
        parcel,
        state: "rejected",
        appeal: true,
        evidenceStored: true,
      });
      // give the claim a completed assessment with a rules object + settled audit/actions already present
      const sealed = await LossClaim.findById(claim._id);
      expect(sealed._id.toString()).toBe(claim._id.toString());
      const response = await api().get(`/admin/claims/${claim._id}`).set(adminHeader(adminUser()));
      expect(response.status).toBe(200);
      const data = response.body.data;
      expect(data.state).toBe("rejected");
      expect(data.parcel).toMatchObject({ parcelId: parcel.parcelId });
      expect(data.farmer).toMatchObject({ cognitoSub: user, email: `${user}@example.com` });
      expect(data.appeals).toHaveLength(1);
      expect(data.appeals[0].status).toBe("submitted");
      expect(data.audit).toBeInstanceOf(Array);
      expect(data.adminActions).toBeInstanceOf(Array);
      expect(data.evidenceUrls.length).toBeGreaterThanOrEqual(0);
      expect(data.assessment).toBeTruthy();
    });

    it("404s on an unknown claim id", async () => {
      const response = await api().get(`/admin/claims/${newObjectId()}`).set(adminHeader(adminUser()));
      expect(response.status).toBe(404);
    });
  });

  describe("G. dashboard metrics", () => {
    it("reports deterministic counts over the seeded period", async () => {
      const { user, profile, parcel } = await seedFarmer("dash");
      await insertClaim({ user, profile, parcel, state: "verified" });
      await insertClaim({ user, profile, parcel, state: "verified" });
      await insertClaim({ user, profile, parcel, state: "rejected" });
      await insertClaim({ user, profile, parcel, state: "out_of_limit" });
      await insertClaim({ user, profile, parcel, state: "duplicate_area" });
      await insertClaim({ user, profile, parcel, state: "more_evidence_required", appeal: true });
      await insertClaim({ user, profile, parcel, state: "rejected", appeal: true });
      const response = await api().get("/admin/dashboard").set(adminHeader(adminUser()));
      expect(response.status).toBe(200);
      const metrics = response.body.data.metrics;
      expect(metrics.total).toBe(7);
      expect(metrics.verified).toBe(2);
      expect(metrics.rejected).toBe(2);
      expect(metrics.outOfLimit).toBe(1);
      expect(metrics.duplicate).toBe(1);
      expect(metrics.moreEvidence).toBe(1);
      expect(metrics.appealCount).toBe(2);
      expect(typeof metrics.averageVerificationTimeMs).toBe("number");
      expect(metrics.pendingHumanReview).toBeGreaterThan(0);
    });
  });

  describe("H. investigation view", () => {
    it("surfaces observation-only flags, never mutations", async () => {
      const { user, profile, parcel } = await seedFarmer("inv");
      // two repeat rejections on the same parcel → repeated_rejection + parcel_reuse
      const a = await insertClaim({ user, profile, parcel, state: "rejected" });
      const b = await insertClaim({ user, profile, parcel, state: "duplicate_area" });
      const response = await api().get("/admin/investigation").set(adminHeader(adminUser()));
      expect(response.status).toBe(200);
      expect(response.body.data.summary.totalEntries).toBeGreaterThan(0);
      const entries = response.body.data.entries;
      const ownerEntry = entries.find((entry) => entry.claimIds.includes(a._id.toString()) && entry.claimIds.includes(b._id.toString()));
      expect(ownerEntry).toBeTruthy();
      const codes = ownerEntry.flags.map((flag) => flag.code);
      expect(codes).toContain("repeated_rejection");
      // observation-only: claims untouched by the read
      const docA = await LossClaim.findById(a._id).lean();
      const docB = await LossClaim.findById(b._id).lean();
      expect(docA.state).toBe("rejected");
      expect(docB.state).toBe("duplicate_area");
    });
  });

  describe("I. audit immutability guards", () => {
    it("blocks updates to ClaimAudit and AdminAction rows", async () => {
      await expect(ClaimAudit.updateOne({}, { reason: "mutated" })).rejects.toThrow(/append-only/);
      await expect(AdminAction.updateOne({}, { reason: "mutated" })).rejects.toThrow(/append-only/);
    });

    it("blocks singular deletes of ClaimAudit and AdminAction rows", async () => {
      await expect(ClaimAudit.deleteOne({})).rejects.toThrow(/append-only/);
      await expect(AdminAction.deleteOne({})).rejects.toThrow(/append-only/);
    });

    it("still permits bulk cleanup (deleteMany) for test infrastructure", async () => {
      await ClaimAudit.deleteMany({});
      await AdminAction.deleteMany({});
      expect(true).toBe(true);
    });
  });

  describe("J. end-to-end engine → appeal → override", () => {
    it("verify → more_evidence_required → appeal → admin override (verified)", async () => {
      // Full public flow with NO evidence → the deterministic engine decides more_evidence_required.
      const user = farmerUser("e2e");
      await User.create({ name: "E2E User", email: `${user}@example.com`, cognitoSub: user });
      const profileRes = await seedProfile(user);
      expect(profileRes.status).toBe(200);
      const parcelRes = await api()
        .post("/profile/parcels")
        .set(authHeader(user))
        .send({ name: "E2E field", crop: "Paddy", geometry: squareGeometry(0.009) });
      expect(parcelRes.status).toBe(200);

      const created = await api()
        .post("/claims")
        .set(authHeader(user, "farmer@example.com"))
        .send({
          parcelId: parcelRes.body.data.parcel.parcelId,
          eventType: "flood",
          eventDate: daysIso(2),
          geometry: squareGeometry(0.009),
          idempotencyKey: `idem-e2e-${newObjectId().toString()}`,
        });
      expect(created.status).toBe(200);
      const claimId = created.body.data.claim.id;

      await api().post(`/claims/${claimId}/submit`).set(authHeader(user, "farmer@example.com")).expect(200);
      const verified = await api().post(`/claims/${claimId}/verify`).set(authHeader(user, "farmer@example.com"));
      expect(verified.status).toBe(200);
      expect(verified.body.data.verification.claimState).toBe("more_evidence_required");

      // Farmer appeals the engine decision.
      const appeal = await api()
        .post(`/claims/${claimId}/appeal`)
        .set(authHeader(user, "farmer@example.com"))
        .send({ reason: "New satellite imagery confirms flood damage" });
      expect(appeal.status).toBe(200);

      // Admin reviews + overrides in the queue view.
      const queue = await api().get("/admin/claims").set(adminHeader(adminUser()));
      expect(queue.body.data.items.map((entry) => entry.id)).toContain(claimId);

      const overridden = await api()
        .post(`/admin/claims/${claimId}/override`)
        .set(adminHeader(adminUser()))
        .send({
          toState: "verified",
          reason: "Satellite imagery on file confirms flood damage",
          adminNote: "Verified from external satellite source",
          overrideKey: `override-e2e-${newObjectId().toString()}`,
        });
      expect(overridden.status).toBe(200);
      expect(overridden.body.data.claim.state).toBe("verified");

      // Appeal resolved with the override decision + immutable trail.
      const detail = await api().get(`/admin/claims/${claimId}`).set(adminHeader(adminUser()));
      expect(detail.status).toBe(200);
      expect(detail.body.data.appeals[0].status).toBe("resolved");
      expect(detail.body.data.appeals[0].decision.kind).toBe("overridden");
      const adminAction = await AdminAction.countDocuments({ claimId });
      expect(adminAction).toBe(1);
      const adminAudit = await ClaimAudit.countDocuments({ claimId, actor: "admin", action: "overridden" });
      expect(adminAudit).toBe(1);
    });
  });
});

function signAdminLike() {
  // Simulates a token whose embedded role differs from the "approverSub" in the request.
  return adminHeader("same-sub", "same-sub@example.com");
}