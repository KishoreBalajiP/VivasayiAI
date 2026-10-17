import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import VerificationJob, { JOB_STEPS } from "../models/VerificationJob.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import logger, { maskUrl } from "../utils/logger.js";
import { OWNERSHIP_DOCUMENT_FILTER } from "../utils/ownershipEvidence.js";
import { classifyProviderError, PROVIDER_ERROR_CODES, PROVIDER_ERROR_KINDS } from "../utils/providerErrors.js";
import { resolvePolicy, policySetting } from "../config/verificationPolicy.js";

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
//
// ADR-022 additions:
//   - every write a runner makes to a job it holds is checked against its lease (`leaseOwner` and
//     status `running`). A runner whose lease was taken over gets `lease_lost` and changes nothing,
//     so a slow, stale runner can never overwrite the new owner's result;
//   - a heartbeat renews the lease while the step runs (VERIFICATION_LEASE_MS, renewed every
//     VERIFICATION_HEARTBEAT_MS, default a third of the lease);
//   - retries follow a backoff schedule with +/-20% jitter (VERIFICATION_RETRY_SCHEDULE_MS, CSV) up
//     to a per-step attempt limit (VERIFICATION_MAX_ATTEMPTS, JSON); an application defect is capped
//     at three attempts whatever the limit;
//   - satellite never blocks the engine, under every policy (owner decision D1). The engine waits
//     only for the policy's `engineWaitsFor` steps; `official_land_record` waits for
//     `land_documents`;
//   - a dead job opens ONE review case labelled with its own source. Dead satellite and weather jobs
//     (supporting evidence only) open none: they are logged and shown to reviewers in diagnostics;
//   - jobs of a withdrawn or deleted claim are cancelled before they run, and never open a case;
//   - dead jobs whose failure was transient can be re-queued (requeueDeadJobs);
//   - late evidence that finds its step RUNNING flags the job instead of being dropped: the job runs
//     once more when it finishes (`rerunRequested`), so the new photo or document is always checked.

export const DEFAULT_LEASE_MS = 60_000;
const REQUEUE_WAIT_MS = 15_000;
// An engine run that reports "in progress" (another run holds the claim, or its photo check is still
// `processing`) is rescheduled, not counted as done. Past this many reschedules the run is treated
// as stuck: it fails like any other error, so it ends in a dead job and a review case, never silence.
export const ENGINE_MAX_RESCHEDULES = 30;

// Retry backoff (ms) after attempt 1, 2, 3, ...; the last value repeats. Each delay is jittered by
// +/-20% so a provider outage does not bring every claim back at the same moment.
export const DEFAULT_RETRY_SCHEDULE_MS = Object.freeze([60_000, 300_000, 900_000, 3_600_000, 3_600_000, 10_800_000]);
export const RETRY_JITTER = 0.2;
// Attempts per step. The provider-backed steps get more, because a quota or overload window can
// outlast a few retries. Stored on each job when it is created, so a later change never rewrites a
// job already queued.
export const DEFAULT_MAX_ATTEMPTS = Object.freeze({
  ai_assessment: 7,
  land_documents: 7,
  official_land_record: 5,
  satellite: 5,
  weather: 5,
  engine: 5,
});
// An unrecognised error is most likely a bug: retrying it for hours would only hide it.
export const DEFECT_MAX_ATTEMPTS = 3;
const ATTEMPT_LOG_MAX = 10;

// D1: satellite is supporting evidence and never delays a decision, whatever the policy says. This
// is queue timing, not decision logic, so it is not part of any policy (or its hash).
export const NON_BLOCKING_STEPS = Object.freeze(["satellite"]);
// Supporting evidence only: a dead job of these steps opens no review case.
export const SUPPORTING_STEPS = Object.freeze(["satellite", "weather"]);
// A step that needs another step's result first.
export const STEP_DEPENDENCIES = Object.freeze({ official_land_record: Object.freeze(["land_documents"]) });
// The source a dead job's review case is labelled with (the reviewer's queue groups by source).
export const STEP_REVIEW_SOURCE = Object.freeze({
  ai_assessment: "AI_IMAGE",
  land_documents: "OWNERSHIP",
  official_land_record: "OWNERSHIP",
  engine: "GEOMETRY",
});
const STEP_COMPONENT = Object.freeze({
  ai_assessment: "photos",
  land_documents: "land_documents",
  official_land_record: "claimant_rights",
  satellite: "satellite",
  weather: "weather",
  engine: null,
});
// Steps whose result can change the decision: re-running one of them also re-runs the engine.
const DECISION_INPUT_STEPS = Object.freeze(["ai_assessment", "land_documents", "official_land_record"]);

