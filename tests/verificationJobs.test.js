import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CLAIM_VERIFICATION_POLICY = "v2-components";
});

import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import {
  claimNext,
  drain,
  enqueue,
  enqueuePlan,
  runJob,
  setExecutor,
} from "../services/verificationJobs.service.js";
import { drainDueJobs, sweepStaleHolds } from "../services/verificationWorker.service.js";
import { api, authHeader, clearTestDatabase, seedProfile, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";

// ADR-021 — durable job queue. Executors are replaced with fakes: this suite is about scheduling,
// deduplication, recovery and failure handling, not about the providers.

let seq = 0;
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const STEPS = ["ai_assessment", "land_documents", "official_land_record", "satellite", "weather", "engine"];

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
    for (const model of [LossClaim, ClaimAssessment, ClaimAudit, VerificationEvidence, VerificationJob]) await model.deleteMany({});
    ran.length = 0;
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
    await enqueue({ claimId, cognitoSub: user, step: "satellite" });
    await drain({ claimId });
    const order = ran.map((entry) => entry.split(":")[0]);
    expect(order).toEqual(["satellite"]);
    expect((await VerificationJob.findOne({ claimId, step: "engine" })).status).toBe("queued");
    // The engine was put back without being counted as an attempt.
    expect((await VerificationJob.findOne({ claimId, step: "engine" })).attempts).toBe(0);

    await VerificationJob.updateOne({ claimId, step: "engine" }, { $set: { runAt: new Date(Date.now() - 1000) } });
    await drain({ claimId });
    expect(ran.map((entry) => entry.split(":")[0])).toEqual(["satellite", "engine"]);
  });

  it("VJ-5: a failing step is retried with backoff, then dies into a review case and never a decision", async () => {
    const { user, claimId } = await seedSubmittedClaim("dead");
    setExecutor("satellite", async () => { throw Object.assign(new Error("provider exploded"), { code: "provider_error" }); });
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "satellite", maxAttempts: 2 });

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
    expect(reviewCases[0].result.reviewReasons).toEqual(["automated_step_failed_satellite"]);
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
