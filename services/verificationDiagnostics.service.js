import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob, { JOB_STEPS } from "../models/VerificationJob.js";
import logger from "../utils/logger.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { isReviewCase } from "./verificationComponents.js";
import { latestJobFor } from "./claimProgress.js";
import { buildProgressForClaim } from "./claimProgress.service.js";
import { requeueDeadJobs } from "./verificationJobs.service.js";
import { serializeAssessmentDoc, serializeAudit, serializeAdminAction } from "./admin.service.js";

// ADR-022 (plan A6, owner decision D9) — the reviewer's view of a claim's automated verification, and
// the one recovery action a reviewer has over it. Admin-only: the routes sit behind requireAuth +
// requireRole("admin") + adminLimiter (app.js, routes/admin.js).
//
// The diagnostics show what the farmer view deliberately hides (job attempts, error codes, the
// attempt log, review cases, NDVI internals, the audit trail) next to the farmer's own progress
// object, so a reviewer can see exactly what the farmer is being told. Read-only.

const iso = (value) => (value ? new Date(value).toISOString() : null);

const serializeJob = (job) => ({
  id: String(job._id),
  step: job.step,
  status: job.status,
  planKey: job.planKey ?? null,
  attempts: job.attempts ?? 0,
  maxAttempts: job.maxAttempts ?? null,
  runAt: iso(job.runAt),
  startedAt: iso(job.startedAt),
  lastAttemptAt: iso(job.lastAttemptAt),
  completedAt: iso(job.completedAt),
  deadAt: iso(job.deadAt),
  cancelledAt: iso(job.cancelledAt),
  cancelReason: job.cancelReason ?? null,
  leaseOwner: job.leaseOwner ?? null,
  leaseUntil: iso(job.leaseUntil),
  recoveryRound: job.recoveryRound ?? 0,
  recoveredFrom: job.recoveredFrom ? String(job.recoveredFrom) : null,
  requeuedAt: iso(job.requeuedAt),
  rescheduleCount: job.rescheduleCount ?? 0,
  rerunRequested: Boolean(job.rerunRequested),
  lastError:
    job.lastError && (job.lastError.code || job.lastError.kind)
      ? {
          code: job.lastError.code ?? null,
          kind: job.lastError.kind ?? null,
          retryable: job.lastError.retryable ?? null,
          message: job.lastError.message ?? null,
          at: iso(job.lastError.at),
        }
      : null,
  attemptLog: (job.attemptLog || []).map((entry) => ({
    attempt: entry.attempt ?? null,
    at: iso(entry.at),
    outcome: entry.outcome ?? null,
    code: entry.code ?? null,
    kind: entry.kind ?? null,
    durationMs: entry.durationMs ?? null,
  })),
  resultSummary: job.resultSummary ?? null,
  requestId: job.requestId ?? null,
  correlationId: job.correlationId ?? null,
  createdAt: iso(job.createdAt),
  updatedAt: iso(job.updatedAt),
});