// Dead-job recovery. Only transient kinds are re-queued automatically, after a cool-down; a missing
// or rejected key (auth_config) or a defect needs a person to fix the cause first, so those are
// re-queued only by an admin or the worker CLI.
export const AUTO_RECOVERABLE_KINDS = Object.freeze([
  PROVIDER_ERROR_KINDS.QUOTA,
  PROVIDER_ERROR_KINDS.OVERLOAD,
  PROVIDER_ERROR_KINDS.TIMEOUT,
  PROVIDER_ERROR_KINDS.NETWORK,
  PROVIDER_ERROR_KINDS.STORAGE,
]);
export const DEFAULT_DEAD_RECOVERY_AFTER_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_MAX_RECOVERY_ROUNDS = 2;

// Time (ms) a step is expected to need. The runner skips a step with less budget left than this.
export const MIN_BUDGET_MS = Object.freeze({
  ai_assessment: 15_000,
  land_documents: 12_000,
  official_land_record: 6_000,
  satellite: 12_000,
  weather: 4_000,
  engine: 4_000,
});

// ---- settings (read per call, so a harness or test can change them without reloading) ----------

const positiveInt = (raw) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
};

const warnedSettings = new Set();
const warnInvalidSetting = (key) => {
  if (warnedSettings.has(key)) return;
  warnedSettings.add(key);
  logger.warn({ setting: key }, "verification.invalid_setting_ignored");
};

// "60000,300000,900000" -> [60000, 300000, 900000]. Anything unusable falls back to the default.
export const parseRetrySchedule = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === "") return [...DEFAULT_RETRY_SCHEDULE_MS];
  const values = String(raw).split(",").map((part) => positiveInt(part.trim()));
  if (values.length === 0 || values.some((value) => value === null)) {
    warnInvalidSetting("VERIFICATION_RETRY_SCHEDULE_MS");
    return [...DEFAULT_RETRY_SCHEDULE_MS];
  }
  return values;
};

// '{"ai_assessment":3,"engine":3}' -> the defaults with those steps overridden.
export const parseMaxAttempts = (raw) => {
  const limits = { ...DEFAULT_MAX_ATTEMPTS };
  if (raw === undefined || raw === null || String(raw).trim() === "") return limits;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    for (const [step, value] of Object.entries(parsed)) {
      if (Object.prototype.hasOwnProperty.call(limits, step) && positiveInt(value)) limits[step] = positiveInt(value);
    }
  } catch {
    warnInvalidSetting("VERIFICATION_MAX_ATTEMPTS");
  }
  return limits;
};

export const queueSettings = () => {
  const leaseMs = positiveInt(process.env.VERIFICATION_LEASE_MS) || DEFAULT_LEASE_MS;
  // A heartbeat slower than half the lease could let the lease lapse between two renewals.
  const heartbeatCap = Math.max(1, Math.floor(leaseMs / 2));
  return {
    leaseMs,
    heartbeatMs: Math.min(positiveInt(process.env.VERIFICATION_HEARTBEAT_MS) || Math.max(1, Math.floor(leaseMs / 3)), heartbeatCap),
    retryScheduleMs: parseRetrySchedule(process.env.VERIFICATION_RETRY_SCHEDULE_MS),
    maxAttempts: parseMaxAttempts(process.env.VERIFICATION_MAX_ATTEMPTS),
    deadRecoveryAfterMs: positiveInt(process.env.VERIFICATION_DEAD_RECOVERY_AFTER_MS) || DEFAULT_DEAD_RECOVERY_AFTER_MS,
  };
};

export const maxAttemptsFor = (step) => queueSettings().maxAttempts[step] || 3;

// Delay before the next try after `attempts` failed attempts. `rand` is injectable for tests.
export const retryDelayMs = ({ attempts, schedule = queueSettings().retryScheduleMs, rand = Math.random } = {}) => {
  const list = Array.isArray(schedule) && schedule.length > 0 ? schedule : DEFAULT_RETRY_SCHEDULE_MS;
  const index = Math.min(Math.max(Number(attempts) || 1, 1) - 1, list.length - 1);
  const factor = 1 - RETRY_JITTER + 2 * RETRY_JITTER * Math.min(Math.max(Number(rand()) || 0, 0), 1);
  return Math.round(list[index] * factor);
};

// ---- step executors -----------------------------------------------------------------------------

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

// ---- enqueue and plans --------------------------------------------------------------------------

const activeKeyFor = (claimId, step) => `${String(claimId)}:${step}`;
const shortId = (value) => (value === undefined || value === null || value === "" ? null : String(value).slice(0, 120));

export const planKeyForRound = (round) => `r${Number(round) || 0}`;
export const correlationIdFor = (claimId, round) => `clm_${String(claimId)}_r${Number(round) || 0}`;

