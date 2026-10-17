import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A5): durable, idempotent enqueue. Automated verification is ON in this suite (it is
// off everywhere else), so submit, resubmit, withdraw and late evidence build or cancel real job
// rows. The policy is v1.1-safe-ai; the real claim-vision and engine code runs with the Gemini model,
// Chroma and Cohere replaced. Satellite and weather never leave the process.
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
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
import ImageRecord from "../models/ImageRecord.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { putObject } from "../services/s3.service.js";
import { claimNext, drain, enqueue, ensureDefaultExecutors, ensurePlan, runJob, setExecutor } from "../services/verificationJobs.service.js";
import { PLAN_FAILED_MESSAGE } from "../services/claimVerificationPipeline.service.js";
import { computeEvidenceVersion } from "../services/claimAssessment.service.js";
import { verifyClaim } from "../services/claimVerification.service.js";
import { env } from "../config/env.js";
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
const answer = (observation) => ({ generations: [[{ text: JSON.stringify(observation) }]] });
const providerFailure = (status) => Object.assign(new Error(`[${status}] provider refused the call`), { status });
const LAND_RECORD = {
  documentType: "land_record", issuingAuthority: "Revenue Department", recordNumber: "R-77", state: "Tamil Nadu", district: "Thanjavur",
  taluk: "Papanasam", village: "Ammapettai", surveyNumber: "123/4A", subdivisionNumber: "2", holderNames: ["Murugan"],
  parcelExtent: 1.2, extentUnit: "acre", documentDate: "2024-03-01", additionalIdentifiers: [], unreadable: false, language: "ta",
  confidence: "high", imageQuality: "good", uncertainFields: [],
};
// The text part of a model call (`model.generate([[system, human]])`): tells a land-document
// examination from a photo check.
const promptOf = (args) => String(args?.[0]?.[0]?.[1]?.content?.[0]?.text || "");
const PLAN_STEPS = ["ai_assessment", "satellite", "weather", "engine"];
const DAY_MS = 86400000;

let seq = 0;
const nextUser = (label) => `eq-${label}-${(++seq).toString(36)}`;
const submit = (user, claimId, requestId = null) => {
  const request = api().post(`/claims/${claimId}/submit`).set(authHeader(user));
  return requestId ? request.set("x-request-id", requestId) : request;
};
const resubmit = (user, claimId, requestId = null) => {
  const request = api().post(`/claims/${claimId}/resubmit`).set(authHeader(user));
  return requestId ? request.set("x-request-id", requestId) : request;
};
const jobsOf = (claimId) => VerificationJob.find({ claimId }).sort({ createdAt: 1, _id: 1 }).lean();
const finishJobs = (claimId) =>
  VerificationJob.updateMany({ claimId, status: { $in: ["queued", "running"] } }, { $set: { status: "succeeded", leaseOwner: null, leaseUntil: null }, $unset: { activeKey: "" } });

const uploadPhoto = async (user, claimId, requestId = null) => {
  const presign = await api()
    .post(`/claims/${claimId}/evidence/presign`)
    .set(authHeader(user))
    .send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const evidence = await ClaimEvidence.findOne({ uploadId });
  await putObject({ key: evidence.s3Key, buffer: PNG, mediaType: "image/png" });
  const complete = () => {
    const request = api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));
    return requestId ? request.set("x-request-id", requestId) : request;
  };
  const completed = await complete();
  expect(completed.status).toBe(200);
  return { uploadId, complete };
};

