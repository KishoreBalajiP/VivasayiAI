import { createHash } from "node:crypto";
import LossClaim from "../models/LossClaim.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { recordEvidenceRun } from "./verificationEvidence.service.js";
import { fetchEventRainfall, claimCentroid } from "./weatherArchive.service.js";
import { setExecutor, getExecutor } from "./verificationJobs.service.js";
import claimAssessmentService from "./claimAssessment.service.js";
import * as landDocService from "./landDocumentExamination.service.js";
import * as officialLandRecordService from "./officialLandRecord.service.js";
import * as satelliteVerificationService from "./satelliteVerification.service.js";
import claimVerificationService from "./claimVerification.service.js";

// ADR-021 — the real executors behind each job step. Each returns a small summary that holds no
// document text, identifiers or personal data. A step registers only if nothing is registered yet,
// so tests can substitute their own executor first.

// Every step this module provides, whether or not a test pre-registered a replacement.
export const PROVIDED_STEPS = [];

const register = (step, fn) => {
  PROVIDED_STEPS.push(step);
  if (!getExecutor(step)) setExecutor(step, fn);
};

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

register("ai_assessment", async (job) => {
  const result = await claimAssessmentService.assessClaimEvidence({ claimId: job.claimId, cognitoSub: job.cognitoSub });
  return { status: result && result.status ? result.status : null };
});

register("land_documents", async (job) => {
  const result = await landDocService.examineOwnershipDocumentsForClaim({ claimId: job.claimId, cognitoSub: job.cognitoSub });
  return { documents: result.count, failed: result.results.filter((entry) => entry.error).length };
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

register("satellite", async (job) => {
  const claim = await LossClaim.findOne({ _id: job.claimId, cognitoSub: job.cognitoSub });
  if (!claim || !claim.claimedGeometry) return { skipped: "no_geometry" };
  const result = await satelliteVerificationService.runSatelliteVerificationForClaim({
    claimId: job.claimId,
    cognitoSub: job.cognitoSub,
    claim,
  });
  return {
    recorded: result.recorded,
    skipped: result.skipped || null,
    status: result.run && result.run.evidenceStatus ? result.run.evidenceStatus : null,
    // Ask the queue to run this step again when the post-event window opens or completes.
    rescheduleAt: result.rescheduleAt || null,
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
    provider: "open-meteo",
    observedAt: new Date(),
    evaluationVersion: "weather-archive-v1",
    metadata: { api: outcome.api || null, reason: outcome.reason || null, window: outcome.window || null },
    result: outcome.status === "AVAILABLE"
      ? { rainfallTotalMm: outcome.rainfallTotalMm, rainfallPeakMm: outcome.rainfallPeakMm, daysWithRain: outcome.daysWithRain, dailyMm: outcome.dailyMm, locationRounded: outcome.locationRounded }
      : { reason: outcome.reason },
  });
  return { status: outcome.status, reason: outcome.reason || null };
});

register("engine", async (job) => {
  const decision = await claimVerificationService.verifyClaim({ claimId: job.claimId, cognitoSub: job.cognitoSub });
  return { claimState: decision.claimState, held: Boolean(decision.held) };
});