// Queue one step. Idempotent: an active job for the same (claim, step), or a job already created
// for the same (claim, step, planKey), is returned with `created: false` instead of a duplicate.
//
// `rerunIfRunning` (late evidence): when the active job is RUNNING right now, it may already have
// read the evidence as it was before, and no second job can be queued beside it. It is flagged
// (`rerunRequested`) so runJob queues it once more when it finishes, and the new evidence is checked
// without waiting for anyone. A queued job needs no flag: it reads the evidence when it runs.
export const enqueue = async ({
  claimId,
  cognitoSub,
  step,
  runAt = new Date(),
  maxAttempts = null,
  planKey = null,
  requestId = null,
  correlationId = null,
  recoveredFrom = null,
  recoveryRound = 0,
  rerunIfRunning = false,
  _retried = false,
}) => {
  const again = () =>
    enqueue({ claimId, cognitoSub, step, runAt, maxAttempts, planKey, requestId, correlationId, recoveredFrom, recoveryRound, rerunIfRunning, _retried: true });
  const fields = {
    claimId,
    cognitoSub,
    step,
    runAt,
    maxAttempts: positiveInt(maxAttempts) || maxAttemptsFor(step),
    activeKey: activeKeyFor(claimId, step),
    requestId: shortId(requestId),
    correlationId: shortId(correlationId),
    recoveredFrom: recoveredFrom || null,
    recoveryRound: Number(recoveryRound) || 0,
  };
  if (planKey) fields.planKey = String(planKey);
  try {
    const job = await VerificationJob.create(fields);
    return { job, created: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const active = await VerificationJob.findOne({ activeKey: activeKeyFor(claimId, step) });
    if (active) {
      if (rerunIfRunning && active.status === "running") {
        // A flag is not progress: it leaves `updatedAt` alone, like the heartbeat.
        const flagged = await VerificationJob.updateOne({ _id: active._id, status: "running" }, { $set: { rerunRequested: true } }, { timestamps: false });
        if (flagged.matchedCount > 0) return { job: active, created: false, rerunRequested: true };
        // It finished in the meantime: the step can be queued as a new job now.
        if (!_retried) return again();
      }
      return { job: active, created: false };
    }
    if (planKey) {
      const planned = await VerificationJob.findOne({ claimId, step, planKey: String(planKey) });
      if (planned) return { job: planned, created: false };
    }
    // The active job finished between the refused insert and the lookup: try once more.
    if (!_retried) return again();
    return { job: null, created: false };
  }
};

// Queue a list of steps under one plan key. Returns the jobs (created or already present).
export const enqueueSteps = async ({ claimId, cognitoSub, steps, planKey = null, requestId = null, correlationId = null, rerunIfRunning = false }) => {
  const jobs = [];
  let created = 0;
  for (const step of steps) {
    const result = await enqueue({ claimId, cognitoSub, step, planKey, requestId, correlationId, rerunIfRunning });
    if (result.created) created += 1;
    if (result.job) jobs.push(result.job);
  }
  return { jobs, created };
};

// The work for a submitted claim: only the steps that have something to act on, then the engine
// last (it waits for the blocking steps, see runJob). Idempotent per submission round: the plan key
// is `r<submissionRound>`, so calling it again (a repeated submit, the reconcile sweep) creates only
// the steps that were never created, and never re-runs a step that already finished.
export const ensurePlan = async ({ claimId, cognitoSub, requestId = null, trigger = "submit" } = {}) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub }).lean();
  if (!claim || claim.state !== "submitted") return [];

  const [photoCount, documentCount] = await Promise.all([
    ClaimEvidence.countDocuments({ claimId: claim._id, status: "stored" }),
    VerificationEvidence.countDocuments({ claimId: claim._id, source: "OWNERSHIP", ...OWNERSHIP_DOCUMENT_FILTER }),
  ]);

  const steps = [];
  if (photoCount > 0) steps.push("ai_assessment");
  if (documentCount > 0) steps.push("land_documents", "official_land_record");
  if (claim.claimedGeometry) steps.push("satellite", "weather");
  steps.push("engine");

  const round = claim.submissionRound || 0;
  const planKey = planKeyForRound(round);
  const correlationId = correlationIdFor(claim._id, round);
  const { jobs, created } = await enqueueSteps({ claimId: claim._id, cognitoSub, steps, planKey, requestId, correlationId });
  logger.info({ claimId: String(claim._id), requestId: shortId(requestId), correlationId, planKey, trigger, steps, created }, "verification.plan_ensured");
  return jobs;
};

// Kept for existing callers: the plan used to be built only once, at submit.
export const enqueuePlan = ensurePlan;

// Cancel a claim's QUEUED jobs so they never run: the claim was withdrawn, or a person decided it
// (admin override of a held claim). A running job is left to finish; its result is harmless because
// the engine never decides a claim that is no longer `submitted`. `steps` limits the cancellation to
// those steps (null: every step). Returns the number of jobs cancelled.
export const cancelJobsForClaim = async ({ claimId, reason, steps = null, now = new Date() } = {}) => {
  const filter = { claimId, status: "queued", ...(Array.isArray(steps) ? { step: { $in: steps } } : {}) };
  const result = await VerificationJob.updateMany(filter, {
    $set: { status: "cancelled", cancelledAt: now, cancelReason: String(reason || "cancelled").slice(0, 120), leaseOwner: null, leaseUntil: null },
    $unset: { activeKey: "" },
  });
  return { cancelled: result.modifiedCount ?? 0 };
};

// ---- claiming and running -----------------------------------------------------------------------

