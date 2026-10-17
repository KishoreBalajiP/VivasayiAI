import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Concurrent verification (plan A11, CV-1..3). Automated verification and drain-on-read are ON, the
// policy is v1.1-safe-ai, and the real queue, photo check and engine run with the Gemini model,
// Chroma and Cohere replaced. Satellite and weather never leave the process. Whatever runs at the
// same time — workers, the verify call, status reads, resubmits — a claim gets ONE decision per round.
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
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { putObject } from "../services/s3.service.js";
import { claimNext, drain, enqueue, ensureDefaultExecutors, runJob, setExecutor } from "../services/verificationJobs.service.js";
import { api, authHeader, clearTestDatabase, seedProfile, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const CLEAR = {
  cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate",
  visibleAffectedPortion: "lower portion of the visible field shows standing water", confidence: "high", uncertain: false,
  inconsistencies: [], observations: ["standing water in the furrows"], imageQuality: "good",
};
const UNSURE = { ...CLEAR, damageDetected: null, damageType: null, severity: null, confidence: "unclear", uncertain: true, imageQuality: "poor" };
const answer = (observation) => ({ generations: [[{ text: JSON.stringify(observation) }]] });
const DAY_MS = 86400000;

let seq = 0;
const uploadPhoto = async (user, claimId) => {
  const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const evidence = await ClaimEvidence.findOne({ uploadId });
  await putObject({ key: evidence.s3Key, buffer: PNG, mediaType: "image/png" });
  expect((await api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);
};
const seedSubmitted = async (label) => {
  const user = `cv-${label}-${(++seq).toString(36)}`;
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "Field", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({ parcelId: parcel.body.data.parcel.parcelId, eventType: "flood", eventDate: new Date(Date.now() - 2 * DAY_MS).toISOString(), geometry: squareGeometry(0.009), idempotencyKey: `idem-cv-${seq}` });
  const claimId = created.body.data.claim.id;
  await uploadPhoto(user, claimId);
  expect((await api().post(`/claims/${claimId}/submit`).set(authHeader(user))).status).toBe(200);
  return { user, claimId };
};

// Run the claim's queue the way the worker would, moving a clock forward so waits become due.
const settle = async (claimId) => {
  let clock = Date.now();
  for (let i = 0; i < 20; i += 1) {
    clock += 10 * 60 * 1000;
    await drain({ claimId, now: () => new Date(clock) });
    if ((await VerificationJob.countDocuments({ claimId, status: { $in: ["queued", "running"] } })) === 0) return;
  }
  throw new Error("queue did not settle");
};
const audits = (claimId, action) => ClaimAudit.countDocuments({ claimId, action });

describe("concurrent verification (CV)", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    for (const step of ["satellite", "weather"]) setExecutor(step, async () => ({ fake: step }));
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await clearTestDatabase();
    for (const model of [LossClaim, ClaimEvidence, ClaimAssessment, ClaimAudit, VerificationEvidence, VerificationJob]) await model.deleteMany({});
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(answer(CLEAR));
  });

  it("CV-1: two workers, the verify call and a status read at once — one photo check, one decision, one audit row", async () => {
    const { user, claimId } = await seedSubmitted("burst");
    const [, , verify, read] = await Promise.all([
      drain({ claimId }),
      drain({ claimId }),
      api().post(`/claims/${claimId}/verify`).set(authHeader(user)).send({}),
      api().get(`/claims/${claimId}/verification`).set(authHeader(user)),
    ]);
    expect(verify.status).toBe(200);
    expect(read.status).toBe(200);
    await settle(claimId);

    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    expect(await audits(claimId, "verification_started")).toBe(1);
    expect(await audits(claimId, "verified")).toBe(1);
    expect(await audits(claimId, "ai_completed")).toBe(1);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(await ClaimAssessment.countDocuments({ claimId })).toBe(1);
    expect(await ClaimAssessment.findOne({ claimId }).lean()).toMatchObject({ state: "verified", decidedBy: "engine", status: "completed" });
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(0);

    // The same burst again changes nothing.
    await Promise.all([
      drain({ claimId }),
      api().post(`/claims/${claimId}/verify`).set(authHeader(user)).send({}),
      api().get(`/claims/${claimId}/verification`).set(authHeader(user)),
      enqueue({ claimId, cognitoSub: user, step: "engine" }).then(() => drain({ claimId })),
    ]);
    expect(await audits(claimId, "verified")).toBe(1);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("CV-2: a resubmit (pressed twice) racing a worker and the verify call — one resubmission, one decision for the new round", async () => {
    mocks.generate.mockResolvedValue(answer(UNSURE));
    const { user, claimId } = await seedSubmitted("resubmit");
    await settle(claimId);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("more_evidence_required");

    // The farmer adds a clear photo and resubmits; every photo now reads clearly.
    mocks.generate.mockResolvedValue(answer(CLEAR));
    await uploadPhoto(user, claimId);
    const [first, second, , verify] = await Promise.all([
      api().post(`/claims/${claimId}/resubmit`).set(authHeader(user)),
      api().post(`/claims/${claimId}/resubmit`).set(authHeader(user)),
      drain({ claimId }),
      api().post(`/claims/${claimId}/verify`).set(authHeader(user)).send({}),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.message, second.body.message].sort()).toEqual(["Claim already resubmitted", "Claim resubmitted"]);
    expect(verify.status).toBe(200);
    await settle(claimId);

    const claim = await LossClaim.findById(claimId).lean();
    expect(claim).toMatchObject({ state: "verified", submissionRound: 2 });
    expect(await audits(claimId, "resubmitted")).toBe(1);
    expect(await audits(claimId, "more_evidence_required")).toBe(1); // round 1
    expect(await audits(claimId, "verified")).toBe(1); // round 2, once
    expect(await audits(claimId, "verification_started")).toBe(2);
    expect(await VerificationJob.countDocuments({ claimId, planKey: "r2" })).toBeGreaterThan(0);
    expect((await ClaimAssessment.findOne({ claimId }).lean()).state).toBe("verified");
  });

  it("CV-3: two workers on the same claim's engine, one taking over the other's lapsed lease — one decision", async () => {
    const { user, claimId } = await seedSubmitted("engine");
    await VerificationJob.deleteOne({ claimId, step: "engine" });
    await settle(claimId); // photo check, satellite and weather
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "engine" });

    // Worker A reads the claim and stalls before deciding; its lease lapses.
    const realFind = VerificationEvidence.find;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const stalled = new Promise((resolve) => { entered = resolve; });
    let blocked = false;
    const findSpy = vi.spyOn(VerificationEvidence, "find").mockImplementation((...args) => {
      const filter = args[0] || {};
      if (blocked || String(filter.claimId) !== claimId || Object.keys(filter).length !== 1) return realFind.apply(VerificationEvidence, args);
      blocked = true;
      return { lean: async () => { entered(); await gate; return realFind.apply(VerificationEvidence, args).lean(); } };
    });
    const t0 = new Date();
    const claimedByA = await claimNext({ claimId, now: t0, owner: "worker-a", leaseMs: 50 });
    const runA = runJob(claimedByA, { now: t0, leaseMs: 50, heartbeatMs: 60_000 });
    await stalled;

    // Worker B takes the lapsed job over and decides.
    const t1 = new Date(t0.getTime() + 1000);
    const claimedByB = await claimNext({ claimId, now: t1, owner: "worker-b" });
    expect(String(claimedByB._id)).toBe(String(job._id));
    expect(await runJob(claimedByB, { now: t1 })).toMatchObject({ outcome: "succeeded", summary: { claimState: "verified" } });

    // A wakes up: the claim is decided, so its run returns that decision and its stale write is refused.
    release();
    expect(await runA).toMatchObject({ outcome: "lease_lost" });
    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    expect(await audits(claimId, "verification_started")).toBe(1);
    expect(await audits(claimId, "verified")).toBe(1);
    expect(await VerificationJob.findById(job._id).lean()).toMatchObject({ status: "succeeded", attempts: 2, leaseOwner: null });

    // Two workers draining the same claim at the same moment: the engine still runs once.
    findSpy.mockRestore();
    const other = await seedSubmitted("engine-pair");
    await VerificationJob.deleteOne({ claimId: other.claimId, step: "engine" });
    await settle(other.claimId);
    await enqueue({ claimId: other.claimId, cognitoSub: other.user, step: "engine" });
    const results = (await Promise.all([drain({ claimId: other.claimId }), drain({ claimId: other.claimId })])).flat();
    expect(results.filter((result) => result.step === "engine" && result.outcome === "succeeded")).toHaveLength(1);
    expect(await audits(other.claimId, "verified")).toBe(1);
  });
});
