import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }));
vi.mock("../services/satellite/satelliteAdapter.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runSatelliteAnalysis: (...args) => mockRun(...args),
}));

import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { buildClaimWindows, runSatelliteVerificationForClaim } from "../services/satelliteVerification.service.js";
import { claimNext, enqueue, runJob } from "../services/verificationJobs.service.js";
import { api, authHeader, clearTestDatabase, seedProfile, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";

// Satellite evidence for a claim: pre/post windows from the policy, the claim polygon as the area of
// interest, append-only history, and rescheduling while the post-event window is still growing.

const DAY = 86400000;
const NOW = new Date("2026-10-10T06:00:00.000Z");
const POLICY = resolvePolicy("v1-legacy");
let seq = 0;

const fakeRun = (overrides = {}) => ({
  outcome: "ANALYSIS_COMPLETE",
  evidenceStatus: "AVAILABLE",
  processingStatus: "executed",
  provider: "cdse-sentinel",
  providerVersion: "13.3",
  observedAt: "2026-10-05T05:00:00Z",
  aoi: { fingerprint: "aoifingerprint0001" },
  analysis: { analysisOutcome: "SUPPORTS_LOSS", deltaNdvi: -0.3 },
  evidence: { evidenceVersion: "ev1", metadata: { adapterVersion: "13.3" }, result: { analysisOutcome: "SUPPORTS_LOSS", deltaNdvi: -0.3 } },
  scenes: ["internal"],
  ...overrides,
});

const seedClaim = async (label, daysAgo = 15) => {
  const user = `sat-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "F", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api().post("/claims").set(authHeader(user)).send({
    parcelId: parcel.body.data.parcel.parcelId, eventType: "flood", eventDate: new Date(Date.now() - daysAgo * DAY).toISOString(),
    geometry: squareGeometry(0.009), idempotencyKey: `idem-sat-${seq}`,
  });
  expect(created.status).toBe(200);
  const claim = await LossClaim.findById(created.body.data.claim.id);
  return { user, claim, claimId: String(claim._id) };
};

describe("claim satellite windows", () => {
  it("SV-1: windows come from the policy and the post window never reaches into the future", () => {
    const event = new Date("2026-09-25T00:00:00Z");
    const w = buildClaimWindows({ eventDate: event, policy: POLICY, now: NOW });
    expect(w.preWindow).toEqual({ start: "2026-08-16T00:00:00.000Z", end: "2026-09-20T00:00:00.000Z" });
    expect(w.postWindow.start).toBe("2026-09-26T00:00:00.000Z");
    expect(w.postWindow.end).toBe("2026-10-10T00:00:00.000Z"); // clamped to today, not event+20d
    expect(w.postWindowOpen).toBe(true);
    expect(w.postWindowComplete).toBe(false);
  });

  it("SV-2: an old event has a complete post window; an event today has none yet", () => {
    const old = buildClaimWindows({ eventDate: new Date("2026-08-01T00:00:00Z"), policy: POLICY, now: NOW });
    expect(old.postWindowComplete).toBe(true);
    expect(old.postWindow.end).toBe("2026-08-21T00:00:00.000Z");
    const today = buildClaimWindows({ eventDate: new Date("2026-10-10T00:00:00Z"), policy: POLICY, now: NOW });
    expect(today.postWindowOpen).toBe(false);
    expect(today.reopensAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe("runSatelliteVerificationForClaim", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); await VerificationJob.init(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [LossClaim, VerificationEvidence, VerificationJob]) await model.deleteMany({});
    mockRun.mockReset();
    mockRun.mockResolvedValue(fakeRun());
  });

  it("SV-3: analyses the CLAIM polygon over pre and post windows and records component evidence", async () => {
    const { user, claim, claimId } = await seedClaim("polygon");
    const result = await runSatelliteVerificationForClaim({ claimId, cognitoSub: user, claim, now: new Date() });
    expect(result.recorded).toBe(true);

    const args = mockRun.mock.calls[0][0];
    expect(args.aoi).toEqual(claim.claimedGeometry);
    expect(args.preWindow).toBeTruthy();
    expect(args.postWindow).toBeTruthy();
    expect(args.window).toBeUndefined();
    expect(args.requestProcessing).toBe(true);

    const row = await VerificationEvidence.findOne({ claimId, component: "satellite" });
    expect(row.source).toBe("SATELLITE");
    expect(row.status).toBe("AVAILABLE");
    expect(row.result.analysisOutcome).toBe("SUPPORTS_LOSS");
    expect(row.idempotencyKey.startsWith("sat2_")).toBe(true);
  });

  it("SV-4: the same inputs are idempotent, but enabling processing later records a NEW row (history kept)", async () => {
    const { user, claim, claimId } = await seedClaim("history");
    mockRun.mockResolvedValue(fakeRun({ evidenceStatus: "NOT_CHECKED", processingStatus: "disabled", evidence: { evidenceVersion: "e0", metadata: {}, result: { quality: "unavailable", analyzed: false } } }));
    const first = await runSatelliteVerificationForClaim({ claimId, cognitoSub: user, claim });
    const again = await runSatelliteVerificationForClaim({ claimId, cognitoSub: user, claim });
    expect(again.persisted.idempotent).toBe(true);
    expect(await VerificationEvidence.countDocuments({ claimId, component: "satellite" })).toBe(1);

    mockRun.mockResolvedValue(fakeRun());
    const enabled = await runSatelliteVerificationForClaim({ claimId, cognitoSub: user, claim });
    expect(enabled.persisted.idempotent).toBe(false);
    const rows = await VerificationEvidence.find({ claimId, component: "satellite" }).sort({ createdAt: 1 });
    expect(rows.map((row) => row.status)).toEqual(["NOT_CHECKED", "AVAILABLE"]);
    expect(String(rows[1].supersedes)).toBe(String(first.persisted.evidence.id));
  });

  it("SV-5: an event whose post window has not opened records nothing and says when to retry", async () => {
    const { user, claim, claimId } = await seedClaim("today", 0);
    const result = await runSatelliteVerificationForClaim({ claimId, cognitoSub: user, claim, now: new Date() });
    expect(result).toMatchObject({ recorded: false, skipped: "post_window_not_open" });
    expect(result.rescheduleAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockRun).not.toHaveBeenCalled();
    expect(await VerificationEvidence.countDocuments({ claimId })).toBe(0);
  });

  it("SV-6: while the post window is still growing the queue runs the step again later, without using an attempt", async () => {
    const { user, claim, claimId } = await seedClaim("grow", 3);
    const { job } = await enqueue({ claimId: claim._id, cognitoSub: user, step: "satellite" });
    const now = new Date();
    const claimed = await claimNext({ claimId, now, owner: "w" });
    const outcome = await runJob(claimed, { now });
    expect(outcome.error ?? null).toBeNull();
    expect(outcome.outcome).toBe("rescheduled");
    const stored = await VerificationJob.findById(job._id);
    expect(stored.status).toBe("queued");
    expect(stored.attempts).toBe(0);
    expect(stored.runAt.getTime()).toBeGreaterThan(now.getTime() + 10 * DAY);
  });

  it("SV-7: an old event completes in one run and is not rescheduled", async () => {
    const { user, claim, claimId } = await seedClaim("old", 28);
    const { job } = await enqueue({ claimId: claim._id, cognitoSub: user, step: "satellite" });
    const now = new Date();
    const claimed = await claimNext({ claimId, now, owner: "w" });
    expect((await runJob(claimed, { now })).outcome).toBe("succeeded");
    expect((await VerificationJob.findById(job._id)).status).toBe("succeeded");
  });

  it("SV-8: the farmer endpoint returns an evidence summary, not scenes or provider internals, and is owner-scoped", async () => {
    const { user, claimId } = await seedClaim("endpoint");
    const ok = await api().post(`/claims/${claimId}/verification/satellite`).set(authHeader(user));
    expect(ok.status).toBe(200);
    expect(ok.body.data.recorded).toBe(true);
    expect(ok.body.data.analysisOutcome).toBe("SUPPORTS_LOSS");
    const text = JSON.stringify(ok.body);
    expect(text).not.toContain("scenes");
    expect(text).not.toContain("requestShape");
    expect((await api().post(`/claims/${claimId}/verification/satellite`).set(authHeader("someone-else"))).status).toBe(404);
  });
});
