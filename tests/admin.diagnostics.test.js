import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A6, owner decision D9) — the reviewer's side of automated verification:
// GET /admin/claims/:id/verification-diagnostics (read-only) and POST /admin/claims/:id/jobs/requeue
// (the one recovery action, immutably recorded as AdminAction `jobs_requeued` + ClaimAudit).
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
  process.env.VERIFICATION_MAX_ATTEMPTS = '{"ai_assessment":1}';
});
const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));

import LossClaim from "../models/LossClaim.js";
import AdminAction from "../models/AdminAction.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import { recordEvidenceRun } from "../services/verificationEvidence.service.js";
import { adminHeader, api, authHeader, startTestDatabase, stopTestDatabase } from "./helpers.js";
import {
  OBSERVATIONS,
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

const ADMIN = "diag-admin-1";
const diagnostics = (claimId, headers = adminHeader(ADMIN)) => api().get(`/admin/claims/${claimId}/verification-diagnostics`).set(headers);
const requeue = (claimId, body, headers = adminHeader(ADMIN)) => api().post(`/admin/claims/${claimId}/jobs/requeue`).set(headers).send(body);

// A submitted claim whose photo check died (provider 503, one attempt), held by the engine.
const heldAfterDeadPhotoCheck = async (label) => {
  const farmer = await seedFarmer(label);
  const claimId = await createClaim(farmer);
  await uploadPhoto(farmer.user, claimId);
  await submitClaim(farmer.user, claimId);
  mocks.generate.mockRejectedValue(providerFailure(503));
  await runQueue(claimId);
  expect(await VerificationJob.findOne({ claimId, step: "ai_assessment" }).lean()).toMatchObject({ status: "dead" });
  return { ...farmer, claimId };
};

describe("admin verification diagnostics and requeue (AD)", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    fakeSupportingExecutors();
    // An analysed satellite run (the reviewer sees its NDVI change; the farmer never does).
    setExecutor("satellite", async (job) => {
      await recordEvidenceRun({
        claimId: job.claimId, cognitoSub: job.cognitoSub, component: "satellite", keyPrefix: "sat2", inputFingerprint: `sat-${String(job.claimId)}`,
        source: "SATELLITE", status: "AVAILABLE", provider: "cdse-sentinel", evaluationVersion: "satellite-adapter-ndvi-v2",
        metadata: { outcome: "ANALYSIS_COMPLETE", processingStatus: "executed", analysisExecuted: true, sceneCount: 4 },
        result: { quality: "good", analyzed: true, analysisOutcome: "SUPPORTS_LOSS", deltaNdvi: -0.31, before: { series: [{ date: "2026-09-20", ndvi: 0.7 }] }, after: { series: [{ date: "2026-10-15", ndvi: 0.39 }] } },
      });
      return { recorded: true };
    });
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
  });

  it("AD-1: a farmer (even the claim's owner) gets 403 and an anonymous caller 401, with no side effect; unknown and malformed ids are 404 / 400", async () => {
    const { user, claimId } = await heldAfterDeadPhotoCheck("ad1");
    const before = await sideEffectSnapshot(claimId);
    expect((await diagnostics(claimId, authHeader(user))).status).toBe(403);
    expect((await requeue(claimId, { reason: "please retry my claim now" }, authHeader(user))).status).toBe(403);
    expect((await api().get(`/admin/claims/${claimId}/verification-diagnostics`)).status).toBe(401);
    expect((await api().post(`/admin/claims/${claimId}/jobs/requeue`).send({ reason: "please retry my claim now" })).status).toBe(401);
    expect(await sideEffectSnapshot(claimId)).toEqual(before);

    expect((await diagnostics("000000000000000000000000")).status).toBe(404);
    expect((await diagnostics("not-an-id")).status).toBe(400);
    expect((await requeue("000000000000000000000000", { reason: "the quota was raised today" })).status).toBe(404);
  });

  it("AD-2: an admin sees jobs with attempts, error codes and attempt log, review cases, satellite internals, the audit trail and the farmer's progress", async () => {
    const { user, claimId } = await heldAfterDeadPhotoCheck("ad2");
    const response = await diagnostics(claimId);
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Verification diagnostics fetched");
    const data = response.body.data;
    expect(data).toMatchObject({ claimId, claimState: "submitted", submissionRound: 1 });
    expect(data.policy.configured.id).toBe("v1.1-safe-ai");
    expect(data.policy.configured.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.policy.decidedUnder).toMatchObject({ id: "v1.1-safe-ai" });

    const ai = data.jobs.find((job) => job.step === "ai_assessment");
    expect(ai).toMatchObject({ status: "dead", attempts: 1, maxAttempts: 1, planKey: "r1", lastError: { code: "PROVIDER_OVERLOAD", kind: "overload", retryable: true } });
    expect(ai.attemptLog).toEqual([expect.objectContaining({ attempt: 1, outcome: "dead", code: "PROVIDER_OVERLOAD", kind: "overload" })]);
    expect(ai.deadAt).toBeTruthy();
    expect(data.jobs.map((job) => job.step).sort()).toEqual(["ai_assessment", "engine", "satellite", "weather"]);

    expect(data.reviewCases).toHaveLength(1);
    expect(data.reviewCases[0]).toMatchObject({ source: "AI_IMAGE", failedStep: "ai_assessment", errorKind: "overload", status: "PENDING" });
    expect(data.evidence.some((row) => row.kind === "review_case" && row.idempotencyKey.startsWith("rv_"))).toBe(true);
    expect(data.assessment).toMatchObject({ status: "failed", verification: expect.objectContaining({ status: "held" }) });
    expect(data.assessment.hold.blocking[0].reasonCodes).toContain("ai_assessment_unavailable");

    expect(data.satellite).toMatchObject({ status: "passed", reasonCode: "vegetation_drop_consistent_with_damage", supportingOnly: true });
    expect(data.satellite.internals).toMatchObject({ adapterOutcome: "ANALYSIS_COMPLETE", processingStatus: "executed", analysisOutcome: "SUPPORTS_LOSS", deltaNdvi: -0.31, sceneCount: 4 });
    expect(data.audit.map((row) => row.action)).toEqual(expect.arrayContaining(["submitted", "review_required", "verification_held"]));

    // Side by side: exactly what the farmer is told.
    const farmer = await api().get(`/claims/${claimId}/progress`).set(authHeader(user));
    expect(data.progress).toEqual(farmer.body.data.progress);
    expect(JSON.stringify(farmer.body)).not.toContain("deltaNdvi");
  });

  it("AD-3: requeue replaces the dead job and queues the engine, is recorded once, and is idempotent while the new job is active", async () => {
    const { claimId } = await heldAfterDeadPhotoCheck("ad3");
    // Validation: a reason is mandatory, steps come from the fixed vocabulary.
    expect((await requeue(claimId, {})).status).toBe(400);
    expect((await requeue(claimId, { reason: "short" })).status).toBe(400);
    expect((await requeue(claimId, { reason: "the quota was raised today", steps: ["photos"] })).status).toBe(400);
    expect((await requeue(claimId, { reason: "the quota was raised today", extra: true })).status).toBe(400);
    expect(await AdminAction.countDocuments({ claimId })).toBe(0);

    const first = await requeue(claimId, { reason: "the billed Gemini key is live now", steps: ["ai_assessment"] });
    expect(first.status).toBe(200);
    expect(first.body.message).toBe("Verification jobs re-queued");
    expect(first.body.data).toMatchObject({ requeued: 1, engineQueued: 1, idempotent: false });
    const dead = await VerificationJob.findOne({ claimId, step: "ai_assessment", status: "dead" }).lean();
    expect(dead.requeuedAt).toBeTruthy();
    const fresh = await VerificationJob.findOne({ claimId, step: "ai_assessment", status: "queued" }).lean();
    expect(fresh).toMatchObject({ recoveryRound: 1, attempts: 0 });
    expect(String(fresh.recoveredFrom)).toBe(String(dead._id));
    expect(await VerificationJob.countDocuments({ claimId, step: "engine", status: "queued" })).toBe(1);

    const actions = await AdminAction.find({ claimId }).lean();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: "jobs_requeued", actorSub: ADMIN, priorState: "submitted", targetState: "submitted", reason: "the billed Gemini key is live now" });
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_jobs_requeued", actor: "admin" })).toBe(1);

    // Repeating it while the new job is active changes and records nothing.
    const again = await requeue(claimId, { reason: "the billed Gemini key is live now" });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ requeued: 0, idempotent: true });
    expect(await AdminAction.countDocuments({ claimId })).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId, step: "ai_assessment" })).toBe(2);

    // The re-queued check succeeds and the claim is decided.
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
    await runQueue(claimId);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");

    // Only a claim still waiting for its decision can have jobs re-queued.
    expect((await requeue(claimId, { reason: "the billed Gemini key is live now" })).status).toBe(409);
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(1);
  });
  it("AD-4: the requeue is recorded before any job changes: a failed AdminAction write re-queues nothing; a failed audit write after the re-queue still leaves the AdminAction record", async () => {
    const { claimId } = await heldAfterDeadPhotoCheck("ad4");
    const dead = await VerificationJob.findOne({ claimId, step: "ai_assessment", status: "dead" }).lean();
    const jobsBefore = await VerificationJob.countDocuments({ claimId });

    // (a) The AdminAction cannot be written: 500, and nothing was re-queued or recorded.
    const createAction = vi.spyOn(AdminAction, "create").mockRejectedValueOnce(new Error("write concern failed"));
    const failed = await requeue(claimId, { reason: "the billed Gemini key is live now" });
    expect(failed.status).toBe(500);
    expect(createAction).toHaveBeenCalledTimes(1);
    createAction.mockRestore();
    expect((await VerificationJob.findById(dead._id).lean()).requeuedAt).toBeNull();
    expect(await VerificationJob.countDocuments({ claimId })).toBe(jobsBefore);
    expect(await AdminAction.countDocuments({ claimId })).toBe(0);
    expect(await ClaimAudit.countDocuments({ claimId, action: /verification_jobs_requeue/ })).toBe(0);

    // (b) The ClaimAudit write fails AFTER the re-queue: the jobs are re-queued and the AdminAction,
    // written first, records the action and the dead job it replaced.
    const originalCreate = ClaimAudit.create.bind(ClaimAudit);
    const createAudit = vi.spyOn(ClaimAudit, "create").mockImplementation((doc, ...rest) =>
      doc && doc.action === "verification_jobs_requeued" ? Promise.reject(new Error("audit write failed")) : originalCreate(doc, ...rest)
    );
    const partial = await requeue(claimId, { reason: "the billed Gemini key is live now" });
    createAudit.mockRestore();
    expect(partial.status).toBe(200);
    expect(partial.body.data).toMatchObject({ requeued: 1, engineQueued: 1, idempotent: false, auditRecorded: false });
    expect((await VerificationJob.findById(dead._id).lean()).requeuedAt).toBeTruthy();
    const [action] = await AdminAction.find({ claimId }).lean();
    expect(action).toMatchObject({ action: "jobs_requeued", metadata: { steps: ["ai_assessment"], planned: [{ step: "ai_assessment", recoveredFrom: String(dead._id), recoveryRound: 1 }] } });
    expect(await ClaimAudit.countDocuments({ claimId, action: "verification_jobs_requeued" })).toBe(0);

    // (c) The re-queue itself fails after the record: a failure audit row names the AdminAction.
    await runQueue(claimId); // the re-queued check dies again (503), so there is a dead job to retry
    const queue = vi.spyOn(VerificationJob, "updateOne").mockRejectedValueOnce(Object.assign(new Error("primary stepped down"), { code: "PRIMARY_STEPPED_DOWN" }));
    const broken = await requeue(claimId, { reason: "retry after the provider outage" });
    queue.mockRestore();
    expect(broken.status).toBe(500);
    const failure = await ClaimAudit.findOne({ claimId, action: "verification_jobs_requeue_failed" }).lean();
    expect(failure).toBeTruthy();
    const actions = await AdminAction.find({ claimId }).sort({ createdAt: 1 }).lean();
    expect(actions).toHaveLength(2);
    expect(failure.metadata.adminActionId).toBe(String(actions[1]._id));
  });
});
