import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A6) — GET /claims/:id/progress, the farmer progress contract progress-v1, through the
// real API and queue. Automated verification and drain-on-read are ON (a read advances one step), the
// policy is v1.1-safe-ai, and the real photo check runs against a replaced model. Satellite and
// weather never leave the process (tests/fixtures/claimFlow.js).
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "true";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
});
const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));

import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import { ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import { buildFarmerProgress } from "../services/claimProgress.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { api, authHeader, startTestDatabase, stopTestDatabase } from "./helpers.js";
import {
  OBSERVATIONS,
  attachDocument,
  createClaim,
  fakeSupportingExecutors,
  modelAnswer,
  providerFailure,
  resetDatabase,
  runQueue,
  seedFarmer,
  sideEffectSnapshot,
  submitClaim,
  uploadPhoto,
} from "./fixtures/claimFlow.js";

const INTERNAL = ["PROVIDER_", "rv_", "lastError", "attempts", "automated_step_failed", "review_case", "errorCode", "policyHash", "deltaNdvi", "leaseOwner"];
const progressOf = async (user, claimId) => {
  const response = await api().get(`/claims/${claimId}/progress`).set(authHeader(user));
  expect(response.status).toBe(200);
  expect(response.body.message).toBe("Claim progress fetched");
  return response.body.data.progress;
};
const stage = (progress, id) => progress.stages.find((entry) => entry.id === id);
const expectNoInternals = (body) => {
  const text = JSON.stringify(body);
  for (const fragment of INTERNAL) expect(text, fragment).not.toContain(fragment);
};

// A submitted claim with one photo; its jobs are not run yet.
const submittedClaim = async (label, options = {}) => {
  const farmer = await seedFarmer(label);
  const claimId = await createClaim(farmer, options);
  await uploadPhoto(farmer.user, claimId);
  await submitClaim(farmer.user, claimId);
  return { ...farmer, claimId };
};
// Jobs a worker has not reached yet: nothing is due, so a read drains nothing.
const notDueYet = (claimId, ms = 60 * 60 * 1000) => VerificationJob.updateMany({ claimId, status: "queued" }, { $set: { runAt: new Date(Date.now() + ms) } });

describe("farmer progress contract (GET /claims/:id/progress)", () => {
  let mongo;
  const calls = [];
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    fakeSupportingExecutors(calls);
    setExecutor("land_documents", async () => ({ fake: "land_documents" }));
    setExecutor("official_land_record", async () => ({ fake: "official_land_record" }));
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    calls.length = 0;
    vi.restoreAllMocks();
    delete process.env.VERIFICATION_MAX_ATTEMPTS;
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
  });

  it("PRG-1: only the owner reads progress; anyone else gets 404 and nothing is drained or changed", async () => {
    const owner = await submittedClaim("prg1-owner");
    const intruder = await seedFarmer("prg1-intruder");
    const before = await sideEffectSnapshot(owner.claimId);

    const foreign = await api().get(`/claims/${owner.claimId}/progress`).set(authHeader(intruder.user));
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(owner.user);
    expect((await api().get(`/claims/${owner.claimId}/progress`)).status).toBe(401);
    expect((await api().get("/claims/not-an-id/progress").set(authHeader(owner.user))).status).toBe(400);

    // Due jobs existed, yet nothing ran: no attempt used, no model call, no executor, no write.
    expect(await sideEffectSnapshot(owner.claimId)).toEqual(before);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(calls).toEqual([]);

    // The owner's read does advance one step (drain-on-read).
    await progressOf(owner.user, owner.claimId);
    expect((await VerificationJob.find({ claimId: owner.claimId, status: "succeeded" }).lean()).length).toBe(1);
  });

  it("PRG-2: right after submit: received complete, the checks pending, and no internal code anywhere", async () => {
    const { user, claimId } = await submittedClaim("prg2");
    await notDueYet(claimId);
    const response = await api().get(`/claims/${claimId}/progress`).set(authHeader(user));
    expect(response.status).toBe(200);
    expectNoInternals(response.body);
    const progress = response.body.data.progress;
    expect(progress).toMatchObject({ contractVersion: "progress-v1", claimId, claimState: "submitted", overallStatus: "in_progress", decision: null, policyId: "v1.1-safe-ai" });
    expect(progress.stages.map((entry) => entry.id)).toEqual(["received", "photos", "land_documents", "weather", "area_checks", "decision"]);
    expect(stage(progress, "received")).toMatchObject({ status: "complete", explanationKey: "progress.received.complete" });
    expect(stage(progress, "photos")).toMatchObject({ status: "pending", explanationKey: "progress.photos.queued" });
    expect(stage(progress, "land_documents")).toMatchObject({ status: "not_applicable", explanationKey: "progress.land_documents.none_attached", blocking: false });
    expect(stage(progress, "weather")).toMatchObject({ status: "pending", explanationKey: "progress.weather.queued" });
    expect(stage(progress, "decision")).toMatchObject({ status: "pending", explanationKey: "progress.decision.waiting_for_checks" });
    expect(progress.satellite).toMatchObject({ status: "pending", reasonCode: "queued", supportingOnly: true });
    const claim = await LossClaim.findById(claimId).lean();
    expect(progress.submittedAt).toBe(claim.submittedAt.toISOString());
    expect(new Date(progress.lastUpdatedAt).getTime()).toBeGreaterThanOrEqual(claim.submittedAt.getTime());
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("PRG-3: a photo check retrying after a provider failure is `waiting` with nextCheckAt equal to the job's real runAt", async () => {
    const { user, claimId } = await submittedClaim("prg3");
    mocks.generate.mockRejectedValue(providerFailure(429));
    // The worker runs the photo check once; it fails and is rescheduled with backoff.
    await runQueue(claimId, { rounds: 1 }).catch(() => null);
    const aiJob = await VerificationJob.findOne({ claimId, step: "ai_assessment" }).lean();
    expect(aiJob).toMatchObject({ status: "queued", attempts: 1 });
    expect(aiJob.runAt.getTime()).toBeGreaterThan(Date.now());

    const progress = await progressOf(user, claimId);
    expect(stage(progress, "photos")).toMatchObject({ status: "waiting", explanationKey: "progress.photos.retrying_technical", nextCheckAt: aiJob.runAt.toISOString() });
    const blockingTimes = progress.stages.filter((entry) => entry.blocking && entry.nextCheckAt).map((entry) => entry.nextCheckAt).sort();
    expect(progress.nextCheckAt).toBe(blockingTimes[0]);
    expect(progress.overallStatus).toBe("in_progress");
    expectNoInternals(progress);
  });

  it("PRG-4: a dead photo job is failed_technical, and the engine's technical hold is waiting_for_review — never more evidence", async () => {
    process.env.VERIFICATION_MAX_ATTEMPTS = '{"ai_assessment":1}';
    const { user, claimId } = await submittedClaim("prg4");
    mocks.generate.mockRejectedValue(providerFailure(503));
    await runQueue(claimId);
    expect(await VerificationJob.findOne({ claimId, step: "ai_assessment" }).lean()).toMatchObject({ status: "dead" });
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(1);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("submitted");

    const response = await api().get(`/claims/${claimId}/progress`).set(authHeader(user));
    expectNoInternals(response.body);
    const progress = response.body.data.progress;
    expect(stage(progress, "photos")).toMatchObject({ status: "failed_technical", explanationKey: "progress.photos.technical_issue_reviewer" });
    expect(stage(progress, "decision")).toMatchObject({ status: "waiting", explanationKey: "progress.decision.technical_issue_reviewer", nextCheckAt: null });
    expect(progress).toMatchObject({ overallStatus: "waiting_for_review", decision: null, nextCheckAt: null });
    expect(progress.actionRequired.map((action) => action.code)).not.toContain("resubmit_with_evidence");
  });

  it("PRG-5: more evidence required is action_required with a resubmit action, and decision names the state", async () => {
    const { user, claimId } = await submittedClaim("prg5");
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.uncertain));
    await runQueue(claimId);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("more_evidence_required");

    const progress = await progressOf(user, claimId);
    expect(progress).toMatchObject({ overallStatus: "action_required", decision: "more_evidence_required", claimState: "more_evidence_required" });
    expect(stage(progress, "decision")).toMatchObject({ status: "blocked", explanationKey: "progress.decision.needs_more_evidence", actionRequired: { code: "resubmit_with_evidence", required: true } });
    expect(progress.actionRequired).toContainEqual({ code: "resubmit_with_evidence", stage: "decision", required: true, explanationKey: "action.resubmit_with_evidence", params: {} });
  });

  it("PRG-6: a decided claim shows the decision complete, decision = state, and no next check", async () => {
    const { user, claimId } = await submittedClaim("prg6");
    await runQueue(claimId);
    const claim = await LossClaim.findById(claimId).lean();
    expect(claim.state).toBe("verified");

    const progress = await progressOf(user, claimId);
    expect(progress).toMatchObject({ overallStatus: "decided", decision: "verified", nextCheckAt: null, actionRequired: [] });
    expect(stage(progress, "decision")).toMatchObject({ status: "complete", explanationKey: "progress.decision.complete", completedAt: claim.decidedAt.toISOString() });
    expect(stage(progress, "photos")).toMatchObject({ status: "complete", explanationKey: "progress.photos.complete" });
    expect(stage(progress, "area_checks")).toMatchObject({ status: "complete" });
    expect(stage(progress, "weather")).toMatchObject({ status: "complete", explanationKey: "progress.weather.complete" });
    // Imagery found but analysis off: never "passed".
    expect(progress.satellite).toMatchObject({ status: "unavailable", reasonCode: "analysis_not_enabled", supportingOnly: true });
    expect(new Date(progress.lastUpdatedAt).getTime()).toBeGreaterThanOrEqual(claim.decidedAt.getTime());
  });

  it("PRG-7: a tenant without a lease is asked for the missing categories — optional under v1.1, required under v2", async () => {
    const farmer = await seedFarmer("prg7");
    const claimId = await createClaim(farmer, { relationship: "tenant" });
    await uploadPhoto(farmer.user, claimId);
    await attachDocument(farmer.user, claimId, "ownership_deed");
    await submitClaim(farmer.user, claimId);
    await notDueYet(claimId);

    const progress = await progressOf(farmer.user, claimId);
    const groups = [["lease_agreement"], ["land_record", "ownership_deed", "tax_receipt"]].filter((group) => !group.includes("ownership_deed"));
    expect(progress.actionRequired).toContainEqual({
      code: "upload_land_documents",
      stage: "land_documents",
      required: false,
      explanationKey: "action.upload_land_documents",
      params: { categoryGroups: groups },
    });
    expect(stage(progress, "land_documents")).toMatchObject({ status: "pending", actionRequired: { code: "upload_land_documents", required: false } });

    // The same stored rows under the v2 policy (required claimant rights): the action is required.
    const claim = await LossClaim.findById(claimId).lean();
    const v2 = buildFarmerProgress({
      claim,
      assessment: await ClaimAssessment.findOne({ claimId }).lean(),
      jobs: await VerificationJob.find({ claimId }).lean(),
      evidenceRows: await VerificationEvidence.find({ claimId }).lean(),
      photos: { count: 1, version: null, latestAt: null },
      policy: resolvePolicy("v2-components"),
    });
    expect(v2.actionRequired.find((action) => action.code === "upload_land_documents")).toMatchObject({ required: true, params: { categoryGroups: groups } });
  });

  it("PRG-8: GET /verification carries the same progress object", async () => {
    const { user, claimId } = await submittedClaim("prg8");
    await runQueue(claimId);
    const progress = await progressOf(user, claimId);
    const verification = await api().get(`/claims/${claimId}/verification`).set(authHeader(user));
    expect(verification.status).toBe(200);
    expect(verification.body.data.progress).toEqual(progress);
    expect(Object.keys(verification.body.data).sort()).toEqual(["claim", "progress", "verification"]);
  });

  it("PRG-9: a withdrawn claim is overall withdrawn with satellite unavailable / claim_withdrawn", async () => {
    const { user, claimId } = await submittedClaim("prg9");
    expect((await api().post(`/claims/${claimId}/withdraw`).set(authHeader(user))).status).toBe(200);
    const progress = await progressOf(user, claimId);
    expect(progress).toMatchObject({ overallStatus: "withdrawn", decision: null, claimState: "withdrawn", nextCheckAt: null, actionRequired: [] });
    expect(progress.satellite).toMatchObject({ status: "unavailable", reasonCode: "claim_withdrawn" });
    expect(stage(progress, "received")).toMatchObject({ status: "complete" });
    for (const id of ["photos", "land_documents", "weather", "area_checks", "decision"]) expect(stage(progress, id).status).toBe("not_applicable");
    // The read ran nothing for a withdrawn claim (its queued jobs were cancelled).
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
