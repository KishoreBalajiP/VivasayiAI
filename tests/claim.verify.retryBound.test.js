import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Stage-1 review follow-up (plan A4/D2): under v1.1-safe-ai a persistent provider failure must not keep
// starting new photo-check chains. The worry was queuePhotoCheckRetry (services/claimVerification.service.js),
// which enqueues an ai_assessment job at recovery round 0 when the engine's own inline check fails.
// Confirmed bounded, and pinned here: the engine never re-runs a photo check that already FAILED for the
// same evidence set (`failedForThisEvidence`), so a round-0 chain can only start once per evidence version
// (new photos), and each chain stops after the automatic recovery rounds (2). Simulated over ~250 hours
// of worker batches with repeated re-evaluations; the model keeps answering 429.
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
  process.env.VERIFICATION_MAX_ATTEMPTS = '{"ai_assessment":2}';
});
const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));

import LossClaim from "../models/LossClaim.js";
import VerificationJob from "../models/VerificationJob.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { DEFAULT_MAX_RECOVERY_ROUNDS, ensureDefaultExecutors } from "../services/verificationJobs.service.js";
import { drainDueJobs, requestReevaluation } from "../services/verificationWorker.service.js";
import { startTestDatabase, stopTestDatabase } from "./helpers.js";
import { createClaim, fakeSupportingExecutors, providerFailure, resetDatabase, seedFarmer, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const HALF_HOUR = 30 * 60_000;

describe("photo-check retries stay bounded under a persistent provider failure (SA-10)", () => {
  let mongo;
  let clock;
  const batches = async (count) => {
    for (let i = 0; i < count; i += 1) {
      await drainDueJobs({ deadline: clock + 60_000, now: () => new Date(clock), maxJobs: 25 });
      clock += HALF_HOUR;
    }
  };
  const aiJobs = (claimId) => VerificationJob.find({ claimId, step: "ai_assessment" }).sort({ createdAt: 1, _id: 1 }).lean();

  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });

  it("SA-10: 429 forever: one chain of 1 + 2 recovery rounds per evidence version, no new chain on re-evaluation, a lost late-photo plan starts exactly one more", async () => {
    await resetDatabase();
    fakeSupportingExecutors();
    mocks.generate.mockReset();
    mocks.generate.mockRejectedValue(providerFailure(429));
    const farmer = await seedFarmer("sa10");
    const claimId = await createClaim(farmer);
    await uploadPhoto(farmer.user, claimId);
    await submitClaim(farmer.user, claimId);
    clock = Date.now();

    // ~200 hours of worker batches (the dead-job recovery cool-down is 6 h).
    await batches(400);
    let jobs = await aiJobs(claimId);
    expect(jobs.map((job) => `${job.status}:r${job.recoveryRound || 0}`)).toEqual(["dead:r0", "dead:r1", "dead:r2"]);
    expect(DEFAULT_MAX_RECOVERY_ROUNDS).toBe(2);
    expect(mocks.generate).toHaveBeenCalledTimes(3 * 2); // three chains x two attempts
    expect((await LossClaim.findById(claimId).lean()).state).toBe("submitted"); // held, never decided adversely

    // Repeated re-evaluations of the held claim (reviewer actions, sweeps): the engine does not call the
    // provider again for photos whose check already failed, and starts no new chain.
    for (let round = 0; round < 5; round += 1) {
      await requestReevaluation({ claimId, cognitoSub: farmer.user });
      await batches(40);
    }
    expect(await aiJobs(claimId)).toHaveLength(3);
    expect(mocks.generate).toHaveBeenCalledTimes(6);

    // A new photo whose late plan was lost: the engine's inline check fails once and hands the new
    // evidence set to the queue (queuePhotoCheckRetry, round 0). That chain is bounded the same way.
    await uploadPhoto(farmer.user, claimId);
    await VerificationJob.updateMany({ claimId, status: "queued" }, { $set: { status: "cancelled" }, $unset: { activeKey: "" } });
    for (let round = 0; round < 8; round += 1) {
      await requestReevaluation({ claimId, cognitoSub: farmer.user });
      await batches(60);
    }
    jobs = (await aiJobs(claimId)).filter((job) => job.status !== "cancelled");
    expect(jobs.map((job) => `${job.status}:r${job.recoveryRound || 0}`)).toEqual(["dead:r0", "dead:r1", "dead:r2", "dead:r0", "dead:r1", "dead:r2"]);
    expect(jobs.every((job) => (job.recoveryRound || 0) <= DEFAULT_MAX_RECOVERY_ROUNDS)).toBe(true);
    expect(mocks.generate).toHaveBeenCalledTimes(6 + 1 + 3 * 2); // one inline check + three chains x two attempts
    // And still nothing more afterwards.
    await requestReevaluation({ claimId, cognitoSub: farmer.user });
    await batches(100);
    expect(mocks.generate).toHaveBeenCalledTimes(13);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("submitted");
    // Each dead chain is visible to a reviewer (review cases are de-duplicated by reason).
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
