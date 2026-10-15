import { createHash } from "node:crypto";
import * as satelliteAdapter from "./satellite/satelliteAdapter.js";
import { recordEvidenceRun } from "./verificationEvidence.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";

// Satellite verification for a claim: a pre-event versus post-event NDVI comparison over the claim's
// own polygon, recorded as append-only SUPPORTING evidence (never proof of cause, never a decision).
//
//   pre  window: [event - 40 d, event - 5 d]     (policy.satellite.preWindowDays)
//   post window: [event + 1 d, min(event + 20 d, today)]   (policy.satellite.postWindowDays)
//
// The windows are provisional tuning values, not calibrated per crop or event type. When the post
// window has not opened yet (the event was today) nothing is recorded: a result with no
// post-event observation would be noise. The caller is told when to try again.

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (value) => {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const iso = (ms) => new Date(ms).toISOString();

export const buildClaimWindows = ({ eventDate, policy = resolvePolicy(), now = new Date() }) => {
  const event = startOfDay(eventDate);
  const today = startOfDay(now);
  const [preFar, preNear] = policy.satellite.preWindowDays;
  const [postNear, postFar] = policy.satellite.postWindowDays;
  const preWindow = { start: iso(event - preFar * DAY_MS), end: iso(event - preNear * DAY_MS) };
  const postStart = event + postNear * DAY_MS;
  const postEnd = Math.min(event + postFar * DAY_MS, today);
  return {
    preWindow,
    postWindow: { start: iso(postStart), end: iso(postEnd) },
    postWindowOpen: postStart <= postEnd,
    postWindowComplete: event + postFar * DAY_MS <= today,
    reopensAt: postStart > today ? new Date(postStart + DAY_MS) : null,
  };
};

export const runSatelliteVerificationForClaim = async ({ claimId, cognitoSub, claim, now = new Date() } = {}) => {
  const windows = buildClaimWindows({ eventDate: claim.eventDate, now });
  if (!windows.postWindowOpen) {
    return { recorded: false, skipped: "post_window_not_open", rescheduleAt: windows.reopensAt };
  }

  // The area of interest is always the CLAIM polygon, so the manual endpoint and the queued step
  // analyse the same land.
  const run = await satelliteAdapter.runSatelliteAnalysis({
    aoi: claim.claimedGeometry,
    preWindow: windows.preWindow,
    postWindow: windows.postWindow,
    requestProcessing: true,
    correlationId: String(claimId),
    now,
  });

  const inputFingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        aoi: run.aoi && run.aoi.fingerprint,
        event: iso(startOfDay(claim.eventDate)),
        pre: [windows.preWindow.start, windows.preWindow.end],
        // Day granularity: a later run with a longer post window is a new observation.
        postEnd: windows.postWindow.end.slice(0, 10),
        processing: run.processingStatus || null,
        adapter: run.providerVersion || null,
      })
    )
    .digest("hex")
    .slice(0, 32);

  const persisted = await recordEvidenceRun({
    claimId,
    cognitoSub,
    component: "satellite",
    keyPrefix: "sat2",
    inputFingerprint,
    source: "SATELLITE",
    status: run.evidenceStatus || "UNAVAILABLE",
    confidence: null,
    observedAt: run.observedAt ? new Date(run.observedAt) : null,
    provider: run.provider || null,
    providerVersion: run.providerVersion || null,
    evidenceVersion: run.evidence ? run.evidence.evidenceVersion : null,
    evaluationVersion: "satellite-adapter-ndvi-v2",
    reference: run.aoi && run.aoi.fingerprint ? run.aoi.fingerprint : null,
    metadata: (run.evidence && run.evidence.metadata) || {},
    result: (run.evidence && run.evidence.result) || null,
  });

  return {
    recorded: true,
    run,
    persisted,
    // While the post window is still growing, ask to be run again once it completes.
    rescheduleAt: windows.postWindowComplete ? null : new Date(startOfDay(claim.eventDate) + (resolvePolicy().satellite.postWindowDays[1] + 1) * DAY_MS),
  };
};

export default { runSatelliteVerificationForClaim, buildClaimWindows };
