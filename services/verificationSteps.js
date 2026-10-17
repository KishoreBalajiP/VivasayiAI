import { createHash } from "node:crypto";
import logger from "../utils/logger.js";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { recordEvidenceRun } from "./verificationEvidence.service.js";
import { fetchEventRainfall, claimCentroid } from "./weatherArchive.service.js";
import { setExecutor, getExecutor, enqueue } from "./verificationJobs.service.js";
import { ProviderError, PROVIDER_ERROR_KINDS } from "../utils/providerErrors.js";
import claimAssessmentService, { computeEvidenceVersion } from "./claimAssessment.service.js";
import * as landDocService from "./landDocumentExamination.service.js";
import * as officialLandRecordService from "./officialLandRecord.service.js";
import * as satelliteVerificationService from "./satelliteVerification.service.js";
import claimVerificationService from "./claimVerification.service.js";

// ADR-021 — the real executors behind each job step. Each returns a small summary that holds no
// document text, identifiers or personal data. A step registers only if nothing is registered yet,
// so tests can substitute their own executor first.

// Every step this module provides, whether or not a test pre-registered a replacement.
export const PROVIDED_STEPS = [];
// The real executor of each step, so a test that replaced one can put the real one back.
export const DEFAULT_EXECUTORS = {};

const register = (step, fn) => {
  PROVIDED_STEPS.push(step);
  DEFAULT_EXECUTORS[step] = fn;
  if (!getExecutor(step)) setExecutor(step, fn);
};

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// The photo check runs image by image within the job's own time budget (mode "job": a per-image
// timeout, a checkpoint after every image). Out of time, it releases its slot with the progress
// saved and asks to run again at once; another runner holding the slot means "look again later".
// Neither uses an attempt.
const PARTIAL_RESUME_MS = 1000;
const OTHER_RUNNER_RECHECK_MS = 60_000;
// A photo set that keeps changing under the check is assessed again at most until the job has been
// put back this often in all; then the step finishes and the engine assesses the set it finds (and,
// under a technical hold, queues the check again if that fails). Never an endless loop of model calls.
const EVIDENCE_CHANGE_MAX_RESCHEDULES = 30;

register("ai_assessment", async (job, { now = new Date(), deadline = null, requestId = null } = {}) => {
  const result = await claimAssessmentService.assessClaimEvidence({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    requestId,
    mode: "job",
    deadline,
  });
  const status = result && result.status ? result.status : null;
  if (status === "processing") {
    const partial = Boolean(result.partial);
    return {
      status,
      partial,
      rescheduleAt: new Date(now.getTime() + (partial ? PARTIAL_RESUME_MS : OTHER_RUNNER_RECHECK_MS)),
    };
  }
  if (status === "completed") {
    // The photos changed after this run read them (a photo added or removed while it ran, or a run
    // that lost a race returned someone else's older result): assess the current set too, at once
    // and without using an attempt. The job stays active, so the engine keeps waiting and never
    // decides on a stale set or has to assess the new photos itself inside its own time budget.
    const stored = await ClaimEvidence.find({ claimId: job.claimId, status: "stored" }).select("uploadId updatedAt").lean();
    if (stored.length > 0 && computeEvidenceVersion(stored) !== result.evidenceVersion) {
      if ((job.rescheduleCount || 0) < EVIDENCE_CHANGE_MAX_RESCHEDULES) {
        return { status, evidenceChanged: true, rescheduleAt: new Date(now.getTime() + PARTIAL_RESUME_MS) };
      }
      logger.warn({ claimId: String(job.claimId), jobId: String(job._id), rescheduleCount: job.rescheduleCount }, "verification.photo_set_still_changing");
      return { status, evidenceChanged: true };
    }
    // A re-run photo check (late evidence, a recovered job) for a claim the engine is holding: ask
    // for a fresh decision, so the hold is re-evaluated against the new result.
    const [claim, assessment] = await Promise.all([
      LossClaim.findById(job.claimId).select("state").lean(),
      ClaimAssessment.findOne({ claimId: job.claimId }).select("verification.status state").lean(),
    ]);
    if (claim && claim.state === "submitted" && assessment && !assessment.state && assessment.verification && assessment.verification.status === "held") {
      await enqueue({ claimId: job.claimId, cognitoSub: job.cognitoSub, step: "engine", requestId, correlationId: job.correlationId || null });
    }
  }
  return { status };
});

// A document the model could not examine for a RETRYABLE reason (quota, overload, timeout, network,
// storage, a key problem) is not a finished step: the job fails with that kind, so the queue retries
// it and, if it keeps failing, opens a review case. Documents already examined are skipped on the
// retry. A failure that retrying cannot fix (an application defect, such as an upload that no longer
// exists) is not retried: it is counted in `failed` and the step finishes, as before ADR-022, so it
// never delays the engine for the whole retry schedule or opens a review case of its own.
// Several retryable kinds: the one that needs the most attention names the failure.
const RETRYABLE_KIND_ORDER = [
  PROVIDER_ERROR_KINDS.AUTH_CONFIG,
  PROVIDER_ERROR_KINDS.QUOTA,
  PROVIDER_ERROR_KINDS.OVERLOAD,
  PROVIDER_ERROR_KINDS.STORAGE,
  PROVIDER_ERROR_KINDS.TIMEOUT,
  PROVIDER_ERROR_KINDS.NETWORK,
  PROVIDER_ERROR_KINDS.MALFORMED,
];
const kindRank = (kind) => {
  const index = RETRYABLE_KIND_ORDER.indexOf(kind);
  return index === -1 ? RETRYABLE_KIND_ORDER.length : index;
};

