import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import { computeEvidenceVersion } from "./claimAssessment.service.js";
import { correlationIdFor, drain, enqueueSteps, ensurePlan, planKeyForRound } from "./verificationJobs.service.js";

// Automated claim-verification orchestration (Phase 15), reworked under ADR-021.
//
// The previous version ran every step inside a fire-and-forget promise after the HTTP response. On
// AWS Lambda the container is frozen once the response is sent, so that work could simply never
// finish, and its "already running" guard was per-process memory. Submit now only ENQUEUES the work
// as durable job rows (services/verificationJobs.service.js); the steps run when someone drains the
// queue: the verify call, a status read, or the scheduled worker.
//
// ADR-022: the enqueue is AWAITED inside the request. The job rows exist before the response is
// sent, carry the request id and a per-round correlation id, and are idempotent per round (plan key
// `r<submissionRound>`), so a client that retries after a 503 recovers a lost plan instead of
// creating a second one.

export const PLAN_FAILED_MESSAGE = "Your claim was saved, but its checks could not be scheduled. Please try again.";

const planFailed = (error, context) => {
  logger.error({ ...context, err: error?.message, code: "PLAN_ENQUEUE_FAILED" }, "verification.plan_failed");
  return ApiError.serviceUnavailable(PLAN_FAILED_MESSAGE);
};

// Submit / resubmit (and their retries): make sure the round's plan exists. Throws a 503 when the
// jobs could not be written; the claim itself is already saved, and a retry recovers the plan.
export const scheduleAutomatedVerification = async ({ claimId, cognitoSub, requestId = null, trigger = "submit" } = {}) => {
  if (!env.claimAutomatedVerificationEnabled) return [];
  try {
    return await ensurePlan({ claimId, cognitoSub, requestId, trigger });
  } catch (error) {
    throw planFailed(error, { claimId: String(claimId), requestId, trigger });
  }
};

// Kept for existing callers. Now awaited and scheduling-only; errors are logged, not thrown.
export const triggerAutomatedVerification = async (claimId, cognitoSub, requestId = null) => {
  try {
    return await scheduleAutomatedVerification({ claimId, cognitoSub, requestId, trigger: "trigger" });
  } catch {
    return [];
  }
};

// Evidence that arrives AFTER submit (the claim is `submitted`) is checked automatically too. A
// draft gets its plan at submit, and a `more_evidence_required` claim at resubmit, so nothing is
// queued for them here. Late-evidence failures never fail the upload itself: the evidence is stored,
// the error is logged, and a repeated complete/attach call schedules again (the plan keys make that
// idempotent). A step that is RUNNING when the evidence arrives may already have read the old set:
// it is asked to run once more when it finishes (`rerunIfRunning`), because no second job can be
// queued beside it.
const scheduleLate = async ({ claimId, cognitoSub, requestId, trigger, steps, planSuffix }) => {
  if (!env.claimAutomatedVerificationEnabled) return [];
  try {
    const claim = await LossClaim.findOne({ _id: claimId, cognitoSub }).select("state submissionRound").lean();
    if (!claim || claim.state !== "submitted") return [];
    const round = claim.submissionRound || 0;
    const { jobs } = await enqueueSteps({
      claimId: claim._id,
      cognitoSub,
      steps: await steps(claim),
      planKey: `${planKeyForRound(round)}:${await planSuffix(claim)}`,
      requestId,
      correlationId: correlationIdFor(claim._id, round),
      rerunIfRunning: true,
    });
    return jobs;
  } catch (error) {
    logger.error({ claimId: String(claimId), requestId, trigger, err: error?.message, code: "PLAN_ENQUEUE_FAILED" }, "verification.late_evidence_plan_failed");
    return [];
  }
};

// A photo was added or removed after submit: assess the (new) photo set again, then decide again.
// The plan key carries the photo-set version, so the same set is never planned twice.
export const scheduleEvidencePlan = async ({ claimId, cognitoSub, requestId = null, trigger = "evidence" } = {}) => {
  let stored = null;
  const photos = async (claim) => {
    if (!stored) stored = await ClaimEvidence.find({ claimId: claim._id, status: "stored" }).select("uploadId updatedAt").lean();
    return stored;
  };
  return scheduleLate({
    claimId,
    cognitoSub,
    requestId,
    trigger,
    steps: async (claim) => ((await photos(claim)).length > 0 ? ["ai_assessment", "engine"] : ["engine"]),
    planSuffix: async (claim) => `ev:${computeEvidenceVersion(await photos(claim)).slice(0, 12)}`,
  });
};

// A land document was attached after submit: examine it, look it up in the official record, decide again.
export const scheduleDocumentPlan = async ({ claimId, cognitoSub, evidenceId, requestId = null, trigger = "document" } = {}) =>
  scheduleLate({
    claimId,
    cognitoSub,
    requestId,
    trigger,
    steps: async () => ["land_documents", "official_land_record", "engine"],
    planSuffix: async () => `doc:${String(evidenceId)}`,
  });

// Run the claim's due jobs now (bounded by `deadline`, an epoch-ms time).
export const runAutomatedVerification = async ({ claimId, deadline = null } = {}) => {
  const results = await drain({ claimId, deadline });
  return { claimId: String(claimId), results };
};

export default {
  scheduleAutomatedVerification,
  triggerAutomatedVerification,
  scheduleEvidencePlan,
  scheduleDocumentPlan,
  runAutomatedVerification,
};