// Atomically take the next due job (optionally for one claim). Also takes jobs whose lease expired.
export const claimNext = async ({ claimId = null, now = new Date(), owner, leaseMs = null, excludeIds = [], excludeSteps = [] }) => {
  const lease = positiveInt(leaseMs) || queueSettings().leaseMs;
  const scope = {
    ...(claimId ? { claimId } : {}),
    ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
    ...(excludeSteps.length ? { step: { $nin: excludeSteps } } : {}),
  };
  const job = await VerificationJob.findOneAndUpdate(
    {
      ...scope,
      $or: [
        { status: "queued", runAt: { $lte: now } },
        { status: "running", leaseUntil: { $lt: now } },
      ],
    },
    {
      $set: { status: "running", leaseOwner: owner, leaseUntil: new Date(now.getTime() + lease) },
      $inc: { attempts: 1 },
    },
    { sort: { runAt: 1 }, new: true }
  );
  return job;
};

// Every write a runner makes to a job it holds goes through this filter: if another runner took the
// job over (the lease expired), the write matches nothing and the runner stops.
const ownedFilter = (job) => ({ _id: job._id, leaseOwner: job.leaseOwner, status: "running" });

// Record how the current attempt ended on its attemptLog entry (matched by the attempt's start time).
const attemptOutcome = (job, outcome, { code = null, kind = null, durationMs = null } = {}) =>
  job.lastAttemptAt
    ? {
        set: {
          "attemptLog.$[entry].outcome": outcome,
          "attemptLog.$[entry].code": code,
          "attemptLog.$[entry].kind": kind,
          "attemptLog.$[entry].durationMs": durationMs,
        },
        arrayFilters: [{ "entry.at": job.lastAttemptAt }],
      }
    : null;

// `extraFilter` narrows the write further (the success write must not overrule a rerun request).
const writeOwned = async (job, update, attempt = null, extraFilter = null) => {
  const merged = attempt ? { ...update, $set: { ...(update.$set || {}), ...attempt.set } } : update;
  const filter = extraFilter ? { ...ownedFilter(job), ...extraFilter } : ownedFilter(job);
  const result = await VerificationJob.updateOne(filter, merged, attempt ? { arrayFilters: attempt.arrayFilters } : {});
  return result.matchedCount > 0;
};

// A job going back to the queue (put back, rescheduled, retried) reads the evidence afresh when it
// runs next, so a pending rerun request is satisfied by that run.
const CLEAR_RERUN = Object.freeze({ rerunRequested: "" });
// A rerun starts a moment later, so the request that added the evidence has finished writing it.
export const RERUN_DELAY_MS = 1000;

// Not an attempt (no time, waiting for another step): back to the queue without using one.
const releaseUntouched = (job, runAt) =>
  writeOwned(job, { $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt }, $unset: { ...CLEAR_RERUN }, $inc: { attempts: -1 } });

const EMPTY_ERROR = Object.freeze({ code: null, message: null, kind: null, retryable: null, at: null });

