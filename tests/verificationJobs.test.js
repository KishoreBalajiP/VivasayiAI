import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// IMAGE_AI_MODE=live with the model replaced (VJ-19 runs the real land-document step against a fake
// model). Every other test here replaces the executors, so the AI mode does not matter to them.
const { mockGenerate, mockSatellite } = vi.hoisted(() => {
  process.env.CLAIM_VERIFICATION_POLICY = "v2-components";
  process.env.IMAGE_AI_MODE = "live";
  return { mockGenerate: vi.fn(), mockSatellite: vi.fn() };
});
vi.mock("../services/chat.service.js", () => ({
  model: { generate: (...args) => mockGenerate(...args) },
  performRAG: vi.fn().mockResolvedValue({ context: null, sourceCount: 0, sources: [] }),
  generateResponse: vi.fn(),
}));
// The real satellite step (VJ-20) runs against a fake provider run: no imagery service is called.
vi.mock("../services/satelliteVerification.service.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runSatelliteVerificationForClaim: (...args) => mockSatellite(...args),
}));

import mongoose from "mongoose";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ImageRecord from "../models/ImageRecord.js";
import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import {
  AUTO_RECOVERABLE_KINDS,
  ENGINE_MAX_RESCHEDULES,
  MIN_BUDGET_MS,
  RERUN_DELAY_MS,
  blockingStepsFor,
  claimNext,
  countBlockingActiveJobs,
  drain,
  enqueue,
  enqueuePlan,
  ensureDefaultExecutors,
  requeueDeadJobs,
  runJob,
  setExecutor,
} from "../services/verificationJobs.service.js";
import { drainDueJobs, recoverDeadJobs, releaseStuckProcessingClaims, sweepStaleHolds } from "../services/verificationWorker.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { env } from "../config/env.js";
import { putObject } from "../services/s3.service.js";
import { resolveComponents } from "../services/verificationComponents.js";
import { api, authHeader, clearTestDatabase, seedProfile, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";

// ADR-021 — durable job queue. Executors are replaced with fakes: this suite is about scheduling,
// deduplication, recovery and failure handling, not about the providers.

let seq = 0;
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const STEPS = ["ai_assessment", "land_documents", "official_land_record", "satellite", "weather", "engine"];

const HOUR = 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const LAND_RECORD = {
  documentType: "land_record", issuingAuthority: "Revenue Department", recordNumber: "R-77", state: "Tamil Nadu", district: "Thanjavur",
  taluk: "Papanasam", village: "Ammapettai", surveyNumber: "123/4A", subdivisionNumber: "2", holderNames: ["Murugan"],
  parcelExtent: 1.2, extentUnit: "acre", documentDate: "2024-03-01", additionalIdentifiers: [], unreadable: false, language: "ta",
  confidence: "high", imageQuality: "good", uncertainFields: [],
};
const PHOTO = {
  cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate", visibleAffectedPortion: "lower portion of the field",
  confidence: "high", uncertain: false, inconsistencies: [], observations: ["standing water"], imageQuality: "good",
};
const reply = (value) => ({ generations: [[{ text: JSON.stringify(value) }]] });
const providerFailure = (status) => Object.assign(new Error(`[${status}] provider refused the call`), { status });
const reviewCasesOf = (claimId) => VerificationEvidence.find({ claimId, "metadata.kind": "review_case" }).lean();

// Attach a stored private upload to the claim as a land document (the farmer's own API calls).
const attachLandDocument = async (user, claimId) => {
  const presign = await api().post("/upload/presign").set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "doc.png" });
  const { uploadId } = presign.body.data;
  await putObject({ key: (await ImageRecord.findOne({ uploadId })).s3Key, buffer: PNG, mediaType: "image/png" });
  await api().post(`/upload/${uploadId}/complete`).set(authHeader(user));
  const attached = await api().post(`/claims/${claimId}/ownership`).set(authHeader(user)).send({ uploadId });
  expect(attached.status).toBe(200);
  return attached.body.data.evidence.id;
};

// Stored claim photos, as the evidence API leaves them (VJ-25b runs the real photo check).
const seedPhotos = async (claimId, count) => {
  for (let i = 0; i < count; i += 1) {
    const uploadId = `img_00000000-0000-4000-8000-${String(++seq).padStart(6, "0")}${String(i).padStart(6, "0")}`;
    const s3Key = `claims/${claimId}/${uploadId}/image.png`;
    await putObject({ key: s3Key, buffer: PNG, mediaType: "image/png" });
    await ClaimEvidence.create({ claimId, uploadId, s3Key, mediaType: "image/png", size: PNG.length, status: "stored", uploadedAt: new Date(Date.now() + i), width: 1, height: 1 });
  }
};

