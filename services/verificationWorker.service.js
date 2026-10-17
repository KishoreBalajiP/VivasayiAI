import { randomUUID } from "node:crypto";
import ClaimAssessment from "../models/ClaimAssessment.js";
import LossClaim from "../models/LossClaim.js";
import VerificationJob from "../models/VerificationJob.js";
import logger from "../utils/logger.js";
import { env } from "../config/env.js";
import { drain, enqueue, ensurePlan, queueSettings, requeueDeadJobs, AUTO_RECOVERABLE_KINDS } from "./verificationJobs.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";

// ADR-021 — entry point for a scheduled invocation (for example an EventBridge rule on the Lambda).
// Kept free of the top-level database connection in index.js so it can be tested directly.

// A claim held longer than the policy allows gets an explicit review case, so a person knows it is
// waiting. It is never decided or rejected automatically.
export const sweepStaleHolds = async ({ now = new Date() } = {}) => {
  const policy = resolvePolicy();
  if (!policy.maxHoldHours) return { checked: 0, escalated: 0 };

  const cutoff = new Date(now.getTime() - policy.maxHoldHours * 60 * 60 * 1000);
  const stale = await ClaimAssessment.find({ "verification.status": "held", "hold.since": { $lte: cutoff } })
    .select("claimId")
    .limit(100)
    .lean();

  const { createReviewCase } = await import("./manualReview.service.js");
  let escalated = 0;
  for (const row of stale) {
    const claim = await LossClaim.findById(row.claimId).lean();
    if (!claim || claim.state !== "submitted") continue;
    await createReviewCase({
      claimId: claim._id,
      cognitoSub: claim.cognitoSub,
      source: "OWNERSHIP",
      reasons: ["hold_exceeded_maximum_duration"],
      metadata: { component: "manual_review", maxHoldHours: policy.maxHoldHours },
    }).then(() => { escalated += 1; }).catch((error) => logger.warn({ err: error?.message }, "stale hold escalation failed"));
  }
  return { checked: stale.length, escalated };
};

