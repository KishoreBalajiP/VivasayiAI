import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A6) — POST /claims/:id/verify with automated verification ON. Ownership is checked
// before anything runs, and the endpoint never decides a claim while one of its blocking steps is
// still queued or running ("in progress" instead). Satellite never blocks (D1), under every policy:
// the policy in force is switched per test through the resolver every module reads.
const policyState = vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
  process.env.IMAGE_AI_MODE = "live";
  return { id: "v1.1-safe-ai" };
});
const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));
vi.mock("../config/verificationPolicy.js", async (importOriginal) => {
  const actual = await importOriginal();
  const resolvePolicy = (id = policyState.id) => actual.resolvePolicy(id);
  const assertPolicyConfigured = () => resolvePolicy();
  return { ...actual, resolvePolicy, assertPolicyConfigured, default: { ...actual.default, resolvePolicy, assertPolicyConfigured } };
});

import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationJob from "../models/VerificationJob.js";
import { countBlockingActiveJobs, ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { api, authHeader, startTestDatabase, stopTestDatabase } from "./helpers.js";
import { OBSERVATIONS, createClaim, fakeSupportingExecutors, modelAnswer, resetDatabase, seedFarmer, sideEffectSnapshot, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const DECISIONS = ["verified", "partially_verified", "rejected", "out_of_limit", "duplicate_area", "more_evidence_required"];
const verify = (user, claimId) => api().post(`/claims/${claimId}/verify`).set(authHeader(user)).send({});
const submittedClaim = async (label) => {
  const farmer = await seedFarmer(label);
  const claimId = await createClaim(farmer);
  await uploadPhoto(farmer.user, claimId);
  await submitClaim(farmer.user, claimId);
  return { ...farmer, claimId };
};
// Every planned job finished except those named, which are queued for later.
const onlyQueued = async (claimId, steps, runAt = new Date(Date.now() + 21 * 86400000)) => {
  await VerificationJob.updateMany(
    { claimId, step: { $nin: steps } },
    { $set: { status: "succeeded", completedAt: new Date(), leaseOwner: null, leaseUntil: null }, $unset: { activeKey: "" } }
  );
  await VerificationJob.updateMany({ claimId, step: { $in: steps } }, { $set: { status: "queued", runAt } });
};

describe("POST /claims/:id/verify with the durable queue (ADR-022)", () => {
  let mongo;
  const calls = [];
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    fakeSupportingExecutors(calls);
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    calls.length = 0;
    vi.restoreAllMocks();
    policyState.id = "v1.1-safe-ai";
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
  });

  it("VF-1: another user's verify call is a 404 that runs nothing: attempts, runAt and the claim are unchanged", async () => {
    const owner = await submittedClaim("vf1");
    const intruder = await seedFarmer("vf1-x");
    const before = await sideEffectSnapshot(owner.claimId);
    const response = await verify(intruder.user, owner.claimId);
    expect(response.status).toBe(404);
    expect(await sideEffectSnapshot(owner.claimId)).toEqual(before);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    // Before ADR-022 the drain ran first and spent the owner's provider calls for the intruder.
    expect((await VerificationJob.find({ claimId: owner.claimId }).lean()).every((job) => job.attempts === 0)).toBe(true);
  });

  it("VF-2: with the photo check still queued, verify answers in progress, decides nothing and writes no decision", async () => {
    const { user, claimId } = await submittedClaim("vf2");
    await onlyQueued(claimId, ["ai_assessment", "engine"], new Date(Date.now() + 60 * 60 * 1000));
    const response = await verify(user, claimId);
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Claim verification in progress");
    expect(response.body.data.verification).toMatchObject({ inProgress: true, claimState: "submitted", outcome: null });
    expect((await LossClaim.findById(claimId).lean()).state).toBe("submitted");
    expect(await ClaimAssessment.countDocuments({ claimId, state: { $ne: null } })).toBe(0);
    expect(await ClaimAudit.countDocuments({ claimId, action: { $in: DECISIONS } })).toBe(0);
    expect(mocks.generate).not.toHaveBeenCalled(); // the engine did not assess the photos itself either
  });

  it("VF-3: with only satellite queued (weeks away) under v1.1, verify decides", async () => {
    const { user, claimId } = await submittedClaim("vf3");
    await onlyQueued(claimId, ["satellite"]);
    const response = await verify(user, claimId);
    expect(response.status).toBe(200);
    expect(response.body.data.verification).toMatchObject({ inProgress: false, claimState: "verified", outcome: "verified" });
    expect((await VerificationJob.findOne({ claimId, step: "satellite" }).lean()).status).toBe("queued");
  });

  it("VF-4: satellite never blocks verify under any policy (v1-legacy, v2-components, v1.1-safe-ai)", async () => {
    for (const id of ["v1-legacy", "v2-components", "v1.1-safe-ai"]) {
      policyState.id = id;
      const { user, claimId } = await submittedClaim(`vf4-${id}`);
      await onlyQueued(claimId, ["satellite"]);
      expect(await countBlockingActiveJobs(claimId, resolvePolicy(id))).toBe(0);
      const response = await verify(user, claimId);
      expect(response.status).toBe(200);
      const verification = response.body.data.verification;
      expect(verification.inProgress, id).toBe(false);
      // Decided (or, under v2, held or sent back for evidence on its own components): never waiting for satellite.
      expect(DECISIONS.includes(verification.claimState) || verification.held, id).toBe(true);
      expect(verification.policyId).toBe(id);
      // A blocking step (weather) still makes the same call report progress.
      const other = await submittedClaim(`vf4b-${id}`);
      await onlyQueued(other.claimId, ["satellite", "weather"]);
      expect((await verify(other.user, other.claimId)).body.data.verification.inProgress, id).toBe(true);
    }
  });
});