// Provider messages can carry a URL, a key or an address; keep only what helps a reviewer.
const sanitizeErrorMessage = (message) =>
  maskUrl(
    String(message || "failed")
      .replace(/https?:\/\/\S+/gi, "<url>")
      .replace(/\b(key|api[_-]?key|token|secret|signature|sig|password|x-amz-[a-z-]+)=[^\s&"']+/gi, "$1=<redacted>")
  ).slice(0, 300);

const errorRecord = (error, at) => {
  const kind = classifyProviderError(error);
  const ownCode = error?.code !== undefined && error?.code !== null && error?.code !== "" ? String(error.code).slice(0, 60) : null;
  return {
    code: ownCode || (kind === PROVIDER_ERROR_KINDS.DEFECT ? "error" : PROVIDER_ERROR_CODES[kind]),
    message: sanitizeErrorMessage(error?.message),
    kind,
    retryable: kind !== PROVIDER_ERROR_KINDS.DEFECT,
    at,
  };
};

const claimStateOf = async (claimId) => {
  const claim = await LossClaim.findById(claimId).select("state").lean();
  return claim ? claim.state : null;
};

// The steps a job must wait for, under a policy. The engine waits for the policy's `engineWaitsFor`
// (every other step when a policy does not say), never for a non-blocking step.
export const blockingStepsFor = (step, policy = resolvePolicy()) => {
  if (step === "engine") {
    const listed = policySetting(policy, "engineWaitsFor");
    const candidates = Array.isArray(listed) ? listed : JOB_STEPS.filter((name) => name !== "engine");
    return candidates.filter((name) => name !== "engine" && !NON_BLOCKING_STEPS.includes(name));
  }
  return [...(STEP_DEPENDENCIES[step] || [])];
};

// Active (queued or running) jobs a job of `step` must wait for: how many, how many are running now,
// and the earliest runAt among the queued ones.
export const findBlockingJobs = async ({ claimId, step, excludeId = null, policy = resolvePolicy() }) => {
  const steps = blockingStepsFor(step, policy);
  if (steps.length === 0) return { count: 0, running: 0, earliestRunAt: null, steps: [] };
  const rows = await VerificationJob.find({
    claimId,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    status: { $in: ["queued", "running"] },
    step: { $in: steps },
  })
    .select("step runAt status")
    .sort({ runAt: 1 })
    .lean();
  const queued = rows.filter((row) => row.status === "queued");
  return {
    count: rows.length,
    running: rows.length - queued.length,
    earliestRunAt: queued.length ? queued[0].runAt : null,
    steps: [...new Set(rows.map((row) => row.step))],
  };
};

// How many active jobs the claim's engine is still waiting for (0: it may decide now).
export const countBlockingActiveJobs = async (claimId, policy = resolvePolicy()) =>
  (await findBlockingJobs({ claimId, step: "engine", policy })).count;

// Renew the lease while the executor runs. Stops by itself if the lease was lost. The renewal does
// not touch `updatedAt`: a heartbeat is not progress.
const startHeartbeat = (job, { leaseMs, heartbeatMs, clock, log }) => {
  if (!job.leaseOwner || !(heartbeatMs > 0)) return () => {};
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    VerificationJob.updateOne(ownedFilter(job), { $set: { leaseUntil: new Date(clock().getTime() + leaseMs) } }, { timestamps: false })
      .then((result) => {
        if (!stopped && result.matchedCount === 0) {
          stopped = true;
          clearInterval(timer);
          log.warn("job.lease_lost");
        }
      })
      .catch((error) => log.warn({ err: error?.message }, "job.heartbeat_failed"));
  }, heartbeatMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

// Run one claimed job. Never throws.
export const runJob = async (
  job,
  { now = new Date(), deadline = null, policy = null, leaseMs = null, heartbeatMs = null, rand = Math.random, drainRequestId = null } = {}
) => {
  const step = job.step;
  const settings = queueSettings();
  const lease = positiveInt(leaseMs) || settings.leaseMs;
  const beat = positiveInt(heartbeatMs) || (positiveInt(leaseMs) ? Math.max(1, Math.floor(lease / 3)) : settings.heartbeatMs);
  // `now` may be a test clock: keep every timestamp this run writes on the same clock.
  const offset = now.getTime() - Date.now();
  const clock = () => new Date(Date.now() + offset);
  const log = logger.child({
    jobId: String(job._id),
    claimId: String(job.claimId),
    step,
    requestId: job.requestId || null,
    correlationId: job.correlationId || null,
    // Who ran this attempt: the worker batch (a Lambda awsRequestId, `worker-<uuid>`) or the HTTP
    // request whose drain picked it up. `requestId` above is the request that CREATED the job.
    drainRequestId: shortId(drainRequestId),
  });
  const lost = () => {
    log.warn({ attempt: job.attempts }, "job.lease_lost");
    return { step, outcome: "lease_lost" };
  };
  // Before the step ran the claim did not cost an attempt; after it ran, the attempt stays counted.
  const cancel = async (reason, { ran = false } = {}) => {
    const ok = await writeOwned(job, {
      $set: { status: "cancelled", cancelledAt: clock(), cancelReason: reason, leaseOwner: null, leaseUntil: null },
      $unset: { activeKey: "" },
      ...(ran ? {} : { $inc: { attempts: -1 } }),
    });
    if (!ok) return lost();
    log.info({ reason }, "job.cancelled");
    return { step, outcome: "cancelled", reason };
  };

  try {
    // A withdrawn or deleted claim gets no more work: no provider call, no review case.
    const claimState = await claimStateOf(job.claimId);
    if (claimState === null) return await cancel("claim_missing");
    if (claimState === "withdrawn") return await cancel("claim_withdrawn");

    const needed = MIN_BUDGET_MS[step] || 0;
    if (deadline && deadline - now.getTime() < needed) {
      if (!(await releaseUntouched(job, now))) return lost();
      return { step, outcome: "skipped_no_budget" };
    }

    // The engine waits for the claim's blocking steps instead of deciding on partial evidence, and
    // official_land_record waits for land_documents. Put back no earlier than the first of them can
    // run (a blocker running right now: after the short wait), so a far-off retry is not polled.
    const blockers = await findBlockingJobs({ claimId: job.claimId, step, excludeId: job._id, policy: policy || resolvePolicy() });
    if (blockers.count > 0) {
      const earliest = blockers.running === 0 && blockers.earliestRunAt ? new Date(blockers.earliestRunAt).getTime() + 1000 : 0;
      const runAt = new Date(Math.max(now.getTime() + REQUEUE_WAIT_MS, earliest));
      if (!(await releaseUntouched(job, runAt))) return lost();
      log.debug({ waitingFor: blockers.steps, runAt }, "job.waiting");
      return { step, outcome: step === "engine" ? "waiting_for_other_steps" : "waiting_for_dependencies", runAt };
    }
  } catch (error) {
    // The checks above only read and release; if the database refused, the lease simply expires.
    log.error({ err: error?.message }, "job.precheck_failed");
    return { step, outcome: "precheck_failed" };
  }

  // This is a real attempt: record when it started.
  const attemptAt = clock();
  try {
    const started = await VerificationJob.updateOne(ownedFilter(job), {
      $set: { startedAt: job.startedAt || attemptAt, lastAttemptAt: attemptAt },
      $push: { attemptLog: { $each: [{ attempt: job.attempts, at: attemptAt }], $slice: -ATTEMPT_LOG_MAX } },
    });
    if (started.matchedCount === 0) return lost();
  } catch (error) {
    log.error({ err: error?.message }, "job.precheck_failed");
    return { step, outcome: "precheck_failed" };
  }
  job.lastAttemptAt = attemptAt;
  log.info({ attempt: job.attempts }, "job.started");

  const stopHeartbeat = startHeartbeat(job, { leaseMs: lease, heartbeatMs: beat, clock, log });
  const startedMs = Date.now();
  try {
    await ensureDefaultExecutors();
    const executor = getExecutor(step);
    if (!executor) throw Object.assign(new Error(`No executor registered for step ${step}`), { code: "no_executor" });
    const summary = await executor(job, { now, deadline, requestId: job.requestId || null });
    stopHeartbeat();
    const durationMs = Date.now() - startedMs;
    // A step may ask to run again later (for example satellite, once the post-event window opens).
    // That is a normal outcome, not a retry: attempts are not consumed.
    const again = summary && summary.rescheduleAt ? new Date(summary.rescheduleAt) : null;
    if (again && again.getTime() > now.getTime()) {
      if (step === "engine" && (job.rescheduleCount || 0) >= ENGINE_MAX_RESCHEDULES) {
        throw Object.assign(new Error(`Engine still in progress after ${ENGINE_MAX_RESCHEDULES} reschedules`), { code: "ENGINE_STUCK" });
      }
      const ok = await writeOwned(
        job,
        {
          $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt: again, resultSummary: summary },
          $unset: { ...CLEAR_RERUN },
          $inc: { attempts: -1, rescheduleCount: 1 },
        },
        attemptOutcome(job, "rescheduled", { durationMs })
      );
      if (!ok) return lost();
      log.info({ attempt: job.attempts, durationMs, runAt: again }, "job.rescheduled");
      return { step, outcome: "rescheduled", summary, runAt: again };
    }
    // Finished, unless late evidence asked for a rerun while the step ran (enqueue `rerunIfRunning`).
    const ok = await writeOwned(
      job,
      {
        $set: { status: "succeeded", leaseOwner: null, leaseUntil: null, resultSummary: summary ?? null, lastError: { ...EMPTY_ERROR }, completedAt: clock() },
        $unset: { activeKey: "" },
      },
      attemptOutcome(job, "succeeded", { durationMs }),
      { rerunRequested: { $ne: true } }
    );
    if (!ok) {
      // This run may have read the evidence as it was before the late photo or document: run the
      // step once more, without using an attempt. The job stays active, so the steps waiting for it
      // (the engine, the record lookup) keep waiting for the rerun.
      const rerunAt = new Date(now.getTime() + RERUN_DELAY_MS);
      const rerun = await writeOwned(
        job,
        { $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt: rerunAt, resultSummary: summary ?? null }, $unset: { ...CLEAR_RERUN }, $inc: { attempts: -1 } },
        attemptOutcome(job, "rerun_requested", { durationMs }),
        { rerunRequested: true }
      );
      if (!rerun) return lost();
      log.info({ attempt: job.attempts, durationMs, runAt: rerunAt }, "job.rerun_requested");
      return { step, outcome: "rerun", summary, runAt: rerunAt };
    }
    log.info({ attempt: job.attempts, durationMs }, "job.succeeded");
    return { step, outcome: "succeeded", summary };
  } catch (error) {
    stopHeartbeat();
    const durationMs = Date.now() - startedMs;
    const lastError = errorRecord(error, clock());
    const details = { attempt: job.attempts, durationMs, errorCode: lastError.code, errorKind: lastError.kind };
    try {
      // The claim may have been withdrawn while the step ran: stop here, without a review case.
      const claimState = await claimStateOf(job.claimId);
      if (claimState === null || claimState === "withdrawn") {
        return await cancel(claimState === null ? "claim_missing" : "claim_withdrawn", { ran: true });
      }

      const limit = lastError.kind === PROVIDER_ERROR_KINDS.DEFECT ? Math.min(job.maxAttempts, DEFECT_MAX_ATTEMPTS) : job.maxAttempts;
      const level = lastError.kind === PROVIDER_ERROR_KINDS.AUTH_CONFIG || lastError.kind === PROVIDER_ERROR_KINDS.DEFECT ? "error" : "warn";
      const operatorAction = lastError.kind === PROVIDER_ERROR_KINDS.AUTH_CONFIG ? { operatorAction: true } : {};
      if (job.attempts < limit) {
        const wait = retryDelayMs({ attempts: job.attempts, schedule: settings.retryScheduleMs, rand });
        const runAt = new Date(clock().getTime() + wait);
        const ok = await writeOwned(
          job,
          { $set: { status: "queued", leaseOwner: null, leaseUntil: null, runAt, lastError }, $unset: { ...CLEAR_RERUN } },
          attemptOutcome(job, "retry_scheduled", { code: lastError.code, kind: lastError.kind, durationMs })
        );
        if (!ok) return lost();
        log[level]({ ...details, ...operatorAction, retryInMs: wait }, "job.retry_scheduled");
        return { step, outcome: "retry_scheduled", error: lastError, runAt };
      }
      const ok = await writeOwned(
        job,
        { $set: { status: "dead", leaseOwner: null, leaseUntil: null, lastError, deadAt: clock() }, $unset: { activeKey: "" } },
        attemptOutcome(job, "dead", { code: lastError.code, kind: lastError.kind, durationMs })
      );
      if (!ok) return lost();
      log.error({ ...details, ...operatorAction }, "job.dead");
      await openReviewCaseForDeadJob(job, lastError, log).catch((reviewError) =>
        log.error({ err: reviewError?.message }, "could not open a review case for a dead job")
      );
      return { step, outcome: "dead", error: lastError };
    } catch (writeError) {
      // The job row could not be updated; its lease expires and another runner takes it over.
      log.error({ ...details, err: writeError?.message }, "job.settle_failed");
      return { step, outcome: "settle_failed", error: lastError };
    }
  }
};