// ADR-022: a claim left in `processing` (its run died between the engine's lock and the decision) is
// returned to `submitted` and its engine queued again. Moved here from the 2026-10 components migration
// so the worker recovers it every run.
//
// The candidates are filtered IN THE QUERY (stage-1 review, the same starvation fix as requeueDeadJobs):
//   - a claim whose decision was already written (assessment decided and completed) is not a candidate,
//     so 50 such claims can never fill the batch and starve a really stuck one; they are reported
//     (`decidedButProcessing`, a warning) for a person, never released;
//   - a claim whose ENGINE job is still running under a live lease is not a candidate either: that run
//     is slow, not dead (its heartbeat keeps renewing the lease), and releasing the claim under it would
//     start a second evaluation racing the first.
export const STUCK_PROCESSING_AFTER_MS = 15 * 60 * 1000;
const DECIDED_ASSESSMENT = { state: { $nin: [null, ""] }, "verification.status": "completed" };
const stuckClaimsPipeline = ({ cutoff, now, decided }) => [
  { $match: { state: "processing", $or: [{ processedAt: { $lte: cutoff } }, { processedAt: null, updatedAt: { $lte: cutoff } }] } },
  {
    $lookup: {
      from: ClaimAssessment.collection.collectionName,
      localField: "_id",
      foreignField: "claimId",
      pipeline: [{ $match: DECIDED_ASSESSMENT }, { $limit: 1 }, { $project: { _id: 1 } }],
      as: "decision",
    },
  },
  { $match: { "decision.0": { $exists: decided } } },
  ...(decided
    ? []
    : [
        {
          $lookup: {
            from: VerificationJob.collection.collectionName,
            let: { claimId: "$_id" },
            pipeline: [
              { $match: { $expr: { $and: [{ $eq: ["$claimId", "$$claimId"] }, { $eq: ["$step", "engine"] }, { $eq: ["$status", "running"] }, { $gt: ["$leaseUntil", now] }] } } },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: "liveEngine",
          },
        },
        { $match: { "liveEngine.0": { $exists: false } } },
      ]),
  { $sort: { processedAt: 1, updatedAt: 1, _id: 1 } },
];

export const releaseStuckProcessingClaims = async ({ now = new Date(), stuckAfterMs = STUCK_PROCESSING_AFTER_MS, limit = 50, dryRun = false } = {}) => {
  const cutoff = new Date(now.getTime() - stuckAfterMs);
  const batch = Math.max(1, Math.floor(Number(limit)) || 50);
  const stuck = await LossClaim.aggregate([...stuckClaimsPipeline({ cutoff, now, decided: false }), { $limit: batch }, { $project: { _id: 1, cognitoSub: 1 } }]);
  const decided = await LossClaim.aggregate([...stuckClaimsPipeline({ cutoff, now, decided: true }), { $limit: batch }, { $project: { _id: 1 } }]);
  if (decided.length > 0) {
    logger.warn({ count: decided.length, claimIds: decided.slice(0, 10).map((claim) => String(claim._id)) }, "verification.decided_claim_still_processing");
  }

  const summary = { checked: stuck.length, released: 0, claimIds: [], decidedButProcessing: decided.length };
  for (const claim of stuck) {
    // Re-checked per claim: a decision or a new engine run may have landed since the query.
    const assessment = await ClaimAssessment.findOne({ claimId: claim._id }).select("verification state").lean();
    if (assessment && assessment.state && assessment.verification && assessment.verification.status === "completed") continue;
    if (await VerificationJob.exists({ claimId: claim._id, step: "engine", status: "running", leaseUntil: { $gt: now } })) continue;
    if (dryRun) {
      summary.released += 1;
      summary.claimIds.push(String(claim._id));
      continue;
    }
    // Imported on use: the verification service pulls in the AI clients, which the queue does not need.
    const { releaseProcessingSlot } = await import("./claimVerification.service.js");
    const released = await releaseProcessingSlot({ claimId: claim._id, reason: "Released by the worker: verification was interrupted" });
    if (!released) continue;
    summary.released += 1;
    summary.claimIds.push(String(claim._id));
    await enqueue({ claimId: claim._id, cognitoSub: claim.cognitoSub, step: "engine" });
    logger.warn({ claimId: String(claim._id) }, "verification.stuck_claim_released");
  }
  return summary;
};

// Re-queue dead jobs whose failure was transient (quota, overload, timeout, network, storage) once
// the cool-down (VERIFICATION_DEAD_RECOVERY_AFTER_MS, default 6 h) has passed. At most two rounds.
export const recoverDeadJobs = async ({ now = new Date(), requestId = null } = {}) =>
  requeueDeadJobs({
    kinds: [...AUTO_RECOVERABLE_KINDS],
    deadBefore: new Date(now.getTime() - queueSettings().deadRecoveryAfterMs),
    requestId,
    actor: "worker",
    now,
  });

// ADR-022 safety net for a lost plan: a submitted claim with NO engine job created since its latest
// (re)submission, and none active, gets its round's plan (ensurePlan, idempotent per round). That
// covers a submit whose plan could not be written (it answered 503 and was never retried) and
// claims submitted before durable enqueue existed. Keyed on "no engine job after submittedAt" rather
// than on the plan key, so a legacy claim is planned once, never again after the backfill gives it a
// round number (critique D8). A claim is left alone for `graceMs` after its submission, while the
// request that submitted it may still be writing the plan. Only runs with automated verification on.
export const RECONCILE_GRACE_MS = 5 * 60 * 1000;
export const reconcilePlans = async ({ now = new Date(), graceMs = RECONCILE_GRACE_MS, limit = 50, requestId = null, dryRun = false } = {}) => {
  if (!env.claimAutomatedVerificationEnabled) return { checked: 0, planned: 0, claimIds: [], skipped: "automation_disabled" };
  const cutoff = new Date(now.getTime() - graceMs);
  const orphans = await LossClaim.aggregate([
    { $match: { state: "submitted", submittedAt: { $ne: null, $lte: cutoff } } },
    {
      $lookup: {
        from: "verificationjobs",
        let: { claimId: "$_id", submittedAt: "$submittedAt" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$claimId", "$$claimId"] },
                  { $eq: ["$step", "engine"] },
                  { $or: [{ $gte: ["$createdAt", "$$submittedAt"] }, { $in: ["$status", ["queued", "running"]] }] },
                ],
              },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: "engineJobs",
      },
    },
    { $match: { engineJobs: { $size: 0 } } },
    { $sort: { submittedAt: 1 } },
    { $limit: Math.max(1, limit) },
    { $project: { _id: 1, cognitoSub: 1 } },
  ]);

  const summary = { checked: orphans.length, planned: 0, claimIds: [] };
  for (const claim of orphans) {
    if (dryRun) {
      summary.planned += 1;
      summary.claimIds.push(String(claim._id));
      continue;
    }
    const jobs = await ensurePlan({ claimId: claim._id, cognitoSub: claim.cognitoSub, requestId, trigger: "reconcile" });
    if (jobs.length === 0) continue;
    summary.planned += 1;
    summary.claimIds.push(String(claim._id));
    logger.warn({ claimId: String(claim._id), requestId, steps: jobs.map((job) => job.step) }, "verification.plan_reconciled");
  }
  return summary;
};

