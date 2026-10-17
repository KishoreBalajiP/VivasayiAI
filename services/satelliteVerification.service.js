import { createHash } from "node:crypto";
import * as satelliteAdapter from "./satellite/satelliteAdapter.js";
import { recordEvidenceRun } from "./verificationEvidence.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { satelliteMode } from "../config/env.js";
import { resolveSatelliteConfig } from "./satellite/config.js";
import {
  MOCK_SATELLITE_PROVIDER_LABEL,
  mockSatelliteOutcome,
  mockSatelliteConfig,
  createMockSatelliteTransport,
} from "./satellite/mockProvider.js";

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

  // ADR-024 (plan A8) dev/e2e seam, read on every run: SATELLITE_MODE=off runs the adapter switched
  // off (CONFIG_DISABLED, exactly as SATELLITE_ENABLED=false); SATELLITE_MODE=mock runs the REAL adapter
  // against an in-process stand-in provider (services/satellite/mockProvider.js) that answers as
  // SATELLITE_MOCK_OUTCOME says. Either way the run is recorded below like any other. Never in
  // production (assertProductionSafety refuses SATELLITE_MODE=mock there).
  const mode = satelliteMode();
  const seam =
    mode === "off"
      ? { config: { ...resolveSatelliteConfig({}), enabled: false } }
      : mode === "mock"
        ? (() => {
            const outcome = mockSatelliteOutcome();
            return {
              config: mockSatelliteConfig(outcome),
              transport: createMockSatelliteTransport({ outcome, preWindow: windows.preWindow, postWindow: windows.postWindow }),
              provider: MOCK_SATELLITE_PROVIDER_LABEL,
            };
          })()
        : null;

  // The area of interest is always the CLAIM polygon, so the manual endpoint and the queued step
  // analyse the same land.
  const run = await satelliteAdapter.runSatelliteAnalysis({
    aoi: claim.claimedGeometry,
    preWindow: windows.preWindow,
    postWindow: windows.postWindow,
    requestProcessing: true,
    correlationId: String(claimId),
    now,
    ...(seam ? { config: seam.config } : {}),
    ...(seam && seam.transport ? { transport: seam.transport } : {}),
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
    // A stand-in run names itself (and says so in its metadata), so it is never mistaken for imagery.
    provider: (seam && seam.provider) || run.provider || null,
    providerVersion: run.providerVersion || null,
    evidenceVersion: run.evidence ? run.evidence.evidenceVersion : null,
    evaluationVersion: "satellite-adapter-ndvi-v2",
    reference: run.aoi && run.aoi.fingerprint ? run.aoi.fingerprint : null,
    metadata: { ...((run.evidence && run.evidence.metadata) || {}), ...(seam && seam.provider ? { simulated: true } : {}) },
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
