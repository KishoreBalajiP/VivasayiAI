import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A7, owner decision D7) — the worker is a separate PROCESS that can die at any moment.
// WK-7: a worker killed with SIGKILL in the middle of a step loses nothing: once its lease expires a
// second worker takes the job over (attempt 2) and the claim is decided exactly once.
// WK-8: SIGTERM stops a worker gracefully: the job in flight finishes, nothing new starts, exit 0.
// The child runs the real worker command line with fake step executors and a loopback-only network
// guard (tests/fixtures/slowWorkerBootstrap.js); the takeover here runs the real photo check and
// engine against a replaced model.
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
});
const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));

import LossClaim from "../models/LossClaim.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import VerificationJob from "../models/VerificationJob.js";
import { drain, enqueue, ensureDefaultExecutors } from "../services/verificationJobs.service.js";
import { startTestDatabase, stopTestDatabase } from "./helpers.js";
import { OBSERVATIONS, createClaim, fakeSupportingExecutors, modelAnswer, resetDatabase, seedFarmer, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = "tests/fixtures/slowWorkerBootstrap.js";
const LEASE_MS = 1500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startWorker = (env) => {
  const childEnv = { ...process.env, VIVASAYI_SKIP_DOTENV: "1", LOG_LEVEL: "silent", VERIFICATION_LEASE_MS: String(LEASE_MS), VERIFICATION_HEARTBEAT_MS: "300", WORKER_POLL_INTERVAL_MS: "100", ...env };
  delete childEnv.NODE_OPTIONS;
  const child = spawn(process.execPath, [BOOTSTRAP], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, output, exited };
};
const waitFor = async (check, { timeoutMs = 30_000, stepMs = 50, what = "condition" } = {}) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe("worker process crash recovery (WK-7, WK-8)", () => {
  let mongo;
  let uri;
  const running = [];
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    uri = mongo.getUri("parcel-foundation-test");
    fakeSupportingExecutors();
    await ensureDefaultExecutors(); // the real photo check and engine, for the takeover
  });
  afterAll(async () => {
    for (const worker of running) worker.child.kill("SIGKILL");
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
  });

  it("WK-7: a worker SIGKILLed mid-step is taken over after its lease expires; the claim is decided once and the job shows attempts=2", async () => {
    const farmer = await seedFarmer("wk7");
    const claimId = await createClaim(farmer);
    await uploadPhoto(farmer.user, claimId);
    await submitClaim(farmer.user, claimId);
    // The plan's photo check is due first; the child worker hangs inside it.
    const worker = startWorker({ MONGO_URI: uri, WORKER_FIXTURE_SLOW_STEP: "ai_assessment", WORKER_FIXTURE_SLOW_MS: "60000" });
    running.push(worker);
    const inFlight = await waitFor(
      () => VerificationJob.findOne({ claimId, step: "ai_assessment", status: "running", attempts: 1, lastAttemptAt: { $ne: null } }).lean(),
      { what: `the child to start the photo check (${worker.output.stderr})` }
    );
    // Its heartbeat keeps the lease alive while it works.
    const firstLease = inFlight.leaseUntil.getTime();
    await waitFor(async () => (await VerificationJob.findById(inFlight._id).lean()).leaseUntil.getTime() > firstLease, { what: "a lease renewal" });

    worker.child.kill("SIGKILL");
    expect(await worker.exited).toMatchObject({ signal: "SIGKILL" });
    const orphaned = await VerificationJob.findById(inFlight._id).lean();
    expect(orphaned).toMatchObject({ status: "running", attempts: 1 });
    expect(mocks.generate).not.toHaveBeenCalled();

    // Before the lease runs out nobody can take the job; afterwards a second worker does.
    expect(await drain({ claimId, maxJobs: 1 })).toEqual(expect.not.arrayContaining([expect.objectContaining({ step: "ai_assessment" })]));
    await waitFor(async () => (await VerificationJob.findById(inFlight._id).lean()).leaseUntil.getTime() < Date.now(), { what: "the lease to expire" });
    for (let i = 0; i < 20 && (await VerificationJob.countDocuments({ claimId, status: { $in: ["queued", "running"] } })) > 0; i += 1) {
      await drain({ claimId, now: () => new Date(Date.now() + i * 60_000), maxJobs: 10 });
    }

    const recovered = await VerificationJob.findById(inFlight._id).lean();
    expect(recovered).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(recovered.attemptLog.map((entry) => [entry.attempt, entry.outcome])).toEqual([[1, null], [2, "succeeded"]]);
    expect(recovered.leaseOwner).toBeNull();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    expect(await ClaimAudit.countDocuments({ claimId, action: "verified" })).toBe(1);
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_started" })).toBe(1);
    expect((await ClaimAssessment.findOne({ claimId }).lean()).verification.status).toBe("completed");
  });

  it("WK-8: SIGTERM lets the job in flight finish, starts nothing new, disconnects and exits 0", async () => {
    const farmer = await seedFarmer("wk8");
    const claimId = await createClaim(farmer);
    await submitClaim(farmer.user, claimId);
    await VerificationJob.deleteMany({ claimId });
    const slow = await enqueue({ claimId, cognitoSub: farmer.user, step: "weather", runAt: new Date(Date.now() - 2000) });
    const next = await enqueue({ claimId, cognitoSub: farmer.user, step: "satellite", runAt: new Date(Date.now() - 1000) });

    const worker = startWorker({ MONGO_URI: uri, WORKER_FIXTURE_SLOW_STEP: "weather", WORKER_FIXTURE_SLOW_MS: "1500" });
    running.push(worker);
    await waitFor(() => VerificationJob.findOne({ _id: slow.job._id, status: "running" }).lean(), { what: `the child to start the slow step (${worker.output.stderr})` });
    worker.child.kill("SIGTERM");
    const exit = await worker.exited;
    expect(exit, worker.output.stderr).toEqual({ code: 0, signal: null });

    expect(await VerificationJob.findById(slow.job._id).lean()).toMatchObject({ status: "succeeded", attempts: 1, leaseOwner: null });
    // The second due job was never started after the signal.
    expect(await VerificationJob.findById(next.job._id).lean()).toMatchObject({ status: "queued", attempts: 0 });
  });
});