// One worker batch: due jobs first, then the sweeps (unless `sweeps` is false or the worker is
// stopping). Each sweep is bounded and runs on its own: a failing sweep never stops the others.
export const drainDueJobs = async ({ deadline, now = () => new Date(), maxJobs = 25, shouldStop = () => false, requestId = null, sweeps = true } = {}) => {
  const results = await drain({ deadline, maxJobs, now, shouldStop, requestId });
  const sweepSafely = async (name, run) => {
    try {
      return await run();
    } catch (error) {
      logger.error({ err: error?.message, sweep: name }, "verification.sweep_failed");
      return { failed: true };
    }
  };
  if (!sweeps || shouldStop()) return { processed: results.length, results, sweep: null };
  const stuckClaims = await sweepSafely("stuck_claims", () => releaseStuckProcessingClaims({ now: now() }));
  const reconciled = await sweepSafely("reconcile_plans", () => reconcilePlans({ now: now(), requestId }));
  const recovered = await sweepSafely("dead_jobs", () => recoverDeadJobs({ now: now(), requestId }));
  const holds = await sweepSafely("stale_holds", () => sweepStaleHolds({ now: now() }));
  return {
    processed: results.length,
    results,
    sweep: {
      checked: holds.checked ?? 0,
      escalated: holds.escalated ?? 0,
      stuckClaimsReleased: stuckClaims.released ?? 0,
      plansReconciled: reconciled.planned ?? 0,
      deadJobsRequeued: recovered.requeued ?? 0,
    },
  };
};

// Wait up to `ms`, returning early once `shouldStop` says so (checked every `stepMs`).
const waitUnlessStopped = async (ms, shouldStop, stepMs = 100) => {
  const until = Date.now() + ms;
  while (!shouldStop() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, Math.max(1, until - Date.now()))));
  }
};

// ADR-022 (owner decision D7) — the long-running worker loop (`npm run worker`; the e2e harness runs
// it in-process). Each batch drains due jobs under its own time budget and request id; when a batch
// finds nothing to do the loop sleeps for `pollIntervalMs`. The sweeps run at most every
// `sweepIntervalMs`. Stopping is graceful: `shouldStop` is checked between jobs, so the job in flight
// always finishes (and keeps its lease renewed) before the loop returns.
export const runWorkerLoop = async ({
  shouldStop = () => false,
  pollIntervalMs = 5000,
  batchBudgetMs = 240_000,
  maxJobsPerBatch = 25,
  sweepIntervalMs = 60_000,
  onBatch = null,
} = {}) => {
  let batches = 0;
  let processed = 0;
  let lastSweepAt = 0;
  while (!shouldStop()) {
    const requestId = `worker-${randomUUID()}`;
    const sweeps = Date.now() - lastSweepAt >= sweepIntervalMs;
    let result;
    try {
      result = await drainDueJobs({ deadline: Date.now() + batchBudgetMs, maxJobs: maxJobsPerBatch, shouldStop, requestId, sweeps });
      if (sweeps) lastSweepAt = Date.now();
    } catch (error) {
      // A batch that failed as a whole (the database went away) is logged and retried after a pause.
      logger.error({ err: error?.message, requestId }, "worker.batch_failed");
      result = { processed: 0, results: [], sweep: null, failed: true };
    }
    batches += 1;
    processed += result.processed || 0;
    if (result.processed > 0) logger.info({ requestId, processed: result.processed, sweep: result.sweep }, "worker.batch");
    if (onBatch) await onBatch(result, batches);
    if (shouldStop()) break;
    if (!result.processed) await waitUnlessStopped(pollIntervalMs, shouldStop);
  }
  return { batches, processed };
};

// The scheduled Lambda entry point (index.js `worker`, EventBridge in infra/verification-worker.yaml).
// It stops starting new jobs 10 s before the invocation's own timeout, and tags every job it runs
// with the invocation's awsRequestId so a CloudWatch search finds them.
export const WORKER_STOP_MARGIN_MS = 10_000;
export const handleScheduledWorker = async (_event, context = {}, { run = drainDueJobs } = {}) => {
  const remaining = context && typeof context.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 25_000;
  const requestId = (context && context.awsRequestId) || `worker-${randomUUID()}`;
  const maxJobs = Number(process.env.WORKER_MAX_JOBS) || 25;
  return run({ deadline: Date.now() + Math.max(0, remaining - WORKER_STOP_MARGIN_MS), maxJobs, requestId });
};

// Ask for a fresh decision, for example after a reviewer resolved a document or a review case.
export const requestReevaluation = async ({ claimId, cognitoSub }) =>
  enqueue({ claimId, cognitoSub, step: "engine" }).catch((error) => {
    logger.warn({ err: error?.message }, "could not enqueue re-evaluation");
    return null;
  });

export default {
  drainDueJobs,
  sweepStaleHolds,
  releaseStuckProcessingClaims,
  reconcilePlans,
  recoverDeadJobs,
  runWorkerLoop,
  handleScheduledWorker,
  requestReevaluation,
};