const seedSubmittedClaim = async (label) => {
  const user = `jobs-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "F", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api().post("/claims").set(authHeader(user)).send({
    parcelId: parcel.body.data.parcel.parcelId, eventType: "flood", eventDate: daysAgo(2), geometry: squareGeometry(0.009), idempotencyKey: `idem-jobs-${seq}`,
  });
  const claimId = created.body.data.claim.id;
  await api().post(`/claims/${claimId}/submit`).set(authHeader(user));
  return { user, claimId };
};

describe("verification job queue", () => {
  let mongo;
  const ran = [];

  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
  });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [LossClaim, ClaimAssessment, ClaimAudit, ClaimEvidence, VerificationEvidence, VerificationJob, ImageRecord]) await model.deleteMany({});
    ran.length = 0;
    mockGenerate.mockReset();
    mockSatellite.mockReset();
    for (const step of STEPS) setExecutor(step, async (job) => { ran.push(`${step}:${String(job.claimId)}`); return { fake: step }; });
  });

  it("VJ-1: at most one ACTIVE job per claim and step; a finished step can be queued again", async () => {
    const { user, claimId } = await seedSubmittedClaim("dedupe");
    const first = await enqueue({ claimId, cognitoSub: user, step: "satellite" });
    const second = await enqueue({ claimId, cognitoSub: user, step: "satellite" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(String(second.job._id)).toBe(String(first.job._id));
    expect(await VerificationJob.countDocuments({ claimId, step: "satellite" })).toBe(1);

    await drain({ claimId });
    expect((await VerificationJob.findById(first.job._id)).status).toBe("succeeded");
    expect((await enqueue({ claimId, cognitoSub: user, step: "satellite" })).created).toBe(true);
  });

  it("VJ-2: the plan contains only steps with something to act on, and always the engine", async () => {
    const { user, claimId } = await seedSubmittedClaim("plan");
    const jobs = await enqueuePlan({ claimId, cognitoSub: user });
    expect(jobs.map((job) => job.step)).toEqual(["satellite", "weather", "engine"]);
    // Re-planning (a duplicate submit trigger) creates nothing new.
    await enqueuePlan({ claimId, cognitoSub: user });
    expect(await VerificationJob.countDocuments({ claimId })).toBe(3);
  });

  it("VJ-3: the plan is empty for a claim the caller does not own", async () => {
    const { claimId } = await seedSubmittedClaim("foreign");
    expect(await enqueuePlan({ claimId, cognitoSub: "someone-else" })).toEqual([]);
    expect(await VerificationJob.countDocuments({ claimId })).toBe(0);
  });

  it("VJ-4: the engine waits for the claim's other steps and runs last", async () => {
    const { user, claimId } = await seedSubmittedClaim("order");
    await enqueue({ claimId, cognitoSub: user, step: "engine", runAt: new Date(Date.now() - 5000) });
    // Weather, not satellite: satellite never blocks the engine (D1, VJ-20).
    await enqueue({ claimId, cognitoSub: user, step: "weather" });
    await drain({ claimId });
    const order = ran.map((entry) => entry.split(":")[0]);
    expect(order).toEqual(["weather"]);
    expect((await VerificationJob.findOne({ claimId, step: "engine" })).status).toBe("queued");
    // The engine was put back without being counted as an attempt.
    expect((await VerificationJob.findOne({ claimId, step: "engine" })).attempts).toBe(0);

    await VerificationJob.updateOne({ claimId, step: "engine" }, { $set: { runAt: new Date(Date.now() - 1000) } });
    await drain({ claimId });
    expect(ran.map((entry) => entry.split(":")[0])).toEqual(["weather", "engine"]);
  });

  it("VJ-5: a failing step is retried with backoff, then dies into a review case and never a decision", async () => {
    const { user, claimId } = await seedSubmittedClaim("dead");
    // land_documents, not satellite: a dead supporting step (satellite, weather) opens no review case (VJ-17).
    setExecutor("land_documents", async () => { throw Object.assign(new Error("provider exploded"), { code: "provider_error" }); });
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents", maxAttempts: 2 });

    const now = new Date();
    let claimed = await claimNext({ claimId, now, owner: "w1" });
    expect((await runJob(claimed, { now })).outcome).toBe("retry_scheduled");
    let stored = await VerificationJob.findById(job._id);
    expect(stored.status).toBe("queued");
    expect(stored.runAt.getTime()).toBeGreaterThan(now.getTime());
    expect(stored.lastError.code).toBe("provider_error");

    const later = new Date(now.getTime() + 10 * 60 * 1000);
    claimed = await claimNext({ claimId, now: later, owner: "w1" });
    expect((await runJob(claimed, { now: later })).outcome).toBe("dead");
    stored = await VerificationJob.findById(job._id);
    expect(stored.status).toBe("dead");
    expect(stored.activeKey).toBeUndefined();

    const reviewCases = await VerificationEvidence.find({ claimId, "metadata.kind": "review_case" });
    expect(reviewCases).toHaveLength(1);
    expect(reviewCases[0].result.reviewReasons).toEqual(["automated_step_failed_land_documents"]);
    expect((await LossClaim.findById(claimId)).state).toBe("submitted"); // no decision was produced
    expect(await ClaimAssessment.countDocuments({ claimId, state: { $ne: null } })).toBe(0);
  });

  it("VJ-6: a job whose lease expired is recovered; one with a live lease is left alone", async () => {
    const { user, claimId } = await seedSubmittedClaim("lease");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "weather" });
    const t0 = new Date();
    const first = await claimNext({ claimId, now: t0, owner: "frozen-container", leaseMs: 1000 });
    expect(String(first._id)).toBe(String(job._id));

    expect(await claimNext({ claimId, now: new Date(t0.getTime() + 500), owner: "other" })).toBeNull();
    const recovered = await claimNext({ claimId, now: new Date(t0.getTime() + 5000), owner: "other" });
    expect(String(recovered._id)).toBe(String(job._id));
    expect(recovered.leaseOwner).toBe("other");
    expect(recovered.attempts).toBe(2);
  });

  it("VJ-7: a step without enough time budget is skipped untouched, not half-run", async () => {
    const { user, claimId } = await seedSubmittedClaim("budget");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "ai_assessment" });
    const now = new Date();
    const results = await drain({ claimId, deadline: now.getTime() + 2000, now: () => now });
    expect(results.map((entry) => entry.outcome)).toEqual(["skipped_no_budget"]);
    expect(ran).toEqual([]);
    const stored = await VerificationJob.findById(job._id);
    expect(stored.status).toBe("queued");
    expect(stored.attempts).toBe(0);
  });

  it("VJ-7b: a step that does not fit is skipped once per drain and does not use up a one-step poll: the next shorter due step runs", async () => {
    const a = await seedSubmittedClaim("budget-a");
    const b = await seedSubmittedClaim("budget-b");
    const now = new Date();
    const photoA = (await enqueue({ claimId: a.claimId, cognitoSub: a.user, step: "ai_assessment", runAt: new Date(now.getTime() - 60_000) })).job;
    const photoB = (await enqueue({ claimId: b.claimId, cognitoSub: b.user, step: "ai_assessment", runAt: new Date(now.getTime() - 50_000) })).job;
    await enqueue({ claimId: a.claimId, cognitoSub: a.user, step: "weather", runAt: new Date(now.getTime() - 1000) });

    // A one-step poll of claim A with 10 s left: the photo check (15 s) is put back, weather (4 s) runs.
    const poll = await drain({ claimId: a.claimId, maxJobs: 1, deadline: now.getTime() + 10_000, now: () => now });
    expect(poll.map((entry) => `${entry.step}:${entry.outcome}`)).toEqual(["ai_assessment:skipped_no_budget", "weather:succeeded"]);
    expect(ran).toEqual([`weather:${a.claimId}`]);

    // Across claims: once the photo check did not fit, no other photo check is claimed in that drain.
    const sweep = await drain({ deadline: now.getTime() + 10_000, now: () => now });
    expect(sweep.map((entry) => `${entry.step}:${entry.outcome}`)).toEqual(["ai_assessment:skipped_no_budget"]);
    for (const job of [photoA, photoB]) {
      expect(await VerificationJob.findById(job._id).lean()).toMatchObject({ status: "queued", attempts: 0 });
    }
    expect(ran).toEqual([`weather:${a.claimId}`]);
  });

  it("VJ-7c: at the default read-drain budget a one-step poll always fits the photo check, even when the clock moves on before the check", async () => {
    // The budget is not set in the test environment: this is the code default.
    expect(env.claimVerificationReadDrainBudgetMs - MIN_BUDGET_MS.ai_assessment).toBeGreaterThanOrEqual(1000);
    const { user, claimId } = await seedSubmittedClaim("read-budget");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "ai_assessment" });
    // As GET /claims/:id/progress does it: the deadline is set first and the drain reads the clock
    // later (here a whole second later, far more than a real request takes).
    const deadline = Date.now() + env.claimVerificationReadDrainBudgetMs;
    const results = await drain({ claimId, maxJobs: 1, deadline, now: () => new Date(Date.now() + 1000) });
    expect(results.map((entry) => entry.outcome)).toEqual(["succeeded"]);
    expect(ran).toEqual([`ai_assessment:${claimId}`]);
    expect((await VerificationJob.findById(job._id).lean()).status).toBe("succeeded");
  });

  it("VJ-8: concurrent workers never claim the same job twice", async () => {
    const { user, claimId } = await seedSubmittedClaim("race");
    for (const step of ["satellite", "weather", "land_documents"]) await enqueue({ claimId, cognitoSub: user, step });
    const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => claimNext({ claimId, now: new Date(), owner: `w${i}` })));
    const taken = claims.filter(Boolean).map((job) => String(job._id));
    expect(taken).toHaveLength(3);
    expect(new Set(taken).size).toBe(3);
  });

  it("VJ-9: draining one claim never touches another claim's jobs", async () => {
    const a = await seedSubmittedClaim("claim-a");
    const b = await seedSubmittedClaim("claim-b");
    await enqueue({ claimId: a.claimId, cognitoSub: a.user, step: "weather" });
    await enqueue({ claimId: b.claimId, cognitoSub: b.user, step: "weather" });
    await drain({ claimId: a.claimId });
    expect(ran).toEqual([`weather:${a.claimId}`]);
    expect((await VerificationJob.findOne({ claimId: b.claimId })).status).toBe("queued");
  });

  it("VJ-10: the scheduled worker drains every due job across claims", async () => {
    const a = await seedSubmittedClaim("w-a");
    const b = await seedSubmittedClaim("w-b");
    await enqueue({ claimId: a.claimId, cognitoSub: a.user, step: "weather" });
    await enqueue({ claimId: b.claimId, cognitoSub: b.user, step: "weather" });
    const result = await drainDueJobs({ deadline: Date.now() + 20000 });
    expect(result.processed).toBe(2);
    expect(await VerificationJob.countDocuments({ status: "succeeded" })).toBe(2);
  });

  it("VJ-11: a claim held longer than the policy allows is escalated to a review case once, never decided", async () => {
    const { claimId } = await seedSubmittedClaim("stale");
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000);
    await ClaimAssessment.create({ claimId, status: "pending", verification: { status: "held" }, hold: { since: old, blocking: [{ component: "claimant_rights", outcome: "pending", action: "hold" }] } });
    const first = await sweepStaleHolds({ now: new Date() });
    expect(first.escalated).toBe(1);
    await sweepStaleHolds({ now: new Date() });
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(1);
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");
  });

  it("VJ-12: a recent hold is not escalated", async () => {
    const { claimId } = await seedSubmittedClaim("fresh");
    await ClaimAssessment.create({ claimId, status: "pending", verification: { status: "held" }, hold: { since: new Date(), blocking: [] } });
    expect((await sweepStaleHolds({ now: new Date() })).escalated).toBe(0);
  });

  // ---- ADR-022: queue robustness -------------------------------------------------------------

  it("VJ-14: a runner whose lease was taken over gets lease_lost and never overwrites the new owner's result", async () => {
    const { user, claimId } = await seedSubmittedClaim("takeover");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents", maxAttempts: 1 });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inStep = new Promise((resolve) => { entered = resolve; });
    setExecutor("land_documents", async (running) => {
      if (running.leaseOwner === "slow") {
        entered();
        await gate;
        // Its last attempt fails: without the owner check this would mark the job dead and open a case.
        throw providerFailure(503);
      }
      return { by: "fast" };
    });

    const t0 = new Date();
    const slow = await claimNext({ claimId, now: t0, owner: "slow", leaseMs: 50 });
    // A heartbeat far slower than the lease: the lease lapses while the step runs.
    const slowRun = runJob(slow, { now: t0, leaseMs: 50, heartbeatMs: 60_000 });
    await inStep;

    const t1 = new Date(t0.getTime() + 1000);
    const fast = await claimNext({ claimId, now: t1, owner: "fast" });
    expect(String(fast._id)).toBe(String(job._id));
    expect(await runJob(fast, { now: t1 })).toMatchObject({ outcome: "succeeded" });

    release();
    expect(await slowRun).toEqual({ step: "land_documents", outcome: "lease_lost" });
    const stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "succeeded", resultSummary: { by: "fast" }, attempts: 2, leaseOwner: null });
    expect(stored.lastError.code).toBeNull();
    expect(stored.deadAt).toBeNull();
    expect(await reviewCasesOf(claimId)).toHaveLength(0);
  });

  it("VJ-14c: while the new owner is STILL running, the stale owner's success write is refused by the owner check alone", async () => {
    // Audit C: in VJ-14 the new owner has already finished, so the `status: "running"` guard alone
    // refuses the stale write. Here both runs are `running` when the stale one writes, so only the
    // leaseOwner filter can stop it, and the stale run returns a RESULT (the success write path).
    const { user, claimId } = await seedSubmittedClaim("takeover-live");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents", maxAttempts: 2 });
    let releaseSlow;
    let releaseFast;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const fastGate = new Promise((resolve) => { releaseFast = resolve; });
    let slowEntered;
    let fastEntered;
    const slowIn = new Promise((resolve) => { slowEntered = resolve; });
    const fastIn = new Promise((resolve) => { fastEntered = resolve; });
    setExecutor("land_documents", async (running) => {
      if (running.leaseOwner === "slow") {
        slowEntered();
        await slowGate;
        return { by: "slow" };
      }
      fastEntered();
      await fastGate;
      return { by: "fast" };
    });

    const t0 = new Date();
    const slow = await claimNext({ claimId, now: t0, owner: "slow", leaseMs: 50 });
    const slowRun = runJob(slow, { now: t0, leaseMs: 50, heartbeatMs: 60_000 });
    await slowIn;

    const t1 = new Date(t0.getTime() + 1000);
    const fast = await claimNext({ claimId, now: t1, owner: "fast" });
    expect(String(fast._id)).toBe(String(job._id));
    const fastRun = runJob(fast, { now: t1, heartbeatMs: 60_000 });
    await fastIn;

    // Both runs are in flight; the stale one finishes first and tries to write its result.
    releaseSlow();
    expect(await slowRun).toEqual({ step: "land_documents", outcome: "lease_lost" });
    const during = await VerificationJob.findById(job._id).lean();
    expect(during).toMatchObject({ status: "running", leaseOwner: "fast" });
    expect(during.resultSummary ?? null).toBeNull();

    releaseFast();
    expect(await fastRun).toMatchObject({ outcome: "succeeded" });
    const stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "succeeded", resultSummary: { by: "fast" } });
  });

  it("VJ-14b: late evidence that finds its step running flags it — the run is queued once more instead of finishing, without using an attempt; a finished step gets a new job", async () => {
    const { user, claimId } = await seedSubmittedClaim("rerun");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inStep = new Promise((resolve) => { entered = resolve; });
    let runs = 0;
    setExecutor("land_documents", async () => {
      runs += 1;
      if (runs === 1) {
        entered();
        await gate;
      }
      return { run: runs };
    });
    const t0 = new Date();
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents", planKey: "r1", runAt: new Date(t0.getTime() - 2000) });
    // The record lookup waits for the document check, including its rerun.
    await enqueue({ claimId, cognitoSub: user, step: "official_land_record", planKey: "r1", runAt: new Date(t0.getTime() - 1000) });
    const running = await claimNext({ claimId, now: t0, owner: "docs-runner" });
    expect(running.step).toBe("land_documents");
    const firstRun = runJob(running, { now: t0 });
    await inStep;

    // A repeated submit (no rerunIfRunning) returns the running job and changes nothing.
    expect(await enqueue({ claimId, cognitoSub: user, step: "land_documents", planKey: "r1" })).toMatchObject({ created: false });
    expect((await VerificationJob.findById(job._id).lean()).rerunRequested).toBeUndefined();
    // A document attached now: no second job beside the running one; the running one is flagged.
    const late = await enqueue({ claimId, cognitoSub: user, step: "land_documents", planKey: "r1:doc:a", rerunIfRunning: true });
    expect(late).toMatchObject({ created: false, rerunRequested: true });
    expect(String(late.job._id)).toBe(String(job._id));

    release();
    const first = await firstRun;
    expect(first).toMatchObject({ step: "land_documents", outcome: "rerun", summary: { run: 1 } });
    expect(first.runAt.getTime()).toBe(t0.getTime() + RERUN_DELAY_MS);
    let stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "queued", attempts: 0, rescheduleCount: 0, activeKey: `${claimId}:land_documents`, resultSummary: { run: 1 } });
    expect(stored.rerunRequested).toBeUndefined();
    expect(stored.completedAt).toBeNull();
    expect(stored.attemptLog.map((entry) => entry.outcome)).toEqual(["rerun_requested"]);

    const results = await drain({ claimId, now: () => new Date(t0.getTime() + RERUN_DELAY_MS) });
    expect(results.map((result) => [result.step, result.outcome])).toEqual([
      ["official_land_record", "waiting_for_dependencies"],
      ["land_documents", "succeeded"],
    ]);
    expect(results[1].summary).toEqual({ run: 2 });
    stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "succeeded", attempts: 1, rescheduleCount: 0 });
    expect(stored.attemptLog.map((entry) => entry.outcome)).toEqual(["rerun_requested", "succeeded"]);
    expect(await VerificationJob.countDocuments({ claimId, step: "land_documents" })).toBe(1);
    expect(ran).toEqual([]);

    // Once the step has finished, the next late document gets a job of its own.
    const after = await enqueue({ claimId, cognitoSub: user, step: "land_documents", planKey: "r1:doc:b", rerunIfRunning: true });
    expect(after.created).toBe(true);
    expect(after.job.planKey).toBe("r1:doc:b");
  });

  it("VJ-15: the heartbeat keeps a slow step's lease alive, so no second runner takes it over", async () => {
    const { user, claimId } = await seedSubmittedClaim("heartbeat");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "weather" });
    let entered;
    const inStep = new Promise((resolve) => { entered = resolve; });
    setExecutor("weather", async () => { entered(); await sleep(1000); return { slow: true }; });

    const t0 = new Date();
    const first = await claimNext({ claimId, now: t0, owner: "w1", leaseMs: 300 });
    const run = runJob(first, { now: t0, leaseMs: 300 }); // renewed every 100 ms
    await inStep;
    await sleep(600); // twice the lease
    expect(await claimNext({ claimId, now: new Date(), owner: "w2", leaseMs: 300 })).toBeNull();
    const during = await VerificationJob.findById(job._id).lean();
    expect(during.leaseOwner).toBe("w1");
    expect(during.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    expect(await run).toMatchObject({ outcome: "succeeded" });
    expect(await VerificationJob.findById(job._id).lean()).toMatchObject({ status: "succeeded", attempts: 1, leaseOwner: null });

    // Control: without a timely heartbeat the same lease lapses and a second runner takes the job.
    const control = await seedSubmittedClaim("no-heartbeat");
    await enqueue({ claimId: control.claimId, cognitoSub: control.user, step: "weather" });
    let enteredControl;
    const inControl = new Promise((resolve) => { enteredControl = resolve; });
    setExecutor("weather", async () => { enteredControl(); await sleep(1000); return { slow: true }; });
    const t1 = new Date();
    const unrenewed = await claimNext({ claimId: control.claimId, now: t1, owner: "w1", leaseMs: 300 });
    const controlRun = runJob(unrenewed, { now: t1, leaseMs: 300, heartbeatMs: 60_000 });
    await inControl;
    await sleep(600);
    const stolen = await claimNext({ claimId: control.claimId, now: new Date(), owner: "w2", leaseMs: 300 });
    expect(stolen).not.toBeNull();
    expect(stolen.leaseOwner).toBe("w2");
    expect(await controlRun).toMatchObject({ outcome: "lease_lost" });
  });

  it("VJ-16: retries follow the backoff schedule within +/-20% jitter and record attemptLog, lastAttemptAt, startedAt and deadAt", async () => {
    const { user, claimId } = await seedSubmittedClaim("backoff");
    setExecutor("land_documents", async () => { throw providerFailure(429); });
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents", maxAttempts: 4 });
    expect(job.maxAttempts).toBe(4);

    const SCHEDULE = [60_000, 300_000, 900_000];
    let now = new Date();
    const attemptTimes = [];
    for (const [index, rand, factor] of [[0, () => 0, 0.8], [1, () => 0.5, 1], [2, () => 1, 1.2]]) {
      const claimed = await claimNext({ claimId, now, owner: `w${index}` });
      attemptTimes.push(now.getTime());
      expect((await runJob(claimed, { now, rand })).outcome).toBe("retry_scheduled");
      const stored = await VerificationJob.findById(job._id).lean();
      const delay = stored.runAt.getTime() - now.getTime();
      expect(delay).toBeGreaterThanOrEqual(SCHEDULE[index] * factor);
      expect(delay).toBeLessThan(SCHEDULE[index] * factor + 2000);
      expect(stored.lastError).toMatchObject({ code: "PROVIDER_QUOTA", kind: "quota", retryable: true });
      expect(stored.lastError.at.getTime()).toBeGreaterThanOrEqual(now.getTime());
      now = stored.runAt;
    }
    const last = await claimNext({ claimId, now, owner: "w3" });
    attemptTimes.push(now.getTime());
    expect((await runJob(last, { now })).outcome).toBe("dead");

    const dead = await VerificationJob.findById(job._id).lean();
    expect(dead.status).toBe("dead");
    expect(dead.attempts).toBe(4);
    expect(dead.startedAt.getTime()).toBeGreaterThanOrEqual(attemptTimes[0]);
    expect(dead.startedAt.getTime()).toBeLessThan(attemptTimes[1]);
    expect(dead.lastAttemptAt.getTime()).toBeGreaterThanOrEqual(attemptTimes[3]);
    expect(dead.deadAt.getTime()).toBeGreaterThanOrEqual(dead.lastAttemptAt.getTime());
    expect(dead.completedAt).toBeNull();
    expect(dead.attemptLog.map((entry) => [entry.attempt, entry.outcome, entry.code, entry.kind])).toEqual([
      [1, "retry_scheduled", "PROVIDER_QUOTA", "quota"],
      [2, "retry_scheduled", "PROVIDER_QUOTA", "quota"],
      [3, "retry_scheduled", "PROVIDER_QUOTA", "quota"],
      [4, "dead", "PROVIDER_QUOTA", "quota"],
    ]);
    expect(dead.attemptLog.every((entry) => entry.durationMs >= 0)).toBe(true);

    // The schedule and the attempt limits are configurable (CSV and JSON).
    process.env.VERIFICATION_RETRY_SCHEDULE_MS = "1000,2000";
    process.env.VERIFICATION_MAX_ATTEMPTS = '{"weather":2,"engine":9}';
    try {
      const other = await seedSubmittedClaim("backoff-env");
      const weather = await enqueue({ claimId: other.claimId, cognitoSub: other.user, step: "weather" });
      const engine = await enqueue({ claimId: other.claimId, cognitoSub: other.user, step: "engine" });
      const ai = await enqueue({ claimId: other.claimId, cognitoSub: other.user, step: "ai_assessment" });
      expect([weather.job.maxAttempts, engine.job.maxAttempts, ai.job.maxAttempts]).toEqual([2, 9, 7]);
      setExecutor("weather", async () => { throw providerFailure(503); });
      const t = new Date();
      const claimed = await claimNext({ claimId: other.claimId, now: t, owner: "env" });
      expect(claimed.step).toBe("weather");
      await runJob(claimed, { now: t, rand: () => 0.5 });
      const retried = await VerificationJob.findById(weather.job._id).lean();
      expect(retried.runAt.getTime() - t.getTime()).toBeGreaterThanOrEqual(1000);
      expect(retried.runAt.getTime() - t.getTime()).toBeLessThan(3000);
    } finally {
      delete process.env.VERIFICATION_RETRY_SCHEDULE_MS;
      delete process.env.VERIFICATION_MAX_ATTEMPTS;
    }
    // The defaults: 7 attempts for the AI and document steps, 5 for the rest.
    const defaults = await seedSubmittedClaim("defaults");
    const limits = {};
    for (const step of STEPS) limits[step] = (await enqueue({ claimId: defaults.claimId, cognitoSub: defaults.user, step })).job.maxAttempts;
    expect(limits).toEqual({ ai_assessment: 7, land_documents: 7, official_land_record: 5, satellite: 5, weather: 5, engine: 5 });
  });

  it("VJ-17: a dead job's review case carries its step's source and failure; dead satellite and weather jobs open none", async () => {
    const { user, claimId } = await seedSubmittedClaim("labels");
    for (const step of STEPS) {
      setExecutor(step, async () => { throw providerFailure(503); });
      await enqueue({ claimId, cognitoSub: user, step, maxAttempts: 1 });
    }
    let clock = Date.now();
    for (let round = 0; round < 4; round += 1) {
      clock += 10 * 60 * 1000;
      await drain({ claimId, now: () => new Date(clock) });
    }
    const jobs = await VerificationJob.find({ claimId }).lean();
    expect(jobs.map((job) => job.status)).toEqual(STEPS.map(() => "dead"));
    for (const job of jobs) expect(job.lastError).toMatchObject({ code: "PROVIDER_OVERLOAD", kind: "overload" });

    const cases = await reviewCasesOf(claimId);
    const bySource = Object.fromEntries(cases.map((row) => [row.metadata.failedStep, row]));
    expect(Object.keys(bySource).sort()).toEqual(["ai_assessment", "engine", "land_documents", "official_land_record"]);
    expect(bySource.ai_assessment).toMatchObject({
      source: "AI_IMAGE",
      status: "PENDING",
      component: "manual_review",
      kind: "review_case",
      metadata: { component: "manual_review", kind: "review_case", failedStep: "ai_assessment", failedComponent: "photos", errorCode: "PROVIDER_OVERLOAD", errorKind: "overload" },
    });
    expect(bySource.ai_assessment.result.reviewReasons).toEqual(["automated_step_failed_ai_assessment"]);
    expect(bySource.land_documents).toMatchObject({ source: "OWNERSHIP", metadata: { failedComponent: "land_documents" } });
    expect(bySource.official_land_record).toMatchObject({ source: "OWNERSHIP", metadata: { failedComponent: "claimant_rights" } });
    expect(bySource.engine).toMatchObject({ source: "GEOMETRY", metadata: { failedStep: "engine" } });
    // Satellite and weather are supporting evidence: no case, so nothing is held for them.
    expect(cases.some((row) => ["SATELLITE", "WEATHER"].includes(row.source))).toBe(false);

    // A review case labelled SATELLITE (as older releases wrote) is never read as a satellite reading.
    const components = resolveComponents({
      evidenceRows: [{ _id: "x1", claimId, source: "SATELLITE", status: "PENDING", idempotencyKey: "rv_x_SATELLITE_1", metadata: { kind: "review_case", reviewRequired: true }, createdAt: new Date() }],
      policy: resolvePolicy("v2-components"),
    });
    expect(components.satellite.outcome).toBe("unverified");
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");
  });

  it("VJ-18: official_land_record waits while land_documents is queued or running, even when it is due first", async () => {
    const { user, claimId } = await seedSubmittedClaim("dependency");
    await enqueue({ claimId, cognitoSub: user, step: "official_land_record", runAt: new Date(Date.now() - 60_000) });
    const landRunAt = new Date(Date.now() + 2 * 60_000);
    await enqueue({ claimId, cognitoSub: user, step: "land_documents", runAt: landRunAt });

    const now = new Date();
    const results = await drain({ claimId, now: () => now });
    expect(results).toEqual([expect.objectContaining({ step: "official_land_record", outcome: "waiting_for_dependencies" })]);
    expect(ran).toEqual([]);
    const waiting = await VerificationJob.findOne({ claimId, step: "official_land_record" }).lean();
    expect(waiting).toMatchObject({ status: "queued", attempts: 0 });
    expect(waiting.runAt.getTime()).toBeGreaterThanOrEqual(landRunAt.getTime());
    expect(waiting.startedAt).toBeNull();

    // While land_documents is RUNNING it still waits.
    const later = new Date(landRunAt.getTime() + 1000);
    const landJob = await claimNext({ claimId, now: later, owner: "docs-runner" });
    expect(landJob.step).toBe("land_documents");
    const officialJob = await claimNext({ claimId, now: new Date(later.getTime() + 60_000), owner: "other" });
    expect(officialJob.step).toBe("official_land_record");
    expect((await runJob(officialJob, { now: new Date(later.getTime() + 60_000) })).outcome).toBe("waiting_for_dependencies");

    // Once land_documents is done, the record lookup runs.
    expect((await runJob(landJob, { now: later })).outcome).toBe("succeeded");
    await drain({ claimId, now: () => new Date(later.getTime() + 10 * 60_000) });
    expect(ran.map((entry) => entry.split(":")[0])).toEqual(["land_documents", "official_land_record"]);
  });

  it("VJ-19: a land document the model refused (429) makes the job retry, and the retry examines only that document", async () => {
    const { user, claimId } = await seedSubmittedClaim("landdoc-retry");
    const first = await attachLandDocument(user, claimId);
    const second = await attachLandDocument(user, claimId);
    await ensureDefaultExecutors();
    const { DEFAULT_EXECUTORS } = await import("../services/verificationSteps.js");
    setExecutor("land_documents", DEFAULT_EXECUTORS.land_documents);

    mockGenerate.mockResolvedValueOnce(reply(LAND_RECORD)).mockRejectedValueOnce(providerFailure(429));
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents" });
    const t0 = new Date();
    const [failed] = await drain({ claimId, now: () => t0 });
    expect(failed).toMatchObject({ step: "land_documents", outcome: "retry_scheduled", error: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true } });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    const examined = async (id) => Boolean((await VerificationEvidence.findById(id).lean()).result?.aiLandDocumentExamination);
    expect(await examined(first)).toBe(true);
    expect(await examined(second)).toBe(false);

    mockGenerate.mockResolvedValue(reply(LAND_RECORD));
    const [succeeded] = await drain({ claimId, now: () => new Date(t0.getTime() + HOUR) });
    expect(succeeded).toMatchObject({ step: "land_documents", outcome: "succeeded", summary: { documents: 2, examined: 1, skipped: 1, failed: 0 } });
    expect(mockGenerate).toHaveBeenCalledTimes(3); // the examined document was not sent again
    expect(await examined(second)).toBe(true);
    expect((await VerificationJob.findById(job._id).lean()).attempts).toBe(2);
  });

  it("VJ-19b: a land document that fails for a reason retrying cannot fix finishes the step with `failed: 1` — no retry, no review case; beside a retryable failure the retry carries the retryable kind", async () => {
    const { user, claimId } = await seedSubmittedClaim("landdoc-permanent");
    const first = await attachLandDocument(user, claimId);
    const second = await attachLandDocument(user, claimId);
    await ensureDefaultExecutors();
    const { DEFAULT_EXECUTORS } = await import("../services/verificationSteps.js");
    setExecutor("land_documents", DEFAULT_EXECUTORS.land_documents);
    const examined = async (id) => Boolean((await VerificationEvidence.findById(id).lean()).result?.aiLandDocumentExamination);
    const defect = () => new TypeError("Cannot read properties of undefined (reading 'text')");

    // An unrecognised error is an application defect (LD-15: recorded, not retryable).
    mockGenerate.mockResolvedValueOnce(reply(LAND_RECORD)).mockRejectedValueOnce(defect());
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "land_documents" });
    const [finished] = await drain({ claimId });
    expect(finished).toMatchObject({ step: "land_documents", outcome: "succeeded", summary: { documents: 2, examined: 1, skipped: 0, failed: 1 } });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect([await examined(first), await examined(second)]).toEqual([true, false]);
    const stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(stored.lastError.code).toBeNull();
    expect(stored.activeKey).toBeUndefined();
    expect(await reviewCasesOf(claimId)).toHaveLength(0);
    // Nothing is left for the engine to wait for.
    expect(await countBlockingActiveJobs(claimId)).toBe(0);

    // A defect beside a quota refusal: the job retries, named after the quota, so it keeps the full
    // attempt budget instead of a defect's three.
    const mixed = await seedSubmittedClaim("landdoc-mixed");
    await attachLandDocument(mixed.user, mixed.claimId);
    await attachLandDocument(mixed.user, mixed.claimId);
    mockGenerate.mockReset();
    mockGenerate.mockRejectedValueOnce(defect()).mockRejectedValueOnce(providerFailure(429));
    const retrying = await enqueue({ claimId: mixed.claimId, cognitoSub: mixed.user, step: "land_documents" });
    const [retried] = await drain({ claimId: mixed.claimId });
    expect(retried).toMatchObject({ step: "land_documents", outcome: "retry_scheduled", error: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true } });
    expect(await VerificationJob.findById(retrying.job._id).lean()).toMatchObject({ status: "queued", attempts: 1, maxAttempts: 7 });
  });

  it("VJ-20: under every policy the engine decides without waiting for satellite, even one rescheduled three weeks ahead", async () => {
    for (const id of ["v1-legacy", "v2-components", "v1.1-safe-ai"]) {
      const policy = resolvePolicy(id);
      expect(blockingStepsFor("engine", policy)).not.toContain("satellite");
      const { user, claimId } = await seedSubmittedClaim(`nowait-${id}`);
      const satellite = await enqueue({ claimId, cognitoSub: user, step: "satellite", runAt: new Date(Date.now() + 21 * 86400000) });
      await enqueue({ claimId, cognitoSub: user, step: "engine" });
      expect(await countBlockingActiveJobs(claimId, policy)).toBe(0);
      const results = await drain({ claimId, policy });
      expect(results).toEqual([expect.objectContaining({ step: "engine", outcome: "succeeded" })]);
      expect((await VerificationJob.findById(satellite.job._id).lean()).status).toBe("queued");

      // A RUNNING satellite job does not hold the engine either.
      await VerificationJob.updateOne({ _id: satellite.job._id }, { $set: { status: "running", leaseOwner: "sat", leaseUntil: new Date(Date.now() + HOUR) } });
      await enqueue({ claimId, cognitoSub: user, step: "engine" });
      expect((await drain({ claimId, policy })).map((result) => result.outcome)).toEqual(["succeeded"]);

      // The decision inputs still block under every policy (weather included).
      await enqueue({ claimId, cognitoSub: user, step: "weather", runAt: new Date(Date.now() + HOUR) });
      await enqueue({ claimId, cognitoSub: user, step: "engine" });
      expect(await countBlockingActiveJobs(claimId, policy)).toBe(1);
      expect((await drain({ claimId, policy })).map((result) => result.outcome)).toEqual(["waiting_for_other_steps"]);
    }
    expect(ran.filter((entry) => entry.startsWith("satellite"))).toEqual([]);

    // A satellite provider refusal is tried again an hour later without using an attempt (at most
    // three times), while the engine has long decided.
    await ensureDefaultExecutors();
    const { DEFAULT_EXECUTORS } = await import("../services/verificationSteps.js");
    setExecutor("satellite", DEFAULT_EXECUTORS.satellite);
    mockSatellite.mockResolvedValue({ recorded: true, run: { outcome: "QUOTA_EXCEEDED", evidenceStatus: "UNAVAILABLE" }, rescheduleAt: null });
    const { user, claimId } = await seedSubmittedClaim("sat-transient");
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "satellite" });
    let clock = Date.now();
    for (let round = 1; round <= 3; round += 1) {
      const [result] = await drain({ claimId, now: () => new Date(clock) });
      expect(result).toMatchObject({ step: "satellite", outcome: "rescheduled", summary: { transient: true, status: "UNAVAILABLE" } });
      const stored = await VerificationJob.findById(job._id).lean();
      expect(stored).toMatchObject({ status: "queued", attempts: 0, rescheduleCount: round });
      expect(stored.runAt.getTime() - clock).toBe(HOUR);
      clock = stored.runAt.getTime();
    }
    const [last] = await drain({ claimId, now: () => new Date(clock) });
    expect(last).toMatchObject({ step: "satellite", outcome: "succeeded", summary: { transient: false } });
    expect(mockSatellite).toHaveBeenCalledTimes(4);
  });

  it("VJ-21: the engine is put back no earlier than the first step it waits for", async () => {
    const { user, claimId } = await seedSubmittedClaim("putback");
    const aiRunAt = new Date(Date.now() + 45 * 60_000);
    await enqueue({ claimId, cognitoSub: user, step: "ai_assessment", runAt: aiRunAt });
    await enqueue({ claimId, cognitoSub: user, step: "land_documents", runAt: new Date(Date.now() + 3 * HOUR) });
    const engine = await enqueue({ claimId, cognitoSub: user, step: "engine" });

    const now = new Date();
    const [result] = await drain({ claimId, now: () => now });
    expect(result.outcome).toBe("waiting_for_other_steps");
    let stored = await VerificationJob.findById(engine.job._id).lean();
    expect(stored.runAt.getTime()).toBeGreaterThanOrEqual(aiRunAt.getTime());
    expect(stored.runAt.getTime()).toBeLessThan(aiRunAt.getTime() + 60_000);
    // Waiting is not an attempt: nothing is counted or logged as one.
    expect(stored).toMatchObject({ status: "queued", attempts: 0, startedAt: null, lastAttemptAt: null });
    expect(stored.attemptLog ?? []).toEqual([]);

    // A blocker that is already due or running: the engine looks again after the short wait.
    await VerificationJob.updateOne({ claimId, step: "ai_assessment" }, { $set: { status: "running", leaseOwner: "busy", leaseUntil: new Date(now.getTime() + HOUR) } });
    await VerificationJob.updateOne({ _id: engine.job._id }, { $set: { runAt: now } });
    await drain({ claimId, now: () => now });
    stored = await VerificationJob.findById(engine.job._id).lean();
    expect(stored.runAt.getTime()).toBe(now.getTime() + 15_000);
  });

  it("VJ-22: jobs of a withdrawn or deleted claim are cancelled before they run — no executor call, no review case", async () => {
    // Queued before the claim was withdrawn (an older release did not cancel on withdrawal).
    const { user, claimId } = await seedSubmittedClaim("withdrawn");
    for (const step of ["ai_assessment", "satellite", "engine"]) await enqueue({ claimId, cognitoSub: user, step });
    await LossClaim.updateOne({ _id: claimId }, { $set: { state: "withdrawn" } });
    const results = await drain({ claimId });
    expect(results.map((result) => result.outcome)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(ran).toEqual([]);
    const jobs = await VerificationJob.find({ claimId }).lean();
    for (const job of jobs) {
      expect(job).toMatchObject({ status: "cancelled", cancelReason: "claim_withdrawn", attempts: 0 });
      expect(job.activeKey).toBeUndefined();
      expect(job.cancelledAt).toBeInstanceOf(Date);
    }

    // Withdrawn while a step runs: the failure ends in `cancelled`, not a retry, a death or a case.
    const midway = await seedSubmittedClaim("withdrawn-midway");
    setExecutor("ai_assessment", async (job) => {
      await LossClaim.updateOne({ _id: job.claimId }, { $set: { state: "withdrawn" } });
      throw providerFailure(503);
    });
    await enqueue({ claimId: midway.claimId, cognitoSub: midway.user, step: "ai_assessment", maxAttempts: 1 });
    await enqueue({ claimId: midway.claimId, cognitoSub: midway.user, step: "engine", runAt: new Date(Date.now() + 1000) });
    const [aiResult] = await drain({ claimId: midway.claimId });
    expect(aiResult).toMatchObject({ step: "ai_assessment", outcome: "cancelled" });
    await drain({ claimId: midway.claimId, now: () => new Date(Date.now() + 5000) });
    const midwayJobs = await VerificationJob.find({ claimId: midway.claimId }).lean();
    expect(midwayJobs.map((job) => [job.step, job.status])).toEqual([["ai_assessment", "cancelled"], ["engine", "cancelled"]]);
    expect(ran.filter((entry) => entry.startsWith("engine"))).toEqual([]);

    // A claim that no longer exists.
    const gone = await seedSubmittedClaim("deleted");
    await enqueue({ claimId: gone.claimId, cognitoSub: gone.user, step: "weather" });
    await LossClaim.deleteOne({ _id: gone.claimId });
    expect((await drain({ claimId: gone.claimId }))[0]).toMatchObject({ outcome: "cancelled", reason: "claim_missing" });

    for (const id of [claimId, midway.claimId, gone.claimId]) expect(await reviewCasesOf(id)).toHaveLength(0);
  });

  it("VJ-23: transient dead jobs are re-queued after the cool-down, at most two rounds; auth_config waits for a person", async () => {
    const { user, claimId } = await seedSubmittedClaim("requeue");
    const now = new Date();
    const dead = (step, kind, hoursAgo, extra = {}) =>
      VerificationJob.create({
        claimId, cognitoSub: user, step, status: "dead", attempts: 7, maxAttempts: 7, runAt: new Date(now.getTime() - hoursAgo * HOUR),
        lastError: { code: `CODE_${kind}`, message: "x", kind, retryable: kind !== "application_defect", at: new Date(now.getTime() - hoursAgo * HOUR) },
        deadAt: new Date(now.getTime() - hoursAgo * HOUR), correlationId: `clm_${claimId}_r1`, ...extra,
      });
    const quota = await dead("ai_assessment", "quota", 7);
    const auth = await dead("land_documents", "auth_config", 7);
    const recent = await dead("official_land_record", "overload", 1);

    const first = await recoverDeadJobs({ now });
    expect(first).toMatchObject({ requeued: 1, engineQueued: 1 });
    const replacement = await VerificationJob.findOne({ claimId, step: "ai_assessment", status: "queued" }).lean();
    expect(replacement).toMatchObject({ recoveryRound: 1, attempts: 0, correlationId: `clm_${claimId}_r1` });
    expect(String(replacement.recoveredFrom)).toBe(String(quota._id));
    expect((await VerificationJob.findById(quota._id).lean()).requeuedAt).toBeInstanceOf(Date);
    expect(await VerificationJob.countDocuments({ claimId, step: "engine", status: "queued" })).toBe(1);
    expect((await VerificationJob.findById(auth._id).lean()).requeuedAt).toBeNull(); // a person must fix the key first
    expect((await VerificationJob.findById(recent._id).lean()).requeuedAt).toBeNull(); // cool-down not over

    // The same sweep again does nothing new.
    expect((await recoverDeadJobs({ now })).requeued).toBe(0);

    // Round 2 is allowed, round 3 is not.
    await VerificationJob.updateOne({ _id: replacement._id }, { $set: { status: "dead", deadAt: new Date(now.getTime() - 7 * HOUR), lastError: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true, at: now } }, $unset: { activeKey: "" } });
    expect((await recoverDeadJobs({ now })).requeued).toBe(1);
    const round2 = await VerificationJob.findOne({ claimId, step: "ai_assessment", status: "queued" }).lean();
    expect(round2.recoveryRound).toBe(2);
    await VerificationJob.updateOne({ _id: round2._id }, { $set: { status: "dead", deadAt: new Date(now.getTime() - 7 * HOUR), lastError: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true, at: now } }, $unset: { activeKey: "" } });
    expect((await recoverDeadJobs({ now })).requeued).toBe(0);
    expect(await VerificationJob.countDocuments({ claimId, step: "ai_assessment" })).toBe(3);

    // An admin (or the CLI) re-queues the auth_config job once the key is fixed.
    const manual = await requeueDeadJobs({ claimId, steps: ["land_documents"], actor: "admin", now });
    expect(manual.requeued).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId, step: "land_documents", status: "queued" })).toBe(1);
    expect([...AUTO_RECOVERABLE_KINDS].sort()).toEqual(["network", "overload", "quota", "storage", "timeout"]);

    // Dead jobs of a claim that is no longer submitted are left alone.
    const withdrawn = await seedSubmittedClaim("requeue-withdrawn");
    await VerificationJob.create({
      claimId: withdrawn.claimId, cognitoSub: withdrawn.user, step: "ai_assessment", status: "dead", deadAt: new Date(now.getTime() - 7 * HOUR),
      lastError: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true, at: now },
    });
    await LossClaim.updateOne({ _id: withdrawn.claimId }, { $set: { state: "withdrawn" } });
    // Not even a candidate (VJ-23b): such a row must never take a slot of the batch.
    expect(await recoverDeadJobs({ now })).toMatchObject({ considered: 0, requeued: 0, skipped: 0 });
    expect((await VerificationJob.findOne({ claimId: withdrawn.claimId }).lean()).requeuedAt).toBeNull();
  });

  it("VJ-23b: dead rows of decided or withdrawn claims never fill the recovery batch, so a recoverable job of a submitted claim is still re-queued", async () => {
    const now = new Date();
    const decided = await seedSubmittedClaim("requeue-decided");
    const gone = await seedSubmittedClaim("requeue-gone");
    await LossClaim.updateOne({ _id: decided.claimId }, { $set: { state: "verified" } });
    await LossClaim.updateOne({ _id: gone.claimId }, { $set: { state: "withdrawn" } });
    // 60 weather jobs that died in an outage (timeout: an automatically recoverable kind), all older
    // than the job that matters, so an oldest-first batch of 50 would hold nothing else.
    await VerificationJob.insertMany(
      Array.from({ length: 60 }, (_, i) => {
        const owner = i % 2 === 0 ? decided : gone;
        const at = new Date(now.getTime() - 30 * HOUR + i * 1000);
        return {
          claimId: owner.claimId, cognitoSub: owner.user, step: "weather", status: "dead", attempts: 5, maxAttempts: 5, runAt: at, deadAt: at,
          lastError: { code: "PROVIDER_TIMEOUT", message: "x", kind: "timeout", retryable: true, at },
        };
      })
    );
    const live = await seedSubmittedClaim("requeue-live");
    const diedAt = new Date(now.getTime() - 7 * HOUR);
    const quota = await VerificationJob.create({
      claimId: live.claimId, cognitoSub: live.user, step: "ai_assessment", status: "dead", attempts: 7, maxAttempts: 7, runAt: diedAt, deadAt: diedAt,
      lastError: { code: "PROVIDER_QUOTA", message: "x", kind: "quota", retryable: true, at: diedAt },
    });

    expect(await recoverDeadJobs({ now })).toMatchObject({ considered: 1, requeued: 1, skipped: 0, engineQueued: 1 });
    const replacement = await VerificationJob.findOne({ claimId: live.claimId, step: "ai_assessment", status: "queued" }).lean();
    expect(String(replacement.recoveredFrom)).toBe(String(quota._id));
    // A smaller batch (the CLI's --limit) reaches the submitted claim's rows just the same.
    await VerificationJob.updateOne(
      { _id: replacement._id },
      { $set: { status: "dead", deadAt: diedAt, lastError: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true, at: diedAt } }, $unset: { activeKey: "" } }
    );
    expect(await requeueDeadJobs({ kinds: ["quota"], limit: 1, dryRun: true, now })).toMatchObject({ considered: 1, requeued: 1 });

    // The stale rows stay dead and unmarked (nothing replaced them), and later sweeps still pass over them.
    expect(await VerificationJob.countDocuments({ step: "weather", status: "dead", requeuedAt: null })).toBe(60);
    expect(await VerificationJob.countDocuments({ step: "weather", status: { $ne: "dead" } })).toBe(0);
    expect(await recoverDeadJobs({ now })).toMatchObject({ considered: 1, requeued: 1 });
    expect(await recoverDeadJobs({ now })).toMatchObject({ considered: 0, requeued: 0 });
  });

  it("VJ-24: the worker returns a claim stuck in processing to submitted and queues its engine; a decided claim is left alone", async () => {
    const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
    const stuck = await seedSubmittedClaim("stuck");
    await LossClaim.updateOne({ _id: stuck.claimId }, { $set: { state: "processing", processedAt: minutesAgo(20) } });
    const decided = await seedSubmittedClaim("stuck-decided");
    await LossClaim.updateOne({ _id: decided.claimId }, { $set: { state: "processing", processedAt: minutesAgo(20) } });
    await ClaimAssessment.create({ claimId: decided.claimId, status: "completed", state: "verified", verification: { status: "completed" } });
    const recent = await seedSubmittedClaim("stuck-recent");
    await LossClaim.updateOne({ _id: recent.claimId }, { $set: { state: "processing", processedAt: minutesAgo(5) } });

    expect((await releaseStuckProcessingClaims({ dryRun: true })).released).toBe(1);
    expect((await LossClaim.findById(stuck.claimId)).state).toBe("processing"); // the dry run wrote nothing

    const result = await drainDueJobs({ deadline: Date.now() + 20000 });
    expect(result.sweep.stuckClaimsReleased).toBe(1);
    expect((await LossClaim.findById(stuck.claimId)).state).toBe("submitted");
    expect(await ClaimAudit.countDocuments({ claimId: stuck.claimId, action: "verification_released" })).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId: stuck.claimId, step: "engine", status: "queued" })).toBe(1);
    expect((await LossClaim.findById(decided.claimId)).state).toBe("processing");
    expect((await LossClaim.findById(recent.claimId)).state).toBe("processing");
    expect(await VerificationJob.countDocuments({ claimId: { $in: [decided.claimId, recent.claimId] } })).toBe(0);
  });

  it("VJ-24b: 60 decided-but-processing claims never starve a really stuck claim out of the 50-claim sweep; they are reported, not released", async () => {
    const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
    const template = await seedSubmittedClaim("stuck-template");
    const raw = await LossClaim.collection.findOne({ _id: new mongoose.Types.ObjectId(template.claimId) });
    // 60 claims already decided (the decision written) but left in `processing`, OLDER than the stuck one.
    const decidedIds = Array.from({ length: 60 }, () => new mongoose.Types.ObjectId());
    await LossClaim.collection.insertMany(
      decidedIds.map((_id, index) => ({ ...raw, _id, idempotencyKey: `idem-decided-${index}`, state: "processing", processedAt: minutesAgo(60 + index), evidence: [] }))
    );
    await ClaimAssessment.collection.insertMany(decidedIds.map((claimId) => ({ claimId, status: "completed", state: "verified", verification: { status: "completed" } })));
    const stuck = await seedSubmittedClaim("stuck-starved");
    await LossClaim.updateOne({ _id: stuck.claimId }, { $set: { state: "processing", processedAt: minutesAgo(20) } });

    const preview = await releaseStuckProcessingClaims({ dryRun: true, limit: 50 });
    expect(preview).toMatchObject({ checked: 1, released: 1, claimIds: [String(stuck.claimId)], decidedButProcessing: 50 });
    const swept = await releaseStuckProcessingClaims({ limit: 50 });
    expect(swept).toMatchObject({ checked: 1, released: 1, claimIds: [String(stuck.claimId)] });
    expect((await LossClaim.findById(stuck.claimId)).state).toBe("submitted");
    expect(await VerificationJob.countDocuments({ claimId: stuck.claimId, step: "engine", status: "queued" })).toBe(1);
    // The decided ones are flagged, never released or re-run.
    expect(await LossClaim.countDocuments({ _id: { $in: decidedIds }, state: "processing" })).toBe(60);
    expect(await VerificationJob.countDocuments({ claimId: { $in: decidedIds } })).toBe(0);
    // Even with limit 1 the stuck one is found first time (they are excluded in the query).
    await LossClaim.updateOne({ _id: stuck.claimId }, { $set: { state: "processing", processedAt: minutesAgo(20) } });
    expect(await releaseStuckProcessingClaims({ dryRun: true, limit: 1 })).toMatchObject({ checked: 1, released: 1 });
  });

  it("VJ-24c: a claim whose engine job is still running under a live (heartbeat-renewed) lease is not released; once that lease has expired it is", async () => {
    const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
    const { user, claimId } = await seedSubmittedClaim("stuck-live-engine");
    await LossClaim.updateOne({ _id: claimId }, { $set: { state: "processing", processedAt: minutesAgo(20) } });
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "engine" });
    await VerificationJob.updateOne({ _id: job._id }, { $set: { status: "running", leaseOwner: "slow-but-alive", leaseUntil: new Date(Date.now() + 60_000), startedAt: minutesAgo(20) } });

    expect(await releaseStuckProcessingClaims({ dryRun: true })).toMatchObject({ checked: 0, released: 0 });
    expect(await releaseStuckProcessingClaims({})).toMatchObject({ checked: 0, released: 0 });
    expect((await LossClaim.findById(claimId)).state).toBe("processing");
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_released" })).toBe(0);

    // The run died: its lease lapsed with no heartbeat. Now the claim is released.
    await VerificationJob.updateOne({ _id: job._id }, { $set: { leaseUntil: minutesAgo(1) } });
    expect(await releaseStuckProcessingClaims({})).toMatchObject({ checked: 1, released: 1 });
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_released" })).toBe(1);
  });

  it("VJ-25: an engine that keeps reporting 'in progress' is rescheduled without using attempts, then dies into a review case after 30", async () => {
    const { user, claimId } = await seedSubmittedClaim("inprogress");
    setExecutor("engine", async (_job, { now }) => ({ claimState: "submitted", inProgress: true, rescheduleAt: new Date(now.getTime() + 60_000) }));
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "engine" });

    let clock = Date.now();
    const [first] = await drain({ claimId, now: () => new Date(clock) });
    expect(first.outcome).toBe("rescheduled");
    expect(await VerificationJob.findById(job._id).lean()).toMatchObject({ status: "queued", attempts: 0, rescheduleCount: 1 });

    for (let round = 0; round < ENGINE_MAX_RESCHEDULES + 10; round += 1) {
      clock += 10 * 60_000;
      await drain({ claimId, now: () => new Date(clock) });
      if ((await VerificationJob.findById(job._id).lean()).status === "dead") break;
    }
    const dead = await VerificationJob.findById(job._id).lean();
    expect(dead).toMatchObject({ status: "dead", rescheduleCount: ENGINE_MAX_RESCHEDULES });
    expect(dead.lastError).toMatchObject({ code: "ENGINE_STUCK", kind: "application_defect", retryable: false });
    expect(dead.attempts).toBe(3); // a defect is capped at three attempts
    const cases = await reviewCasesOf(claimId);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ source: "GEOMETRY" });
    expect(cases[0].result.reviewReasons).toEqual(["automated_step_failed_engine"]);
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");
  });

  it("VJ-25b: a photo check out of time saves its progress and runs again a second later; one whose slot another runner holds looks again a minute later — neither uses an attempt", async () => {
    const { user, claimId } = await seedSubmittedClaim("ai-partial");
    await seedPhotos(claimId, 3);
    await ensureDefaultExecutors();
    const { DEFAULT_EXECUTORS } = await import("../services/verificationSteps.js");
    setExecutor("ai_assessment", DEFAULT_EXECUTORS.ai_assessment);
    mockGenerate.mockImplementation(async () => {
      await sleep(2000);
      return reply(PHOTO);
    });
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "ai_assessment", runAt: new Date(Date.now() - 60_000) });

    // 9.5 s of real time before the deadline: one 2 s photo, then less than the 8 s a photo needs.
    // The drain's clock reads 16 s before the deadline, so the queue's own 15 s minimum lets it start.
    const deadline = Date.now() + 9500;
    const t0 = new Date(deadline - 16_000);
    const [partial] = await drain({ claimId, deadline, now: () => t0 });
    expect(partial).toMatchObject({ step: "ai_assessment", outcome: "rescheduled", summary: { status: "processing", partial: true } });
    let stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "queued", attempts: 0, rescheduleCount: 1 });
    expect(stored.runAt.getTime()).toBe(t0.getTime() + 1000);
    expect(stored.attemptLog.map((entry) => entry.outcome)).toEqual(["rescheduled"]);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect((await ClaimAssessment.findOne({ claimId }).lean()).aiImageAssessments).toHaveLength(1);

    // The next drain resumes after the photo already assessed, and the step finishes.
    mockGenerate.mockImplementation(async () => reply(PHOTO));
    const [done] = await drain({ claimId, now: () => new Date(t0.getTime() + 1000) });
    expect(done).toMatchObject({ step: "ai_assessment", outcome: "succeeded", summary: { status: "completed" } });
    expect(mockGenerate).toHaveBeenCalledTimes(3);
    stored = await VerificationJob.findById(job._id).lean();
    expect(stored).toMatchObject({ status: "succeeded", attempts: 1, rescheduleCount: 1 });
    expect(await ClaimAssessment.findOne({ claimId }).lean()).toMatchObject({ status: "completed", aiAggregate: { imageCount: 3 } });

    // Another runner holds the photo slot (a live slot lease): look again in a minute, no model call.
    mockGenerate.mockClear();
    const held = await seedSubmittedClaim("ai-other-runner");
    await seedPhotos(held.claimId, 1);
    await ClaimAssessment.create({ claimId: held.claimId, status: "processing", evidenceVersion: "other-run", startedAt: new Date(), slotLeaseUntil: new Date(Date.now() + HOUR) });
    const waiting = await enqueue({ claimId: held.claimId, cognitoSub: held.user, step: "ai_assessment" });
    const t1 = new Date();
    const [recheck] = await drain({ claimId: held.claimId, now: () => t1 });
    expect(recheck).toMatchObject({ step: "ai_assessment", outcome: "rescheduled", summary: { status: "processing", partial: false } });
    const later = await VerificationJob.findById(waiting.job._id).lean();
    expect(later).toMatchObject({ status: "queued", attempts: 0, rescheduleCount: 1 });
    expect(later.runAt.getTime()).toBe(t1.getTime() + 60_000);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("VJ-26: an application defect dies within three attempts; a quota refusal keeps its full attempt budget", async () => {
    const { user, claimId } = await seedSubmittedClaim("defect");
    setExecutor("ai_assessment", async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); });
    setExecutor("land_documents", async () => { throw providerFailure(429); });
    const ai = await enqueue({ claimId, cognitoSub: user, step: "ai_assessment" });
    const docs = await enqueue({ claimId, cognitoSub: user, step: "land_documents" });
    expect([ai.job.maxAttempts, docs.job.maxAttempts]).toEqual([7, 7]);

    let clock = Date.now();
    for (let round = 0; round < 3; round += 1) {
      clock += 4 * HOUR;
      await drain({ claimId, now: () => new Date(clock) });
    }
    const defect = await VerificationJob.findById(ai.job._id).lean();
    expect(defect).toMatchObject({ status: "dead", attempts: 3 });
    expect(defect.lastError).toMatchObject({ code: "error", kind: "application_defect", retryable: false });
    const quota = await VerificationJob.findById(docs.job._id).lean();
    expect(quota).toMatchObject({ status: "queued", attempts: 3 });
    const cases = await reviewCasesOf(claimId);
    expect(cases).toHaveLength(1);
    expect(cases[0].metadata).toMatchObject({ failedStep: "ai_assessment", errorKind: "application_defect" });
  });
});

describe("default executors", () => {
  it("VJ-13: the steps module provides a real executor for every job step", async () => {
    const { ensureDefaultExecutors } = await import("../services/verificationJobs.service.js");
    const { PROVIDED_STEPS } = await import("../services/verificationSteps.js");
    const { JOB_STEPS } = await import("../models/VerificationJob.js");
    await ensureDefaultExecutors();
    // Without these the queue would fail every step with "no executor" in production.
    expect([...PROVIDED_STEPS].sort()).toEqual([...JOB_STEPS].sort());
  });
});