// A step that keeps failing must never turn into a decision (or into silence): it opens a review case
// so a person knows the automated check could not complete. The case is labelled with the step's own
// source. Supporting steps (satellite, weather) never block or change a decision, so a person is not
// asked to look at them: they are logged here and shown in the reviewer's diagnostics.
const openReviewCaseForDeadJob = async (job, lastError, log = logger) => {
  if (SUPPORTING_STEPS.includes(job.step)) {
    log.warn({ errorCode: lastError.code, errorKind: lastError.kind }, "job.dead_supporting_step_no_review_case");
    return null;
  }
  const claim = await LossClaim.findById(job.claimId).select("state").lean();
  if (!claim || claim.state === "withdrawn") return null;
  const { createReviewCase } = await import("./manualReview.service.js");
  return createReviewCase({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    source: STEP_REVIEW_SOURCE[job.step] || "OWNERSHIP",
    reasons: [`automated_step_failed_${job.step}`],
    metadata: {
      component: "manual_review",
      failedStep: job.step,
      failedComponent: STEP_COMPONENT[job.step] ?? null,
      errorCode: lastError.code,
      errorKind: lastError.kind,
    },
    requestId: job.requestId || null,
  });
};

// ---- dead-job recovery --------------------------------------------------------------------------

// Re-queue dead jobs: a NEW job replaces each one (its history stays on the dead row, which records
// `requeuedAt`), and the engine is queued again after any step that feeds the decision. Only claims
// still `submitted` are touched, each dead job is re-queued once, and a job is not recovered past
// `maxRecoveryRounds`. The worker sweep passes AUTO_RECOVERABLE_KINDS and a cool-down; an admin or
// the CLI may pass any kind (kinds: null) once the cause is fixed.
//
// The claim-state filter is part of the query, not only a check per row: a dead row of a decided or
// withdrawn claim is never re-queued and so never marked, and if such rows filled the batch (`limit`,
// oldest first) every sweep would pick the same ones again and no other dead job would ever be
// recovered. The check per row stays, for a claim that changes state while the sweep runs.
export const requeueDeadJobs = async ({
  claimId = null,
  steps = null,
  kinds = null,
  deadBefore = null,
  maxRecoveryRounds = DEFAULT_MAX_RECOVERY_ROUNDS,
  limit = 50,
  requestId = null,
  actor = "system",
  dryRun = false,
  now = new Date(),
} = {}) => {
  const conditions = [
    { status: "dead" },
    { requeuedAt: null },
    { $or: [{ recoveryRound: { $lt: maxRecoveryRounds } }, { recoveryRound: { $exists: false } }] },
  ];
  // An aggregation does not cast like find(): the claim id and the cut-off are cast here.
  if (claimId) conditions.push({ claimId: claimId instanceof mongoose.Types.ObjectId ? claimId : new mongoose.Types.ObjectId(String(claimId)) });
  if (Array.isArray(steps) && steps.length > 0) conditions.push({ step: { $in: steps } });
  if (Array.isArray(kinds) && kinds.length > 0) conditions.push({ "lastError.kind": { $in: kinds } });
  if (deadBefore) {
    const cutoff = new Date(deadBefore);
    // Rows written before `deadAt` existed fall back to their last update.
    conditions.push({ $or: [{ deadAt: { $lte: cutoff } }, { deadAt: null, updatedAt: { $lte: cutoff } }] });
  }

  const dead = await VerificationJob.aggregate([
    { $match: { $and: conditions } },
    { $sort: { deadAt: 1, updatedAt: 1, _id: 1 } },
    {
      $lookup: {
        from: LossClaim.collection.collectionName,
        localField: "claimId",
        foreignField: "_id",
        pipeline: [{ $match: { state: "submitted" } }, { $project: { _id: 1 } }],
        as: "submittedClaim",
      },
    },
    { $match: { "submittedClaim.0": { $exists: true } } },
    // $limit takes a positive whole number only (the CLI passes what the operator typed).
    { $limit: Math.max(1, Math.floor(Number(limit)) || 50) },
    { $project: { submittedClaim: 0 } },
  ]);
  const summary = { considered: dead.length, requeued: 0, skipped: 0, engineQueued: 0, dryRun: Boolean(dryRun), jobs: [] };
  const engineFor = new Map();

  for (const row of dead) {
    const state = await claimStateOf(row.claimId);
    if (state !== "submitted") {
      summary.skipped += 1;
      continue;
    }
    if (dryRun) {
      summary.requeued += 1;
      summary.jobs.push({ claimId: String(row.claimId), step: row.step, recoveredFrom: String(row._id), recoveryRound: (row.recoveryRound || 0) + 1 });
      continue;
    }
    // Claim the dead row first, so two sweeps can never re-queue it twice.
    const marked = await VerificationJob.updateOne({ _id: row._id, status: "dead", requeuedAt: null }, { $set: { requeuedAt: now } });
    if (marked.modifiedCount === 0) {
      summary.skipped += 1;
      continue;
    }
    const { job, created } = await enqueue({
      claimId: row.claimId,
      cognitoSub: row.cognitoSub,
      step: row.step,
      runAt: now,
      requestId,
      correlationId: row.correlationId || null,
      recoveredFrom: row._id,
      recoveryRound: (row.recoveryRound || 0) + 1,
    });
    if (created) summary.requeued += 1;
    else summary.skipped += 1;
    if (job) summary.jobs.push({ id: String(job._id), claimId: String(row.claimId), step: row.step, recoveredFrom: String(row._id), recoveryRound: job.recoveryRound || 0, created });
    logger.info(
      { claimId: String(row.claimId), step: row.step, recoveredFrom: String(row._id), recoveryRound: (row.recoveryRound || 0) + 1, errorKind: row.lastError?.kind || null, actor, requestId: shortId(requestId) },
      "job.requeued"
    );
    if (DECISION_INPUT_STEPS.includes(row.step)) engineFor.set(String(row.claimId), row);
  }

  for (const row of engineFor.values()) {
    const { created } = await enqueue({ claimId: row.claimId, cognitoSub: row.cognitoSub, step: "engine", runAt: now, requestId, correlationId: row.correlationId || null });
    if (created) summary.engineQueued += 1;
  }
  return summary;
};

