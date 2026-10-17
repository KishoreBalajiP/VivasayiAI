import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Policy v1.1-safe-ai end to end (owner decisions D1, D2, D8). The policy and the image-AI mode are
// read once when config/env.js loads, so they are set before any import. The REAL claim-vision,
// assessment, queue and engine code runs; only the Gemini model, Chroma and Cohere are fakes, and the
// satellite / weather / document steps are replaced so nothing leaves the process.
vi.hoisted(() => {
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
});

const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));

import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { putObject } from "../services/s3.service.js";
import { drain, enqueue, ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import { requestReevaluation } from "../services/verificationWorker.service.js";
import { verifyClaim } from "../services/claimVerification.service.js";
import { overrideClaim } from "../services/admin.service.js";
import { env } from "../config/env.js";
import {
  adminHeader,
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

const DAY_MS = 86400000;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
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
const reply = (text) => ({ generations: [[{ text }]] });
const answer = (observation) => reply(JSON.stringify(observation));
const providerFailure = (status) => Object.assign(new Error(`[${status}] provider refused the call`), { status });

let seq = 0;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

const seedSubmittedClaimWithPhoto = async (label) => {
  const user = `safeai-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api()
    .post("/profile/parcels")
    .set(authHeader(user))
    .send({ name: "Safe field", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({
      parcelId: parcel.body.data.parcel.parcelId,
      eventType: "flood",
      eventDate: daysAgo(2).toISOString(),
      geometry: squareGeometry(0.009),
      idempotencyKey: `idem-safeai-${seq}`,
    });
  expect(created.status).toBe(200);
  const claimId = created.body.data.claim.id;
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
  return { user, claimId };
};

const verify = (user, claimId) => api().post(`/claims/${claimId}/verify`).set(authHeader(user)).send({});
const decisionOf = (response) => response.body.data.verification;
const reviewCases = (claimId) => VerificationEvidence.find({ claimId, "metadata.kind": "review_case" }).lean();
const adverseAudits = (claimId) =>
  ClaimAudit.countDocuments({ claimId, toState: { $in: ["rejected", "more_evidence_required"] } });

// Run the claim's queue the way a worker would, moving a fake clock forward between batches so
// retries and the engine's wait become due.
let clock = Date.now();
const runQueue = async (claimId, rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    clock += 10 * 60 * 1000;
    await drain({ claimId, now: () => new Date(clock), maxJobs: 10 });
    if ((await VerificationJob.countDocuments({ claimId, status: { $in: ["queued", "running"] } })) === 0) return;
  }
  throw new Error("queue did not settle");
};

// The automated photo check followed by the engine, as the submit plan queues them.
const queuePhotoCheck = async ({ claimId, user, maxAttempts = 2 }) => {
  await enqueue({ claimId, cognitoSub: user, step: "ai_assessment", runAt: new Date(clock), maxAttempts });
  await enqueue({ claimId, cognitoSub: user, step: "engine", runAt: new Date(clock) });
};

const expectTechnicalHold = async ({ claimId, kind }) => {
  const claim = await LossClaim.findById(claimId);
  expect(claim.state).toBe("submitted");
  const stored = await ClaimAssessment.findOne({ claimId }).lean();
  expect(stored.status).toBe("failed");
  expect(stored.error).toMatchObject({ kind });
  expect(stored.state).toBeNull();
  expect(stored.verification.status).toBe("held");
  expect(stored.components.photos.outcome).toBe("unavailable");
  expect(stored.hold.blocking).toEqual([
    { component: "photos", outcome: "unavailable", action: "hold", reasonCodes: ["ai_assessment_unavailable", `provider_${kind}`] },
  ]);
  expect(await adverseAudits(claimId)).toBe(0);
};

describe("policy v1.1-safe-ai — a technical failure or the AI alone never decides against the farmer", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    // Supporting steps never leave the process in this suite; the photo check and the engine are real.
    for (const step of ["satellite", "weather", "land_documents", "official_land_record"]) {
      setExecutor(step, async () => ({ fake: step }));
    }
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [LossClaim, ClaimEvidence, ClaimAssessment, ClaimAudit, AdminAction, VerificationEvidence, VerificationJob]) {
      await model.deleteMany({});
    }
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(answer(CLEAR));
    delete process.env.GEMINI_TIMEOUT_MS;
  });

  it("SA-1: an AI-only 'no damage' reading holds with ONE review case, shows in the held queue, and an admin can decide it", async () => {
    expect(env.claimVerificationPolicy).toBe("v1.1-safe-ai");
    const { user, claimId } = await seedSubmittedClaimWithPhoto("nodamage");
    mocks.generate.mockResolvedValue(answer(NO_DAMAGE));

    const response = await verify(user, claimId);
    expect(response.status).toBe(200);
    const data = decisionOf(response);
    expect(data.policyId).toBe("v1.1-safe-ai");
    expect(data.held).toBe(true);
    expect(data.claimState).toBe("submitted");
    expect(data.outcome).toBeNull();
    expect(data.pendingComponents).toEqual([{ component: "photos", outcome: "requires_review", action: "hold" }]);
    // The reason survives the hold (reasonCode -> reasonCodes normalisation).
    const stored = await ClaimAssessment.findOne({ claimId }).lean();
    expect(stored.hold.blocking[0].reasonCodes).toEqual(["ai_no_damage_needs_review"]);

    // Exactly one review case for this cause, also after the claim is evaluated again.
    expect(decisionOf(await verify(user, claimId)).held).toBe(true);
    const cases = await reviewCases(claimId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ source: "AI_IMAGE", status: "PENDING" });
    expect(cases[0].result.reviewReasons).toEqual(["ai_no_damage_needs_review"]);
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_held" })).toBe(1);
    expect(await adverseAudits(claimId)).toBe(0);

    // The held claim is visible to admins: in the ?held=true filter and in the default queue.
    const heldQueue = await api().get("/admin/claims?held=true").set(adminHeader("safeai-admin"));
    expect(heldQueue.status).toBe(200);
    expect(heldQueue.body.data.filters.held).toBe(true);
    const heldItem = heldQueue.body.data.items.find((item) => item.id === claimId);
    expect(heldItem).toMatchObject({ state: "submitted", held: true });
    const defaultQueue = await api().get("/admin/claims").set(adminHeader("safeai-admin"));
    expect(defaultQueue.body.data.items.map((item) => item.id)).toContain(claimId);
    // ?held=false is the opposite filter: the held claim is left out.
    const notHeldQueue = await api().get("/admin/claims?held=false").set(adminHeader("safeai-admin"));
    expect(notHeldQueue.status).toBe(200);
    expect(notHeldQueue.body.data.filters.held).toBe(false);
    expect(notHeldQueue.body.data.items.map((item) => item.id)).not.toContain(claimId);
    // An AI "no damage" hold is not an AI failure: held=true narrowed by aiFailed.
    const aiHolds = await api().get("/admin/claims?held=true&aiFailed=false").set(adminHeader("safeai-admin"));
    expect(aiHolds.body.data.items.map((item) => item.id)).toContain(claimId);
    const technicalHolds = await api().get("/admin/claims?held=true&aiFailed=true").set(adminHeader("safeai-admin"));
    expect(technicalHolds.body.data.items.map((item) => item.id)).not.toContain(claimId);

    // A submitted claim that is NOT held still cannot be overridden.
    const other = await seedSubmittedClaimWithPhoto("notheld");
    expect(heldQueue.body.data.items.map((item) => item.id)).not.toContain(other.claimId);
    const refused = await api()
      .post(`/admin/claims/${other.claimId}/override`)
      .set(adminHeader("safeai-admin"))
      .send({ toState: "verified", reason: "Looked at the photographs myself" });
    expect(refused.status).toBe(409);
    expect((await LossClaim.findById(other.claimId)).state).toBe("submitted");

    // Queued work for the held claim, to prove the override cancels the decision steps only.
    await enqueue({ claimId, cognitoSub: user, step: "ai_assessment", runAt: daysAgo(-1) });
    await enqueue({ claimId, cognitoSub: user, step: "engine", runAt: daysAgo(-1) });
    await enqueue({ claimId, cognitoSub: user, step: "satellite", runAt: daysAgo(-1) });

    const override = await api()
      .post(`/admin/claims/${claimId}/override`)
      .set(adminHeader("safeai-admin"))
      .send({ toState: "verified", reason: "Damage is visible in the second photograph" });
    expect(override.status).toBe(200);
    expect(override.body.data.claim.state).toBe("verified");
    expect((await LossClaim.findById(claimId)).state).toBe("verified");

    const action = await AdminAction.findOne({ claimId, action: "override" }).lean();
    expect(action).toMatchObject({ priorState: "submitted", targetState: "verified", actorSub: "safeai-admin" });
    const audit = await ClaimAudit.findOne({ claimId, action: "overridden" }).lean();
    expect(audit).toMatchObject({ actor: "admin", fromState: "submitted", toState: "verified" });
    const decided = await ClaimAssessment.findOne({ claimId }).lean();
    expect(decided).toMatchObject({ state: "verified", decidedBy: "admin", hold: null });
    expect(decided.verification.status).toBe("completed");

    const jobs = await VerificationJob.find({ claimId }).lean();
    const statusOf = (step) => jobs.find((job) => job.step === step);
    expect(statusOf("ai_assessment")).toMatchObject({ status: "cancelled", cancelReason: "admin_override" });
    expect(statusOf("ai_assessment").activeKey).toBeUndefined();
    expect(statusOf("engine")).toMatchObject({ status: "cancelled", cancelReason: "admin_override" });
    expect(statusOf("satellite").status).toBe("queued"); // supporting evidence keeps running (D1)

    // Decided: no longer held, no longer overridable from "submitted".
    const after = await api().get("/admin/claims?held=true").set(adminHeader("safeai-admin"));
    expect(after.body.data.items.map((item) => item.id)).not.toContain(claimId);
  });

  it("SA-1b: an admin override that lands while the engine is evaluating the held claim is never overwritten by the hold", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("override-race");
    mocks.generate.mockResolvedValue(answer(NO_DAMAGE));
    expect(decisionOf(await verify(user, claimId)).held).toBe(true);
    const heldAudits = await ClaimAudit.countDocuments({ claimId, action: "verification_held" });

    // Run the override to completion INSIDE the engine's evaluation: after the engine has read the
    // claim as `submitted`, before it records the hold.
    const realFind = VerificationEvidence.find;
    let override = null;
    const spy = vi.spyOn(VerificationEvidence, "find").mockImplementation((...args) => {
      const filter = args[0] || {};
      if (override || String(filter.claimId) !== claimId || Object.keys(filter).length !== 1) {
        return realFind.apply(VerificationEvidence, args);
      }
      override = overrideClaim({ claimId, actorSub: "safeai-admin", toState: "verified", reason: "Damage is visible in the second photograph" });
      return { lean: async () => { await override; return realFind.apply(VerificationEvidence, args).lean(); } };
    });
    let inFlight;
    try {
      inFlight = await verifyClaim({ claimId, cognitoSub: user });
    } finally {
      spy.mockRestore();
    }
    expect(override).not.toBeNull();
    expect((await override).claim.state).toBe("verified");

    // The in-flight run reports the person's decision, not a hold.
    expect(inFlight).toMatchObject({ claimState: "verified", outcome: "verified", held: false, inProgress: false });
    const stored = await ClaimAssessment.findOne({ claimId }).lean();
    expect(stored).toMatchObject({ state: "verified", decidedBy: "admin", hold: null });
    expect(stored.verification.status).toBe("completed");
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_held" })).toBe(heldAudits);

    // The decided claim stays readable: every later verify returns the persisted decision.
    const again = await verify(user, claimId);
    expect(again.status).toBe(200);
    expect(decisionOf(again)).toMatchObject({ claimState: "verified", outcome: "verified", held: false, idempotent: true });
    expect(await adverseAudits(claimId)).toBe(0);
  });

  it("SA-2: unreadable model output fails the photo check as malformed, is retried, and ends in a hold — never 'more evidence'", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("malformed");
    mocks.generate.mockResolvedValue(reply("not json"));
    await queuePhotoCheck({ claimId, user });

    // First batch: the photo check fails as malformed and is scheduled again; the engine waits.
    clock += 60 * 1000;
    await drain({ claimId, now: () => new Date(clock), maxJobs: 10 });
    const failed = await ClaimAssessment.findOne({ claimId }).lean();
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ kind: "malformed_response", code: "PROVIDER_MALFORMED" });
    const retrying = await VerificationJob.findOne({ claimId, step: "ai_assessment" }).lean();
    expect(retrying.status).toBe("queued");
    expect(retrying.lastError.code).toBe("PROVIDER_MALFORMED");
    expect((await VerificationJob.findOne({ claimId, step: "engine" }).lean()).status).toBe("queued");

    await runQueue(claimId);
    expect((await VerificationJob.findOne({ claimId, step: "ai_assessment" }).lean()).status).toBe("dead");
    const engineJob = await VerificationJob.findOne({ claimId, step: "engine" }).lean();
    expect(engineJob.status).toBe("succeeded");
    expect(engineJob.resultSummary).toMatchObject({ claimState: "submitted", held: true });
    await expectTechnicalHold({ claimId, kind: "malformed_response" });
  });

  it("SA-2b: a photo check abandoned in `processing` is taken over and decided; one held by a live owner reschedules the engine, then dies into a review case — never a silent success", async () => {
    // A worker crashed mid-assessment: the row stays `processing`, its lease lapsed long ago, and
    // the engine's own photo check takes the slot over and decides (ADR-022 slot lease).
    const crashed = await seedSubmittedClaimWithPhoto("crashed");
    await ClaimAssessment.create({ claimId: crashed.claimId, status: "processing", evidenceVersion: "crashed-run", startedAt: daysAgo(1) });
    await enqueue({ claimId: crashed.claimId, cognitoSub: crashed.user, step: "engine", runAt: new Date(clock) });
    await runQueue(crashed.claimId);
    expect((await LossClaim.findById(crashed.claimId)).state).toBe("verified");
    expect((await ClaimAssessment.findOne({ claimId: crashed.claimId }).lean()).status).toBe("completed");
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    mocks.generate.mockClear();

    // Another runner holds the slot and keeps its lease alive, but never finishes: the engine
    // reports "in progress", is rescheduled (no attempt used) and, past the cap, dies into a case.
    const { user, claimId } = await seedSubmittedClaimWithPhoto("stuck");
    await ClaimAssessment.create({
      claimId, status: "processing", evidenceVersion: "hung-run", startedAt: new Date(), slotLeaseUntil: new Date(Date.now() + 365 * DAY_MS),
    });
    await enqueue({ claimId, cognitoSub: user, step: "engine", runAt: new Date(clock) });

    clock += 60 * 1000;
    const [first] = await drain({ claimId, now: () => new Date(clock), maxJobs: 1 });
    expect(first).toMatchObject({ step: "engine", outcome: "rescheduled" });
    const waiting = await VerificationJob.findOne({ claimId, step: "engine" }).lean();
    expect(waiting).toMatchObject({ status: "queued", attempts: 0, rescheduleCount: 1 });
    expect(waiting.runAt.getTime()).toBeGreaterThan(clock);
    expect(waiting.resultSummary).toMatchObject({ claimState: "submitted", held: false, inProgress: true });

    await runQueue(claimId, 40);
    const dead = await VerificationJob.findOne({ claimId, step: "engine" }).lean();
    expect(dead.status).toBe("dead");
    expect(dead.rescheduleCount).toBe(30);
    expect(dead.lastError.code).toBe("ENGINE_STUCK");
    const cases = await reviewCases(claimId);
    expect(cases).toHaveLength(1);
    expect(cases[0].result.reviewReasons).toEqual(["automated_step_failed_engine"]);
    // Nothing was decided and no model call was spent on the stuck row.
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");
    expect(await adverseAudits(claimId)).toBe(0);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each([
    ["429 quota", "quota", "PROVIDER_QUOTA", () => mocks.generate.mockRejectedValue(providerFailure(429))],
    ["503 overload", "overload", "PROVIDER_OVERLOAD", () => mocks.generate.mockRejectedValue(providerFailure(503))],
    ["timeout", "timeout", "PROVIDER_TIMEOUT", () => {
      process.env.GEMINI_TIMEOUT_MS = "100";
      mocks.generate.mockImplementation(() => new Promise(() => {}));
    }],
  ])("SA-3: a provider failure (%s) is retried, then held with one review case; the engine never calls the model again", async (_label, kind, code, arrange) => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto(`provider-${kind}`);
    arrange();
    await queuePhotoCheck({ claimId, user });
    await runQueue(claimId);

    const aiJob = await VerificationJob.findOne({ claimId, step: "ai_assessment" }).lean();
    expect(aiJob.status).toBe("dead");
    expect(aiJob.attempts).toBe(2);
    expect(aiJob.lastError.code).toBe(code);
    await expectTechnicalHold({ claimId, kind });
    expect((await ClaimAssessment.findOne({ claimId }).lean()).error.code).toBe(code);

    // One photo, two attempts: two model calls. The engine's evaluation made none.
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    // Exactly one review case: the dead job's. The technical hold does not open a second one.
    const cases = await reviewCases(claimId);
    expect(cases).toHaveLength(1);
    expect(cases[0].result.reviewReasons).toEqual(["automated_step_failed_ai_assessment"]);

    // A farmer or reviewer asking again gets the same hold, without another model call.
    const again = decisionOf(await verify(user, claimId));
    expect(again).toMatchObject({ held: true, claimState: "submitted", outcome: null });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(await reviewCases(claimId)).toHaveLength(1);
  });

  it("SA-4: an admin re-evaluation 45 days after the event is not late when the claim was first submitted on day 2", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("reeval");
    await LossClaim.updateOne({ _id: claimId }, { $set: { eventDate: daysAgo(45), firstSubmittedAt: daysAgo(43) } });
    await requestReevaluation({ claimId, cognitoSub: user });
    await runQueue(claimId);
    const decided = await ClaimAssessment.findOne({ claimId }).lean();
    expect(decided.rules.timelinessCheck.passed).toBe(true);
    expect((await LossClaim.findById(claimId)).state).toBe("verified");

    // Legacy claim without the field: the earliest `submitted` audit is the first submission.
    const legacy = await seedSubmittedClaimWithPhoto("reeval-legacy");
    await LossClaim.updateOne({ _id: legacy.claimId }, { $set: { eventDate: daysAgo(45), firstSubmittedAt: null } });
    await ClaimAudit.collection.insertOne({
      claimId: new LossClaim({ _id: legacy.claimId })._id,
      actor: "farmer",
      action: "submitted",
      fromState: "draft",
      toState: "submitted",
      reason: "Claim submitted by farmer",
      metadata: {},
      requestId: null,
      createdAt: daysAgo(43),
    });
    await requestReevaluation({ claimId: legacy.claimId, cognitoSub: legacy.user });
    await runQueue(legacy.claimId);
    expect((await LossClaim.findById(legacy.claimId)).state).toBe("verified");

    // The window still applies: first submitted 31 days after the event is late.
    const late = await seedSubmittedClaimWithPhoto("reeval-late");
    await LossClaim.updateOne({ _id: late.claimId }, { $set: { eventDate: daysAgo(45), firstSubmittedAt: daysAgo(14) } });
    await requestReevaluation({ claimId: late.claimId, cognitoSub: late.user });
    await runQueue(late.claimId);
    expect((await LossClaim.findById(late.claimId)).state).toBe("rejected");
    expect((await ClaimAssessment.findOne({ claimId: late.claimId }).lean()).rules.timelinessCheck.passed).toBe(false);
  });

  it("SA-5: a resubmission on day 35 is not late when the claim was first submitted on day 2", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("resubmit");
    const firstSubmittedAt = daysAgo(33);
    await LossClaim.updateOne(
      { _id: claimId },
      { $set: { state: "more_evidence_required", eventDate: daysAgo(35), firstSubmittedAt, decidedAt: daysAgo(30) } }
    );
    const resubmitted = await api().post(`/claims/${claimId}/resubmit`).set(authHeader(user));
    expect(resubmitted.status).toBe(200);
    const claim = await LossClaim.findById(claimId);
    expect(claim.state).toBe("submitted");
    expect(claim.submittedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 1000); // overwritten by the resubmit
    expect(claim.firstSubmittedAt.getTime()).toBe(firstSubmittedAt.getTime()); // untouched

    const data = decisionOf(await verify(user, claimId));
    expect(data.claimState).toBe("verified");
    expect(data.rules.timelinessCheck.passed).toBe(true);
  });

  it("SA-6: a re-queued photo check that succeeds clears the technical hold and the claim is decided", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("recover");
    mocks.generate.mockRejectedValue(providerFailure(429));
    await queuePhotoCheck({ claimId, user });
    await runQueue(claimId);
    await expectTechnicalHold({ claimId, kind: "quota" });

    // The provider recovers and the dead step is queued again (the requeue path), with the engine.
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(answer(CLEAR));
    await queuePhotoCheck({ claimId, user });
    await runQueue(claimId);

    expect((await LossClaim.findById(claimId)).state).toBe("verified");
    const decided = await ClaimAssessment.findOne({ claimId }).lean();
    expect(decided).toMatchObject({ status: "completed", state: "verified", hold: null });
    expect(decided.verification.status).toBe("completed");
    expect(await ClaimAudit.countDocuments({ claimId, action: "verified" })).toBe(1);
  });

  it("SA-7: satellite support does not override the hold on an AI 'no damage' reading", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("sat-support");
    await VerificationEvidence.create({
      claimId, source: "SATELLITE", status: "AVAILABLE", component: "satellite", idempotencyKey: "sat2_safeai_support",
      result: { analysisOutcome: "SUPPORTS_LOSS" }, metadata: { processingStatus: "completed", analysisExecuted: true },
    });
    mocks.generate.mockResolvedValue(answer(NO_DAMAGE));
    const data = decisionOf(await verify(user, claimId));
    expect(data).toMatchObject({ held: true, claimState: "submitted", outcome: null });
    expect(data.components.satellite.outcome).toBe("verified");
    expect(data.components.photos.outcome).toBe("requires_review");
  });

  it("SA-8: a satellite 'no change' reading does not stop an AI-supported claim from being verified", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("sat-nochange");
    await VerificationEvidence.create({
      claimId, source: "SATELLITE", status: "AVAILABLE", component: "satellite", idempotencyKey: "sat2_safeai_nochange",
      result: { analysisOutcome: "NO_CHANGE" }, metadata: { processingStatus: "completed", analysisExecuted: true },
    });
    const data = decisionOf(await verify(user, claimId));
    expect(data.claimState).toBe("verified");
    expect(data.components.satellite.outcome).toBe("inconclusive");
  });

  it("SA-9: weather being unavailable does not change the v1.1 decision", async () => {
    const without = await seedSubmittedClaimWithPhoto("wx-none");
    const withRow = await seedSubmittedClaimWithPhoto("wx-unavailable");
    await VerificationEvidence.create({
      claimId: withRow.claimId, source: "WEATHER", status: "UNAVAILABLE", component: "weather", idempotencyKey: "wx_safeai_unavailable",
      result: { reason: "archive_unavailable" }, metadata: {},
    });
    const plain = decisionOf(await verify(without.user, without.claimId));
    const unavailable = decisionOf(await verify(withRow.user, withRow.claimId));
    expect(unavailable.components.weather.outcome).toBe("unavailable");
    expect(unavailable.claimState).toBe(plain.claimState);
    expect(unavailable.claimState).toBe("verified");
  });
});
