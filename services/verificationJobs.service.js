import { randomUUID } from "node:crypto";
import VerificationJob from "../models/VerificationJob.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import logger from "../utils/logger.js";
import { OWNERSHIP_DOCUMENT_FILTER } from "../utils/ownershipEvidence.js";

// ADR-021 — job queue for automated claim verification. See models/VerificationJob.js.
//
// Guarantees:
//   - at most one ACTIVE job per (claim, step): duplicates are refused by a unique index;
//   - a job is claimed with one atomic update, and a job whose lease expired (its container was
//     frozen or killed) is claimed again;
//   - a step that cannot finish inside the remaining time budget is put back untouched, never
//     half-run;
//   - exhausting a job's attempts creates a MANUAL REVIEW CASE. A failed provider never produces a
//     decision: it leaves the claim held for a person.

export const DEFAULT_LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const REQUEUE_WAIT_MS = 15_000;

// Time (ms) a step is expected to need. The runner skips a step with less budget left than this.
export const MIN_BUDGET_MS = Object.freeze({
  ai_assessment: 15_000,
  land_documents: 12_000,
  official_land_record: 6_000,
  satellite: 12_000,
  weather: 4_000,
  engine: 4_000,
});

// Step executors. Each receives the job and returns a small, non-sensitive summary object. They are
// registered lazily (see registerDefaultExecutors) so this module has no import cycle with the
// services it drives, and tests can replace them with `setExecutor`.
const executors = new Map();
export const setExecutor = (step, fn) => executors.set(step, fn);
export const getExecutor = (step) => executors.get(step);

// The real executors live in verificationSteps.js, which imports the services this module drives
// (so it cannot be imported statically here). Load it on first use; steps a test already registered
// are left alone.
let defaultsLoaded = null;
export const ensureDefaultExecutors = () => {
  if (!defaultsLoaded) defaultsLoaded = import("./verificationSteps.js");
  return defaultsLoaded;
};

const activeKeyFor = (claimId, step) => `${String(claimId)}:${step}`;

export const enqueue = async ({ claimId, cognitoSub, step, runAt = new Date(), maxAttempts = 3 }) => {
  try {
    const job = await VerificationJob.create({
      claimId,
      cognitoSub,
      step,
      runAt,
      maxAttempts,
      activeKey: activeKeyFor(claimId, step),
    });
    return { job, created: true };
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await VerificationJob.findOne({ activeKey: activeKeyFor(claimId, step) });
      return { job: existing, created: false };
    }
    throw error;
  }
};

// Plan the work for a freshly submitted claim: only the steps that have something to act on, then
// the engine last. The engine job re-queues itself while other steps for the claim are still active.
export const enqueuePlan = async ({ claimId, cognitoSub }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub }).lean();
  if (!claim) return [];

  const [photoCount, documentCount] = await Promise.all([
    ClaimEvidence.countDocuments({ claimId: claim._id, status: "stored" }),
    VerificationEvidence.countDocuments({ claimId: claim._id, source: "OWNERSHIP", ...OWNERSHIP_DOCUMENT_FILTER }),
  ]);

  const steps = [];
  if (photoCount > 0) steps.push("ai_assessment");
  if (documentCount > 0) steps.push("land_documents", "official_land_record");
  if (claim.claimedGeometry) steps.push("satellite", "weather");
  steps.push("engine");

  const queued = [];
  for (const step of steps) {
    queued.push((await enqueue({ claimId: claim._id, cognitoSub, step })).job);
  }
  return queued;
};

// Atomically take the next due job (optionally for one claim). Also takes jobs whose lease expired.
export const claimNext = async ({ claimId = null, now = new Date(), owner, leaseMs = DEFAULT_LEASE_MS, excludeIds = [] }) => {
  const scope = { ...(claimId ? { claimId } : {}), ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}) };
  const job = await VerificationJob.findOneAndUpdate(
    {
      ...scope,
      $or: [
        { status: "queued", runAt: { $lte: now } },
        { status: "running", leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: "running", leaseOwner: owner, leaseUntil: new Date(now.getTime() + leaseMs) },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true }
  );
  return job;
};

const finish = (job, status, extra = {}) =>
  VerificationJob.updateOne(
    { _id: job._id },
    { $set: { status, leaseOwner: null, leaseUntil: null, ...extra }, $unset: { activeKey: "" } }
  );