// A stored photo with no late-evidence plan, as if the plan's enqueue had failed: only what the
// evidence API stores (the row and the object).
const storePhotoWithoutPlan = async (claimId) => {
  const uploadId = `img_00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const s3Key = `claims/${claimId}/${uploadId}/image.png`;
  await putObject({ key: s3Key, buffer: PNG, mediaType: "image/png" });
  await ClaimEvidence.create({ claimId, uploadId, s3Key, mediaType: "image/png", size: PNG.length, status: "stored", uploadedAt: new Date(), width: 1, height: 1 });
};

// Attach a stored private upload to the claim as a land document (the farmer's own API calls).
const attachDocument = async (user, claimId, requestId = null) => {
  const presign = await api().post("/upload/presign").set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "doc.png" });
  const { uploadId } = presign.body.data;
  await putObject({ key: (await ImageRecord.findOne({ uploadId })).s3Key, buffer: PNG, mediaType: "image/png" });
  await api().post(`/upload/${uploadId}/complete`).set(authHeader(user));
  const request = api().post(`/claims/${claimId}/ownership`).set(authHeader(user));
  const attached = await (requestId ? request.set("x-request-id", requestId) : request).send({ uploadId });
  expect(attached.status).toBe(200);
  return attached.body.data.evidence.id;
};

// Run the claim's queue the way a worker would, a minute of fake time per batch, until no job is
// queued or running. Returns every job outcome in the order the jobs ran.
const runQueue = async (claimId, rounds = 30) => {
  let clock = Date.now();
  const outcomes = [];
  for (let i = 0; i < rounds; i += 1) {
    outcomes.push(...(await drain({ claimId, now: () => new Date(clock), maxJobs: 10 })));
    if ((await VerificationJob.countDocuments({ claimId, status: { $in: ["queued", "running"] } })) === 0) return outcomes;
    clock += 60 * 1000;
  }
  throw new Error("queue did not settle");
};
const storedPhotoVersion = async (claimId) => computeEvidenceVersion(await ClaimEvidence.find({ claimId, status: "stored" }).lean());

const seedDraft = async (label, { photo = true } = {}) => {
  const user = nextUser(label);
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "Field", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api()
    .post("/claims")
    .set(authHeader(user))
    .send({ parcelId: parcel.body.data.parcel.parcelId, eventType: "flood", eventDate: new Date(Date.now() - 2 * DAY_MS).toISOString(), geometry: squareGeometry(0.009), idempotencyKey: `idem-eq-${seq}` });
  expect(created.status).toBe(200);
  const claimId = created.body.data.claim.id;
  if (photo) await uploadPhoto(user, claimId);
  return { user, claimId };
};

describe("durable, idempotent enqueue (ADR-022)", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    for (const step of ["satellite", "weather", "land_documents", "official_land_record"]) {
      setExecutor(step, async () => ({ fake: step }));
    }
    await ensureDefaultExecutors();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await clearTestDatabase();
    vi.restoreAllMocks();
    for (const model of [LossClaim, ClaimEvidence, ClaimAssessment, ClaimAudit, ImageRecord, VerificationEvidence, VerificationJob]) {
      await model.deleteMany({});
    }
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(answer(CLEAR));
  });

  it("EQ-1: the plan's job rows exist when the submit response arrives, carrying the request id, a correlation id and plan key r1", async () => {
    expect(env.claimAutomatedVerificationEnabled).toBe(true);
    const { user, claimId } = await seedDraft("eq1");
    expect(await VerificationJob.countDocuments({ claimId })).toBe(0); // a draft has no plan

    const response = await submit(user, claimId, "req-eq1-submit-0001");
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Claim submitted");
    expect(response.headers["x-request-id"]).toBe("req-eq1-submit-0001");

    // No drain, no wait: the rows were written inside the request.
    const jobs = await jobsOf(claimId);
    expect(jobs.map((job) => job.step)).toEqual(PLAN_STEPS);
    for (const job of jobs) {
      expect(job).toMatchObject({
        status: "queued",
        planKey: "r1",
        requestId: "req-eq1-submit-0001",
        correlationId: `clm_${claimId}_r1`,
        attempts: 0,
      });
    }
    const claim = await LossClaim.findById(claimId).lean();
    expect(claim).toMatchObject({ state: "submitted", submissionRound: 1 });
    expect(claim.firstSubmittedAt.getTime()).toBe(claim.submittedAt.getTime());
    const audit = await ClaimAudit.findOne({ claimId, action: "submitted" }).lean();
    expect(audit).toMatchObject({ requestId: "req-eq1-submit-0001", metadata: { submissionRound: 1 } });
  });

  it("EQ-2: ten concurrent submits move the claim once — one audit row, round 1, one job per planned step", async () => {
    const { user, claimId } = await seedDraft("eq2");
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(user, claimId, `req-eq2-burst-${String(i).padStart(4, "0")}`)));
    expect(responses.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(responses.filter((response) => response.body.message === "Claim submitted")).toHaveLength(1);
    expect(responses.filter((response) => response.body.message === "Claim already submitted")).toHaveLength(9);
    expect(await ClaimAudit.countDocuments({ claimId, action: "submitted" })).toBe(1);
    expect((await LossClaim.findById(claimId).lean()).submissionRound).toBe(1);
    const jobs = await jobsOf(claimId);
    expect(jobs.map((job) => job.step).sort()).toEqual([...PLAN_STEPS].sort());
    expect(new Set(jobs.map((job) => job.planKey))).toEqual(new Set(["r1"]));
  });

  it("EQ-3: a finished plan is never re-run — a repeated submit or ensurePlan creates no new job", async () => {
    const { user, claimId } = await seedDraft("eq3");
    expect((await submit(user, claimId)).status).toBe(200);
    await finishJobs(claimId);
    const before = await jobsOf(claimId);

    const again = await submit(user, claimId);
    expect(again.status).toBe(200);
    expect(again.body.message).toBe("Claim already submitted");
    expect(await ensurePlan({ claimId, cognitoSub: user })).toHaveLength(PLAN_STEPS.length);
    const after = await jobsOf(claimId);
    expect(after.map((job) => String(job._id))).toEqual(before.map((job) => String(job._id)));
    expect(after.every((job) => job.status === "succeeded")).toBe(true);
    expect(await ClaimAudit.countDocuments({ claimId, action: "submitted" })).toBe(1);

    // The same holds when the plan really ran (worker drain) and the claim is still being decided.
    const ran = await seedDraft("eq3-ran");
    expect((await submit(ran.user, ran.claimId)).status).toBe(200);
    await VerificationJob.deleteOne({ claimId: ran.claimId, step: "engine" });
    await drain({ claimId: ran.claimId });
    const settled = await jobsOf(ran.claimId);
    expect(settled.map((job) => job.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect((await submit(ran.user, ran.claimId)).status).toBe(200); // recovers only the missing engine
    const recovered = await jobsOf(ran.claimId);
    expect(recovered.map((job) => [job.step, job.status])).toEqual([
      ["ai_assessment", "succeeded"], ["satellite", "succeeded"], ["weather", "succeeded"], ["engine", "queued"],
    ]);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it("EQ-4: a plan that could not be written is a 503 with the claim saved; the repeated submit recovers the plan", async () => {
    const { user, claimId } = await seedDraft("eq4");
    const create = VerificationJob.create.bind(VerificationJob);
    const spy = vi.spyOn(VerificationJob, "create").mockImplementationOnce(async () => {
      throw new Error("write concern timeout");
    });
    const failed = await submit(user, claimId, "req-eq4-first-0001");
    expect(failed.status).toBe(503);
    expect(failed.body.message).toBe(PLAN_FAILED_MESSAGE);
    expect(JSON.stringify(failed.body)).not.toContain("write concern");
    spy.mockImplementation(create);

    // The claim itself is saved and submitted exactly once.
    expect((await LossClaim.findById(claimId).lean()).state).toBe("submitted");
    expect(await ClaimAudit.countDocuments({ claimId, action: "submitted" })).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId })).toBe(0);

    const retried = await submit(user, claimId, "req-eq4-retry-0001");
    expect(retried.status).toBe(200);
    expect(retried.body.message).toBe("Claim already submitted");
    const jobs = await jobsOf(claimId);
    expect(jobs.map((job) => job.step)).toEqual(PLAN_STEPS);
    expect(jobs.every((job) => job.planKey === "r1" && job.requestId === "req-eq4-retry-0001")).toBe(true);
    expect(await ClaimAudit.countDocuments({ claimId, action: "submitted" })).toBe(1);
  });

  it("EQ-5: a resubmit plans round 2 and keeps firstSubmittedAt; a resubmit that got a 503 is recovered by its retry, not refused", async () => {
    const { user, claimId } = await seedDraft("eq5");
    expect((await submit(user, claimId)).status).toBe(200);
    await finishJobs(claimId);
    const first = await LossClaim.findById(claimId).lean();
    await LossClaim.updateOne({ _id: claimId }, { $set: { state: "more_evidence_required", decidedAt: new Date() } });

    const create = VerificationJob.create.bind(VerificationJob);
    const spy = vi.spyOn(VerificationJob, "create").mockImplementationOnce(async () => {
      throw new Error("primary stepped down");
    });
    const failed = await resubmit(user, claimId, "req-eq5-first-0001");
    expect(failed.status).toBe(503);
    spy.mockImplementation(create);
    const between = await LossClaim.findById(claimId).lean();
    expect(between).toMatchObject({ state: "submitted", submissionRound: 2 });

    // The retry used to get a 409 (the claim is no longer more_evidence_required) and the plan was
    // lost for good. Now it is answered as idempotent and the round-2 plan is written.
    const retried = await resubmit(user, claimId, "req-eq5-retry-0001");
    expect(retried.status).toBe(200);
    expect(retried.body.message).toBe("Claim already resubmitted");
    const round2 = (await jobsOf(claimId)).filter((job) => job.planKey === "r2");
    expect(round2.map((job) => job.step)).toEqual(PLAN_STEPS);
    expect(round2.every((job) => job.correlationId === `clm_${claimId}_r2` && job.requestId === "req-eq5-retry-0001")).toBe(true);
    expect(await ClaimAudit.countDocuments({ claimId, action: "resubmitted" })).toBe(1);

    const after = await LossClaim.findById(claimId).lean();
    expect(after.firstSubmittedAt.getTime()).toBe(first.firstSubmittedAt.getTime());
    expect(after.submittedAt.getTime()).toBeGreaterThan(first.submittedAt.getTime());

    // A third press changes nothing.
    expect((await resubmit(user, claimId)).status).toBe(200);
    expect(await ClaimAudit.countDocuments({ claimId, action: "resubmitted" })).toBe(1);
    expect((await jobsOf(claimId)).filter((job) => job.planKey === "r2")).toHaveLength(PLAN_STEPS.length);

    // A claim whose last submission was the first submit still cannot be "resubmitted".
    const plain = await seedDraft("eq5-plain");
    expect((await submit(plain.user, plain.claimId)).status).toBe(200);
    expect((await resubmit(plain.user, plain.claimId)).status).toBe(409);
  });

  it("EQ-6: a photo completed after submit queues the photo check and the engine under an evidence-version plan key; repeating it creates nothing", async () => {
    const { user, claimId } = await seedDraft("eq6");
    expect((await submit(user, claimId)).status).toBe(200);
    await finishJobs(claimId);

    const { complete } = await uploadPhoto(user, claimId, "req-eq6-photo-0001");
    const late = (await jobsOf(claimId)).filter((job) => job.planKey !== "r1");
    expect(late.map((job) => job.step)).toEqual(["ai_assessment", "engine"]);
    expect(late[0].planKey).toMatch(/^r1:ev:[0-9a-f]{12}$/);
    expect(late.every((job) => job.planKey === late[0].planKey && job.status === "queued" && job.requestId === "req-eq6-photo-0001")).toBe(true);

    // The completed call repeated (a dropped response): the same photo set, no new job.
    const repeated = await complete();
    expect(repeated.status).toBe(200);
    expect(await VerificationJob.countDocuments({ claimId })).toBe(PLAN_STEPS.length + 2);

    // A draft gets its plan at submit, not per photo.
    const draft = await seedDraft("eq6-draft");
    expect(await VerificationJob.countDocuments({ claimId: draft.claimId })).toBe(0);
  });

  it("EQ-6b: a photo added while the photo check is running is assessed by that job running again — the engine never decides on, or assesses, a stale photo set", async () => {
    const { user, claimId } = await seedDraft("eq6b");
    expect((await submit(user, claimId)).status).toBe(200);
    // The farmer adds a second photo while the model is still looking at the first.
    let added = null;
    mocks.generate.mockImplementationOnce(async () => {
      added = await uploadPhoto(user, claimId, "req-eq6b-photo-0001");
      return answer(CLEAR);
    });
    await runQueue(claimId);
    expect(added).not.toBeNull();

    // No second photo check or engine job was queued beside the running ones...
    const jobs = await jobsOf(claimId);
    expect(jobs.map((job) => job.step)).toEqual(PLAN_STEPS);
    // ...the running photo check ran once more on the new set, without using an attempt.
    const photoCheck = jobs.find((job) => job.step === "ai_assessment");
    expect(photoCheck).toMatchObject({ status: "succeeded", attempts: 1, rescheduleCount: 1, resultSummary: { status: "completed" } });
    expect(photoCheck.attemptLog.map((entry) => entry.outcome)).toEqual(["rescheduled", "succeeded"]);
    // One call for the first run, two for the new set; the engine made none of its own.
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    const assessment = await ClaimAssessment.findOne({ claimId }).lean();
    expect(assessment.evidenceVersion).toBe(await storedPhotoVersion(claimId));
    expect(assessment.aiAggregate.imageCount).toBe(2);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(0);
  });

  it("EQ-6c: a photo check that fails inside the engine under a technical hold is handed to the queue — retried, then the hold is re-evaluated; never held with nothing retrying it", async () => {
    const { user, claimId } = await seedDraft("eq6c");
    expect((await submit(user, claimId)).status).toBe(200);
    // The plan's photo check assesses the first photo; the claim is not decided yet.
    await VerificationJob.updateMany(
      { claimId, step: { $ne: "ai_assessment" } },
      { $set: { status: "succeeded", leaseOwner: null, leaseUntil: null }, $unset: { activeKey: "" } }
    );
    await runQueue(claimId);
    expect((await ClaimAssessment.findOne({ claimId }).lean()).status).toBe("completed");

    // A second photo is stored, but its late-evidence plan was never written.
    await storePhotoWithoutPlan(claimId);
    expect(await VerificationJob.countDocuments({ claimId, status: { $in: ["queued", "running"] } })).toBe(0);

    // A re-evaluation runs the engine while the model refuses: it holds the claim and queues the photo
    // check for a retry after the first backoff delay (60 s, -20% jitter at most).
    mocks.generate.mockRejectedValue(providerFailure(429));
    await enqueue({ claimId, cognitoSub: user, step: "engine" });
    const before = Date.now();
    const [engine] = await drain({ claimId });
    expect(engine).toMatchObject({ step: "engine", outcome: "succeeded", summary: { claimState: "submitted", held: true } });
    const retry = await VerificationJob.findOne({ claimId, step: "ai_assessment", status: "queued" }).lean();
    expect(retry).not.toBeNull();
    expect(retry.runAt.getTime()).toBeGreaterThanOrEqual(before + 48_000);
    expect(retry.correlationId).toBe(`clm_${claimId}_r1`);
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(0);

    // The provider recovers: the queued photo check succeeds, re-queues the engine, and the claim is
    // decided on both photos.
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(answer(CLEAR));
    await runQueue(claimId);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    const assessment = await ClaimAssessment.findOne({ claimId }).lean();
    expect(assessment.evidenceVersion).toBe(await storedPhotoVersion(claimId));
    expect(assessment.aiAggregate.imageCount).toBe(2);
    expect(await ClaimAudit.countDocuments({ claimId, toState: { $in: ["rejected", "more_evidence_required"] } })).toBe(0);
  });

  it("EQ-7: a land document attached after submit queues the document check, the official record lookup and the engine", async () => {
    const { user, claimId } = await seedDraft("eq7");
    expect((await submit(user, claimId)).status).toBe(200);
    await finishJobs(claimId);

    const presign = await api().post("/upload/presign").set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "doc.png" });
    const { uploadId } = presign.body.data;
    await putObject({ key: (await ImageRecord.findOne({ uploadId })).s3Key, buffer: PNG, mediaType: "image/png" });
    await api().post(`/upload/${uploadId}/complete`).set(authHeader(user));
    const attach = () => api().post(`/claims/${claimId}/ownership`).set(authHeader(user)).set("x-request-id", "req-eq7-attach-0001").send({ uploadId });
    const attached = await attach();
    expect(attached.status).toBe(200);
    const evidenceId = attached.body.data.evidence.id;

    const late = (await jobsOf(claimId)).filter((job) => job.planKey !== "r1");
    expect(late.map((job) => job.step)).toEqual(["land_documents", "official_land_record", "engine"]);
    expect(late.every((job) => job.planKey === `r1:doc:${evidenceId}` && job.requestId === "req-eq7-attach-0001")).toBe(true);

    expect((await attach()).status).toBe(200);
    expect(await VerificationJob.countDocuments({ claimId })).toBe(PLAN_STEPS.length + 3);
  });

  it("EQ-7b: a land document attached while the document check is running makes that job run once more — both documents are examined, with no second job and no extra attempt", async () => {
    await ensureDefaultExecutors();
    const { DEFAULT_EXECUTORS } = await import("../services/verificationSteps.js");
    setExecutor("land_documents", DEFAULT_EXECUTORS.land_documents);
    try {
      const { user, claimId } = await seedDraft("eq7b");
      const firstDocument = await attachDocument(user, claimId); // on the draft: part of the submit plan
      expect((await submit(user, claimId)).status).toBe(200);
      const planned = ["ai_assessment", "land_documents", "official_land_record", "satellite", "weather", "engine"];
      expect((await jobsOf(claimId)).map((job) => job.step)).toEqual(planned);

      let secondDocument = null;
      let documentCalls = 0;
      mocks.generate.mockImplementation(async (...args) => {
        if (!promptOf(args).includes("land/ownership document")) return answer(CLEAR);
        documentCalls += 1;
        // The farmer attaches a second document while the model reads the first.
        if (documentCalls === 1) secondDocument = await attachDocument(user, claimId, "req-eq7b-attach-0001");
        return answer(LAND_RECORD);
      });
      const outcomes = await runQueue(claimId);
      expect(secondDocument).not.toBeNull();

      const jobs = await jobsOf(claimId);
      expect(jobs.map((job) => job.step)).toEqual(planned);
      const documentCheck = jobs.find((job) => job.step === "land_documents");
      expect(documentCheck).toMatchObject({ status: "succeeded", attempts: 1, rescheduleCount: 0, resultSummary: { documents: 2, examined: 1, skipped: 1, failed: 0 } });
      expect(documentCheck.attemptLog.map((entry) => entry.outcome)).toEqual(["rerun_requested", "succeeded"]);
      expect(documentCheck.rerunRequested).toBeUndefined();
      expect(documentCalls).toBe(2); // each document examined once
      for (const id of [firstDocument, secondDocument]) {
        expect((await VerificationEvidence.findById(id).lean()).result?.aiLandDocumentExamination).toBeTruthy();
      }
      // The record lookup and the engine waited for the rerun: each ran once, and only after it.
      const ranOrder = outcomes.filter((result) => ["land_documents", "official_land_record", "engine"].includes(result.step) && result.outcome !== "waiting_for_dependencies" && result.outcome !== "waiting_for_other_steps");
      expect(ranOrder.map((result) => [result.step, result.outcome])).toEqual([
        ["land_documents", "rerun"],
        ["land_documents", "succeeded"],
        ["official_land_record", "succeeded"],
        ["engine", "succeeded"],
      ]);
      expect(jobs.find((job) => job.step === "official_land_record")).toMatchObject({ status: "succeeded", attempts: 1 });
      expect(jobs.find((job) => job.step === "engine")).toMatchObject({ status: "succeeded", attempts: 1 });
      expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    } finally {
      setExecutor("land_documents", async () => ({ fake: "land_documents" }));
    }
  });

  it("EQ-8: withdrawing cancels the queued jobs; nothing runs afterwards — no model call, no review case", async () => {
    const { user, claimId } = await seedDraft("eq8");
    expect((await submit(user, claimId)).status).toBe(200);
    // One job is mid-run when the farmer withdraws.
    const running = await claimNext({ claimId, now: new Date(), owner: "busy-worker" });
    expect(running.step).toBe("ai_assessment");

    const withdrawn = await api().post(`/claims/${claimId}/withdraw`).set(authHeader(user));
    expect(withdrawn.status).toBe(200);
    const jobs = await jobsOf(claimId);
    for (const job of jobs.filter((row) => row.step !== "ai_assessment")) {
      expect(job).toMatchObject({ status: "cancelled", cancelReason: "claim_withdrawn" });
      expect(job.activeKey).toBeUndefined();
    }

    // The running one stops at the queue's withdrawn-claim guard; a drain then has nothing to do.
    expect(await runJob(running, { now: new Date() })).toMatchObject({ outcome: "cancelled", reason: "claim_withdrawn" });
    expect(await drain({ claimId, now: () => new Date(Date.now() + DAY_MS) })).toEqual([]);
    expect((await jobsOf(claimId)).every((job) => job.status === "cancelled")).toBe(true);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(0);
    expect(await ClaimAudit.countDocuments({ claimId, action: "withdrawn" })).toBe(1);
  });

  it("EQ-9: a withdrawal racing the engine's lock — exactly one wins, and a claim is never both decided and withdrawn", async () => {
    // (a) The withdrawal lands after the engine has read the claim, before it takes the lock.
    const early = await seedDraft("eq9-early");
    expect((await submit(early.user, early.claimId)).status).toBe(200);
    await VerificationJob.deleteMany({ claimId: early.claimId });
    const realFind = VerificationEvidence.find;
    let withdrawal = null;
    const findSpy = vi.spyOn(VerificationEvidence, "find").mockImplementation((...args) => {
      const filter = args[0] || {};
      if (withdrawal || String(filter.claimId) !== early.claimId || Object.keys(filter).length !== 1) {
        return realFind.apply(VerificationEvidence, args);
      }
      withdrawal = api().post(`/claims/${early.claimId}/withdraw`).set(authHeader(early.user)).then((response) => response);
      return { lean: async () => { await withdrawal; return realFind.apply(VerificationEvidence, args).lean(); } };
    });
    let engineResult;
    try {
      engineResult = await verifyClaim({ claimId: early.claimId, cognitoSub: early.user });
    } finally {
      findSpy.mockRestore();
    }
    expect((await withdrawal).status).toBe(200);
    expect(engineResult).toMatchObject({ claimState: "withdrawn", outcome: null });
    expect((await LossClaim.findById(early.claimId).lean()).state).toBe("withdrawn");
    expect(await ClaimAudit.countDocuments({ claimId: early.claimId, action: { $in: ["verification_started", "verified"] } })).toBe(0);
    expect((await ClaimAssessment.findOne({ claimId: early.claimId }).lean()).state ?? null).toBeNull();

    // (a') The same under a hold (an AI-only "no damage" reading): the withdrawn claim gets no
    // review case and no hold audit row.
    mocks.generate.mockResolvedValue(answer({ ...CLEAR, damageDetected: false, damageType: null, severity: null, observations: [] }));
    const holding = await seedDraft("eq9-hold");
    expect((await submit(holding.user, holding.claimId)).status).toBe(200);
    await VerificationJob.deleteMany({ claimId: holding.claimId });
    let holdWithdrawal = null;
    const holdSpy = vi.spyOn(VerificationEvidence, "find").mockImplementation((...args) => {
      const filter = args[0] || {};
      if (holdWithdrawal || String(filter.claimId) !== holding.claimId || Object.keys(filter).length !== 1) {
        return realFind.apply(VerificationEvidence, args);
      }
      holdWithdrawal = api().post(`/claims/${holding.claimId}/withdraw`).set(authHeader(holding.user)).then((response) => response);
      return { lean: async () => { await holdWithdrawal; return realFind.apply(VerificationEvidence, args).lean(); } };
    });
    let holdResult;
    try {
      holdResult = await verifyClaim({ claimId: holding.claimId, cognitoSub: holding.user });
    } finally {
      holdSpy.mockRestore();
    }
    expect((await holdWithdrawal).status).toBe(200);
    expect(holdResult).toMatchObject({ claimState: "withdrawn", outcome: null });
    expect(await ClaimAudit.countDocuments({ claimId: holding.claimId, action: { $in: ["verification_held", "review_required"] } })).toBe(0);
    expect(await VerificationEvidence.countDocuments({ claimId: holding.claimId, "metadata.kind": "review_case" })).toBe(0);
    mocks.generate.mockResolvedValue(answer(CLEAR));

    // (b) The engine takes the lock first: the withdrawal is refused and the decision stands.
    const late = await seedDraft("eq9-late");
    expect((await submit(late.user, late.claimId)).status).toBe(200);
    await VerificationJob.deleteMany({ claimId: late.claimId });
    const realCreate = ClaimAudit.create;
    let refused = null;
    const auditSpy = vi.spyOn(ClaimAudit, "create").mockImplementation(async (...args) => {
      const row = args[0] || {};
      if (!refused && row.action === "verification_started" && String(row.claimId) === late.claimId) {
        refused = await api().post(`/claims/${late.claimId}/withdraw`).set(authHeader(late.user));
      }
      return realCreate.apply(ClaimAudit, args);
    });
    let decided;
    try {
      decided = await verifyClaim({ claimId: late.claimId, cognitoSub: late.user });
    } finally {
      auditSpy.mockRestore();
    }
    expect(refused.status).toBe(409);
    expect(decided).toMatchObject({ claimState: "verified", outcome: "verified" });
    expect(await ClaimAudit.countDocuments({ claimId: late.claimId, action: "withdrawn" })).toBe(0);

    // (c) Both at once, several times: whatever the order, the end state is consistent.
    for (let i = 0; i < 4; i += 1) {
      const raced = await seedDraft(`eq9-race-${i}`);
      expect((await submit(raced.user, raced.claimId)).status).toBe(200);
      await VerificationJob.deleteMany({ claimId: raced.claimId });
      const [engine, withdraw] = await Promise.allSettled([
        verifyClaim({ claimId: raced.claimId, cognitoSub: raced.user }),
        api().post(`/claims/${raced.claimId}/withdraw`).set(authHeader(raced.user)),
      ]);
      const claim = await LossClaim.findById(raced.claimId).lean();
      const withdrawnAudits = await ClaimAudit.countDocuments({ claimId: raced.claimId, action: "withdrawn" });
      const decisionAudits = await ClaimAudit.countDocuments({ claimId: raced.claimId, action: "verified" });
      const assessment = await ClaimAssessment.findOne({ claimId: raced.claimId }).lean();
      if (claim.state === "withdrawn") {
        expect(withdraw.value.status).toBe(200);
        expect([withdrawnAudits, decisionAudits]).toEqual([1, 0]);
        expect(assessment?.state ?? null).toBeNull();
      } else {
        expect(claim.state).toBe("verified");
        expect(withdraw.value.status).toBe(409);
        expect([withdrawnAudits, decisionAudits]).toEqual([0, 1]);
        expect(engine.status).toBe("fulfilled");
      }
    }
  });

  // Found by e2e E2E-03: the browser retries a submit whose answer was lost 1.5 s later, and a worker
  // can decide the claim within that time. The retry used to get a 409 ("can only be submitted from
  // draft"), so a farmer whose claim was submitted AND decided saw "this claim was changed elsewhere".
  it("EQ-10: a submit repeated after the worker decided the claim is answered 200 'already submitted' with the decided claim; nothing is written or planned", async () => {
    const { user, claimId } = await seedDraft("eq10");
    const first = await submit(user, claimId, "req-eq10-first-0001");
    expect(first.status).toBe(200);
    expect(first.body.message).toBe("Claim submitted");
    await runQueue(claimId);
    expect((await LossClaim.findById(claimId).lean()).state).toBe("verified");
    const jobsBefore = await jobsOf(claimId);
    const auditsBefore = await ClaimAudit.countDocuments({ claimId });

    const retried = await submit(user, claimId, "req-eq10-retry-0002");
    expect(retried.status).toBe(200);
    expect(retried.body.message).toBe("Claim already submitted");
    expect(retried.body.data.claim).toMatchObject({ id: claimId, state: "verified" });
    expect((await jobsOf(claimId)).map((job) => [String(job._id), job.status])).toEqual(jobsBefore.map((job) => [String(job._id), job.status]));
    expect(await ClaimAudit.countDocuments({ claimId })).toBe(auditsBefore);
    expect(await ClaimAudit.countDocuments({ claimId, action: "submitted" })).toBe(1);
    expect((await LossClaim.findById(claimId).lean()).submissionRound).toBe(1);

    // Ten such late retries at once change nothing either.
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(user, claimId, `req-eq10-burst-${String(i).padStart(4, "0")}`)));
    expect(burst.map((response) => response.status)).toEqual(Array(10).fill(200));
    expect(await ClaimAudit.countDocuments({ claimId })).toBe(auditsBefore);

    // A claim waiting for more evidence is answered the same way (the resubmit endpoint moves it on).
    const waiting = await seedDraft("eq10-more", { photo: false });
    expect((await submit(waiting.user, waiting.claimId)).status).toBe(200);
    await runQueue(waiting.claimId);
    expect((await LossClaim.findById(waiting.claimId).lean()).state).toBe("more_evidence_required");
    const late = await submit(waiting.user, waiting.claimId);
    expect(late.status).toBe(200);
    expect(late.body.data.claim.state).toBe("more_evidence_required");
    expect(await ClaimAudit.countDocuments({ claimId: waiting.claimId, action: "submitted" })).toBe(1);

    // Still refused: a draft that was never submitted but withdrawn, and a submitted claim the farmer
    // then withdrew.
    const withdrawnDraft = await seedDraft("eq10-wd-draft");
    expect((await api().post(`/claims/${withdrawnDraft.claimId}/withdraw`).set(authHeader(withdrawnDraft.user))).status).toBe(200);
    expect((await submit(withdrawnDraft.user, withdrawnDraft.claimId)).status).toBe(409);
    const withdrawnAfterSubmit = await seedDraft("eq10-wd-sub");
    expect((await submit(withdrawnAfterSubmit.user, withdrawnAfterSubmit.claimId)).status).toBe(200);
    expect((await api().post(`/claims/${withdrawnAfterSubmit.claimId}/withdraw`).set(authHeader(withdrawnAfterSubmit.user))).status).toBe(200);
    expect((await submit(withdrawnAfterSubmit.user, withdrawnAfterSubmit.claimId)).status).toBe(409);
  });
});