register("land_documents", async (job, { requestId = null } = {}) => {
  const result = await landDocService.examineOwnershipDocumentsForClaim({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    requestId,
    skipExamined: true,
  });
  const failures = result.results.filter((entry) => entry.error);
  const retryable = failures.filter((entry) => entry.retryable);
  if (retryable.length > 0) {
    const worst = retryable.reduce((best, entry) => (kindRank(entry.kind) < kindRank(best.kind) ? entry : best));
    throw new ProviderError({
      kind: worst.kind || PROVIDER_ERROR_KINDS.DEFECT,
      provider: "gemini",
      operation: "landdoc.examine",
      statusCode: 500,
      message: `${failures.length} of ${result.count} land document(s) could not be examined`,
    });
  }
  return {
    documents: result.count,
    examined: result.results.filter((entry) => entry.examination).length,
    skipped: result.results.filter((entry) => entry.skipped).length,
    failed: failures.length,
  };
});

register("official_land_record", async (job) => {
  try {
    const result = await officialLandRecordService.verifyOfficialLandRecordForClaim({ claimId: job.claimId, cognitoSub: job.cognitoSub });
    return { status: result.result.status };
  } catch (error) {
    // No examined document yet is not a failure of this step; there is simply nothing to look up.
    if (error && error.statusCode === 409) return { skipped: "no_examined_document" };
    throw error;
  }
});

// A provider refusal or timeout is recorded as UNAVAILABLE evidence and tried again an hour later,
// a few times, without using an attempt. The engine never waits for satellite (D1), so this delays
// nothing but the supporting evidence itself.
const SATELLITE_TRANSIENT_OUTCOMES = new Set(["QUOTA_EXCEEDED", "TIMEOUT", "PROVIDER_ERROR"]);
const SATELLITE_TRANSIENT_RETRY_MS = 60 * 60 * 1000;
const SATELLITE_TRANSIENT_MAX_RESCHEDULES = 3;

register("satellite", async (job, { now = new Date() } = {}) => {
  const claim = await LossClaim.findOne({ _id: job.claimId, cognitoSub: job.cognitoSub });
  if (!claim || !claim.claimedGeometry) return { skipped: "no_geometry" };
  const result = await satelliteVerificationService.runSatelliteVerificationForClaim({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    claim,
  });
  const run = result.run || null;
  const transient =
    run && run.evidenceStatus === "UNAVAILABLE" && SATELLITE_TRANSIENT_OUTCOMES.has(run.outcome) &&
    (job.rescheduleCount || 0) < SATELLITE_TRANSIENT_MAX_RESCHEDULES;
  return {
    recorded: result.recorded,
    skipped: result.skipped || null,
    status: run && run.evidenceStatus ? run.evidenceStatus : null,
    transient: Boolean(transient),
    // Ask the queue to run this step again: after a transient provider failure, or when the
    // post-event window opens or completes.
    rescheduleAt: transient ? new Date(now.getTime() + SATELLITE_TRANSIENT_RETRY_MS) : result.rescheduleAt || null,
  };
});

// Rainfall around the event: supporting evidence only. Recorded as append-only history keyed by the
// inputs, so a later, better lookup (archive data arrives days after the event) adds a new row.
register("weather", async (job) => {
  const claim = await LossClaim.findOne({ _id: job.claimId, cognitoSub: job.cognitoSub });
  if (!claim || !claim.claimedGeometry) return { skipped: "no_geometry" };

  const policy = resolvePolicy();
  const { daysBefore, daysAfter } = policy.weather;
  const outcome = await fetchEventRainfall({ geometry: claim.claimedGeometry, eventDate: claim.eventDate, daysBefore, daysAfter });
  const point = claimCentroid(claim.claimedGeometry);
  const fingerprint = createHash("sha1")
    .update(JSON.stringify([point && [point.latitude.toFixed(2), point.longitude.toFixed(2)], isoDate(new Date(claim.eventDate).getTime()), daysBefore, daysAfter, outcome.api || null, outcome.window || null]))
    .digest("hex")
    .slice(0, 24);

  await recordEvidenceRun({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    component: "weather",
    keyPrefix: "wx",
    inputFingerprint: fingerprint,
    source: "WEATHER",
    status: outcome.status,
    // The dev/e2e mock (WEATHER_MODE=mock, ADR-024) names itself, so a stand-in row is never mistaken
    // for an Open-Meteo observation.
    provider: outcome.provider || "open-meteo",
    observedAt: new Date(),
    evaluationVersion: "weather-archive-v1",
    metadata: { api: outcome.api || null, reason: outcome.reason || null, window: outcome.window || null },
    result: outcome.status === "AVAILABLE"
      ? { rainfallTotalMm: outcome.rainfallTotalMm, rainfallPeakMm: outcome.rainfallPeakMm, daysWithRain: outcome.daysWithRain, dailyMm: outcome.dailyMm, locationRounded: outcome.locationRounded }
      : { reason: outcome.reason },
  });
  return { status: outcome.status, reason: outcome.reason || null };
});

// How long the engine waits before looking again at a claim it could not decide yet.
const ENGINE_RECHECK_MS = 60_000;

register("engine", async (job, { now = new Date(), requestId = null } = {}) => {
  const decision = await claimVerificationService.verifyClaim({ claimId: job.claimId, cognitoSub: job.cognitoSub, requestId });
  const summary = { claimState: decision.claimState, held: Boolean(decision.held) };
  // "In progress" is not a result: another run holds the claim, or its photo check is still
  // running (or stuck). Look again later; runJob caps how often (ENGINE_MAX_RESCHEDULES).
  if (decision.inProgress) {
    return { ...summary, inProgress: true, rescheduleAt: new Date(now.getTime() + ENGINE_RECHECK_MS) };
  }
  return summary;
});