const releaseUntouched = (job, runAt) =>
  VerificationJob.updateOne(
    { _id: job._id },
    { $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt }, $inc: { attempts: -1 } }
  );

const otherActiveJobs = (job) =>
  VerificationJob.countDocuments({
    claimId: job.claimId,
    _id: { $ne: job._id },
    status: { $in: ["queued", "running"] },
    step: { $ne: "engine" },
  });

// Run one claimed job. Never throws.
export const runJob = async (job, { now = new Date(), deadline = null } = {}) => {
  const step = job.step;
  const needed = MIN_BUDGET_MS[step] || 0;
  if (deadline && deadline - now.getTime() < needed) {
    await releaseUntouched(job, now);
    return { step, outcome: "skipped_no_budget" };
  }

  // The engine waits for the other steps of the same claim instead of deciding on partial evidence.
  if (step === "engine" && (await otherActiveJobs(job)) > 0) {
    await releaseUntouched(job, new Date(now.getTime() + REQUEUE_WAIT_MS));
    return { step, outcome: "waiting_for_other_steps" };
  }

  try {
    await ensureDefaultExecutors();
    const executor = getExecutor(step);
    if (!executor) throw Object.assign(new Error(`No executor registered for step ${step}`), { code: "no_executor" });
    const summary = await executor(job, { now, deadline });
    // A step may ask to run again later (for example satellite, once the post-event window opens).
    // That is a normal outcome, not a retry: attempts are not consumed.
    const again = summary && summary.rescheduleAt ? new Date(summary.rescheduleAt) : null;
    if (again && again.getTime() > now.getTime()) {
      await VerificationJob.updateOne(
        { _id: job._id },
        { $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt: again, resultSummary: summary }, $inc: { attempts: -1 } }
      );
      return { step, outcome: "rescheduled", summary, runAt: again };
    }
    await finish(job, "succeeded", { resultSummary: summary ?? null, lastError: { code: null, message: null } });
    return { step, outcome: "succeeded", summary };
  } catch (error) {
    const lastError = { code: error?.code ? String(error.code).slice(0, 60) : "error", message: String(error?.message || "failed").slice(0, 300) };
    if (job.attempts < job.maxAttempts) {
      const wait = BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
      await VerificationJob.updateOne(
        { _id: job._id },
        { $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt: new Date(now.getTime() + wait), lastError } }
      );
      return { step, outcome: "retry_scheduled", error: lastError };
    }
    await finish(job, "dead", { lastError });
    await openReviewCaseForDeadJob(job, lastError).catch((reviewError) =>
      logger.error({ err: reviewError?.message, claimId: String(job.claimId), step }, "could not open a review case for a dead job")
    );
    return { step, outcome: "dead", error: lastError };
  }
};

// A step that keeps failing must never turn into a decision (or into silence): it opens a review case
// so a person knows the automated check could not complete.
const openReviewCaseForDeadJob = async (job, lastError) => {
  const { createReviewCase } = await import("./manualReview.service.js");
  await createReviewCase({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    source: "OWNERSHIP",
    reasons: [`automated_step_failed_${job.step}`],
    metadata: { component: "manual_review", failedStep: job.step, errorCode: lastError.code },
  });
};

// Claim and run due jobs until none are left or the time budget is spent.
export const drain = async ({ claimId = null, deadline = null, maxJobs = 10, now = () => new Date() } = {}) => {
  const owner = `worker-${randomUUID()}`;
  const results = [];
  // A job skipped for lack of time is released as due; excluding it here stops the same drain from
  // claiming it again in a loop.
  const skipped = [];
  for (let i = 0; i < maxJobs; i += 1) {
    const current = now();
    if (deadline && deadline - current.getTime() <= 0) break;
    const job = await claimNext({ claimId, now: current, owner, excludeIds: skipped });
    if (!job) break;
    const result = await runJob(job, { now: current, deadline });
    if (result.outcome === "skipped_no_budget") skipped.push(job._id);
    results.push(result);
  }
  return results;
};

export default { enqueue, enqueuePlan, claimNext, runJob, drain, setExecutor, getExecutor, MIN_BUDGET_MS, DEFAULT_LEASE_MS };