const serializeEvidence = (row) => ({
  id: String(row._id),
  source: row.source,
  component: row.component ?? null,
  kind: row.kind ?? (isReviewCase(row) ? "review_case" : "evidence"),
  status: row.status,
  confidence: row.confidence ?? null,
  observedAt: iso(row.observedAt),
  provider: row.provider ?? null,
  providerVersion: row.providerVersion ?? null,
  evidenceVersion: row.evidenceVersion ?? null,
  evaluationVersion: row.evaluationVersion ?? null,
  reference: row.reference ?? null,
  idempotencyKey: row.idempotencyKey ?? null,
  inputFingerprint: row.inputFingerprint ?? null,
  attempt: row.attempt ?? 1,
  supersedes: row.supersedes ? String(row.supersedes) : null,
  metadata: row.metadata || {},
  result: row.result ?? null,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

const serializeReviewCase = (row) => {
  const metadata = row.metadata || {};
  const result = row.result || {};
  return {
    id: String(row._id),
    status: row.status,
    source: row.source,
    reasons: Array.isArray(result.reviewReasons) ? result.reviewReasons : [],
    failedStep: metadata.failedStep ?? null,
    failedComponent: metadata.failedComponent ?? null,
    errorCode: metadata.errorCode ?? null,
    errorKind: metadata.errorKind ?? null,
    createdAt: iso(row.createdAt),
    resolvedAt: result.resolvedAt ?? null,
    resolvedDecision: result.resolvedDecision ?? null,
  };
};

// The satellite internals a reviewer needs beside the farmer's satellite status.
const satelliteInternals = ({ rows, jobs }) => {
  const latest = rows
    .filter((row) => row.source === "SATELLITE" && !isReviewCase(row))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const job = latestJobFor(jobs, "satellite");
  const metadata = (latest && latest.metadata) || {};
  const result = (latest && latest.result) || {};
  return {
    evidenceStatus: latest ? latest.status : null,
    adapterOutcome: metadata.outcome ?? null,
    processingStatus: metadata.processingStatus ?? null,
    analysisExecuted: metadata.analysisExecuted ?? null,
    analysisOutcome: result.analysisOutcome ?? null,
    deltaNdvi: Number.isFinite(result.deltaNdvi) ? result.deltaNdvi : null,
    sceneCount: metadata.sceneCount ?? null,
    evaluationVersion: latest ? latest.evaluationVersion ?? null : null,
    recordedAt: latest ? iso(latest.createdAt) : null,
    rowCount: rows.filter((row) => row.source === "SATELLITE" && !isReviewCase(row)).length,
    job: job ? { id: String(job._id), status: job.status, runAt: iso(job.runAt), rescheduleCount: job.rescheduleCount ?? 0, lastErrorCode: job.lastError?.code ?? null } : null,
  };
};

export const getVerificationDiagnostics = async ({ claimId, now = new Date() } = {}) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) throw ApiError.badRequest("Valid claim id is required");
  const claim = await LossClaim.findById(claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const [assessment, jobs, rows, audits, adminActions, progress] = await Promise.all([
    ClaimAssessment.findOne({ claimId: claim._id }),
    VerificationJob.find({ claimId: claim._id }).sort({ createdAt: 1, _id: 1 }).lean(),
    VerificationEvidence.find({ claimId: claim._id }).sort({ createdAt: 1 }).lean(),
    ClaimAudit.find({ claimId: claim._id }).sort({ createdAt: 1 }),
    AdminAction.find({ claimId: claim._id }).sort({ createdAt: 1 }),
    buildProgressForClaim({ claim, now }),
  ]);
  const configured = resolvePolicy();
  const assessmentView = serializeAssessmentDoc(assessment);
  const doc = assessment ? assessment.toObject() : null;

  return {
    claimId: String(claim._id),
    claimState: claim.state,
    submissionRound: claim.submissionRound ?? 0,
    firstSubmittedAt: iso(claim.firstSubmittedAt),
    submittedAt: iso(claim.submittedAt),
    decidedAt: iso(claim.decidedAt),
    policy: {
      configured: { id: configured.id, hash: configured.hash },
      decidedUnder: doc && doc.policy && doc.policy.id ? { id: doc.policy.id, hash: doc.policy.hash ?? null } : null,
    },
    jobs: jobs.map(serializeJob),
    assessment: assessmentView
      ? {
          ...assessmentView,
          evidenceVersion: doc.evidenceVersion ?? null,
          slotLeaseUntil: iso(doc.slotLeaseUntil),
          hold: doc.hold ?? null,
          components: doc.components ?? null,
          policy: doc.policy && doc.policy.id ? { id: doc.policy.id, hash: doc.policy.hash ?? null } : null,
        }
      : null,
    evidence: rows.map(serializeEvidence),
    reviewCases: rows.filter(isReviewCase).map(serializeReviewCase),
    satellite: { ...progress.satellite, internals: satelliteInternals({ rows, jobs }) },
    audit: audits.map(serializeAudit),
    adminActions: adminActions.map(serializeAdminAction),
    progress,
  };
};

// D9 recovery: re-queue a claim's DEAD jobs once a person has dealt with the cause (a key fixed, a
// quota raised), whatever kind of failure killed them. Each dead job is replaced by a new one (its
// history stays on the dead row) and the engine runs again after any decision input. A call that finds
// nothing to re-queue (for example a repeat while the new jobs are still active) changes and records
// nothing. A person may go past the worker's automatic recovery limit, but not without bound.
//
// Recorded FIRST (stage-1 review): the immutable AdminAction `jobs_requeued` (with the dead jobs it
// will replace) is written before any job changes, so a failed write leaves nothing re-queued and
// unrecorded. Then the jobs are re-queued and the ClaimAudit row records what actually happened. If the
// re-queue itself fails, a `verification_jobs_requeue_failed` audit row says so (best effort); if the
// audit write fails after the re-queue, the AdminAction already records the action and the response
// says `auditRecorded: false`.
export const MANUAL_MAX_RECOVERY_ROUNDS = 10;

export const requeueClaimJobs = async ({ claimId, steps = null, reason, actorSub, actorEmail = null, requestId = null, now = new Date() } = {}) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) throw ApiError.badRequest("Valid claim id is required");
  const claim = await LossClaim.findById(claimId).select("state").lean();
  if (!claim) throw ApiError.notFound("Claim not found");
  // Only a claim still waiting for its decision has work to resume.
  if (claim.state !== "submitted") throw ApiError.conflict(`Jobs can only be re-queued for a submitted claim (this claim is ${claim.state})`);
  const stepList = Array.isArray(steps) && steps.length > 0 ? [...new Set(steps)].filter((step) => JOB_STEPS.includes(step)) : null;
  const selection = { claimId: claim._id, steps: stepList, kinds: null, maxRecoveryRounds: MANUAL_MAX_RECOVERY_ROUNDS, requestId, actor: "admin", now };

  // 1. What would be re-queued (changes nothing).
  const plan = await requeueDeadJobs({ ...selection, dryRun: true });
  if (plan.jobs.length === 0) {
    return { requeued: 0, engineQueued: 0, jobs: [], idempotent: true, adminAction: null };
  }

  // 2. The immutable record, before anything changes.
  const planned = plan.jobs.map((job) => ({ step: job.step, recoveredFrom: job.recoveredFrom, recoveryRound: job.recoveryRound }));
  const adminAction = await AdminAction.create({
    claimId: claim._id,
    action: "jobs_requeued",
    actorSub,
    actorEmail,
    priorState: claim.state,
    targetState: claim.state,
    reason,
    metadata: { steps: planned.map((job) => job.step), planned },
    requestId,
  });
  const adminActionId = String(adminAction._id);

  // 3. The re-queue itself.
  let summary;
  try {
    summary = await requeueDeadJobs(selection);
  } catch (error) {
    await ClaimAudit.create({
      claimId: claim._id,
      actor: "admin",
      action: "verification_jobs_requeue_failed",
      fromState: claim.state,
      toState: claim.state,
      reason,
      metadata: { adminActionId, planned, error: String(error?.code || error?.name || "error").slice(0, 60) },
      requestId,
    }).catch((auditError) => logger.error({ claimId: String(claim._id), requestId, adminActionId, err: auditError?.message }, "verification.requeue_failure_not_audited"));
    throw error;
  }
  const requeued = summary.jobs.filter((job) => job.created);
  const metadata = {
    steps: requeued.map((job) => job.step),
    jobs: requeued.map((job) => ({ id: job.id, step: job.step, recoveredFrom: job.recoveredFrom, recoveryRound: job.recoveryRound })),
    engineQueued: summary.engineQueued,
    planned: planned.length,
  };

  // 4. The claim's audit trail: what actually happened (a race may have re-queued fewer than planned).
  let auditRecorded = true;
  try {
    await ClaimAudit.create({
      claimId: claim._id,
      actor: "admin",
      action: "verification_jobs_requeued",
      fromState: claim.state,
      toState: claim.state,
      reason,
      metadata: { ...metadata, adminActionId },
      requestId,
    });
  } catch (error) {
    auditRecorded = false;
    logger.error({ claimId: String(claim._id), requestId, adminActionId, err: error?.message }, "verification.requeue_audit_failed");
  }
  logger.info({ claimId: String(claim._id), requestId, steps: metadata.steps, engineQueued: summary.engineQueued, adminActionId }, "verification.jobs_requeued_by_admin");
  return {
    requeued: requeued.length,
    engineQueued: summary.engineQueued,
    jobs: metadata.jobs,
    idempotent: false,
    adminAction: serializeAdminAction(adminAction),
    auditRecorded,
  };
};

export default { getVerificationDiagnostics, requeueClaimJobs };