// ---- draining -----------------------------------------------------------------------------------

// Claim and run due jobs until none are left, the time budget is spent or `shouldStop` says so.
export const drain = async ({
  claimId = null,
  deadline = null,
  maxJobs = 10,
  now = () => new Date(),
  requestId = null,
  shouldStop = () => false,
  policy = null,
  leaseMs = null,
  heartbeatMs = null,
  rand = Math.random,
} = {}) => {
  const owner = `worker-${randomUUID()}`;
  const results = [];
  // A job skipped for lack of time is released as due. The time left only shrinks, so no other job
  // of that STEP fits in this drain either: excluding the step stops the drain from claiming it (or
  // the same step of another claim) again in a loop, and bounds the skips by the number of steps.
  // A skip does not count towards `maxJobs`, so a one-step poll whose photo check does not fit its
  // budget still runs a shorter step that does (weather, the engine).
  const skippedSteps = [];
  let ran = 0;
  while (ran < maxJobs) {
    if (shouldStop()) break;
    const current = now();
    if (deadline && deadline - current.getTime() <= 0) break;
    const job = await claimNext({ claimId, now: current, owner, leaseMs, excludeSteps: skippedSteps });
    if (!job) break;
    const result = await runJob(job, { now: current, deadline, policy, leaseMs, heartbeatMs, rand, drainRequestId: requestId });
    if (result.outcome === "skipped_no_budget") skippedSteps.push(job.step);
    else ran += 1;
    results.push(result);
  }
  if (results.length > 0) logger.debug({ claimId: claimId ? String(claimId) : null, requestId: shortId(requestId), owner, processed: results.length }, "verification.drain");
  return results;
};

export default {
  enqueue,
  enqueueSteps,
  ensurePlan,
  enqueuePlan,
  cancelJobsForClaim,
  claimNext,
  runJob,
  drain,
  requeueDeadJobs,
  findBlockingJobs,
  countBlockingActiveJobs,
  blockingStepsFor,
  setExecutor,
  getExecutor,
  queueSettings,
  retryDelayMs,
  MIN_BUDGET_MS,
  DEFAULT_LEASE_MS,
  ENGINE_MAX_RESCHEDULES,
  NON_BLOCKING_STEPS,
};
