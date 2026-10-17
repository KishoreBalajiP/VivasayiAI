import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A6, leak fix) — GET /claims/:id/verification shows the farmer the FARMER projection
// of the stored evidence rows: review cases (with their failed steps and error codes), document
// examination results, providers and internal versions stay on the reviewer's side
// (GET /admin/claims/:id/verification-diagnostics).
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

import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import { getVerificationEvidenceView } from "../services/verificationEvidence.service.js";
import { adminHeader, api, authHeader, startTestDatabase, stopTestDatabase, squareGeometry } from "./helpers.js";
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
  submitClaim,
  uploadPhoto,
} from "./fixtures/claimFlow.js";

// The frontend's ClaimVerificationEvidenceRow keys (FE src/types.ts).
const FRONTEND_ROW_KEYS = ["id", "claimId", "source", "status", "confidence", "observedAt", "provider", "providerVersion", "evidenceVersion", "evaluationVersion", "reference", "metadata", "result", "operative", "createdAt", "updatedAt"];
const LEAKS = ['"kind":"review_case"', "rv_", "failedStep", "errorCode", "errorKind", "automated_step_failed", "aiLandDocumentExamination", "PROVIDER_", "reviewReasons", "cdse", "open-meteo"];

// A submitted claim whose photo check died (one attempt, provider 503): a review case exists, the
// land document was examined by the AI, satellite and weather recorded rows.
const claimWithDeadJob = async (label) => {
  const farmer = await seedFarmer(label);
  const claimId = await createClaim(farmer);
  await uploadPhoto(farmer.user, claimId);
  const documentId = await attachDocument(farmer.user, claimId, "land_record");
  await submitClaim(farmer.user, claimId);
  mocks.generate.mockRejectedValue(providerFailure(503));
  await runQueue(claimId);
  await VerificationEvidence.updateOne(
    { _id: documentId },
    { $set: { result: { aiLandDocumentExamination: { holderNames: ["Murugan"], reviewRequired: true, flags: ["holder_name_mismatch"] } } } }
  );
  expect(await VerificationEvidence.countDocuments({ claimId, "metadata.kind": "review_case" })).toBe(1);
  return { ...farmer, claimId, documentId };
};

describe("farmer verification view leaks nothing internal (VL)", () => {
  let mongo;
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    fakeSupportingExecutors();
    setExecutor("land_documents", async () => ({ fake: "land_documents" }));
    setExecutor("official_land_record", async () => ({ fake: "official_land_record" }));
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

  it("VL-1: after a dead job, the farmer's GET /verification has no review case, failed step, error code or document examination", async () => {
    const { user, claimId } = await claimWithDeadJob("vl1");
    const response = await api().get(`/claims/${claimId}/verification`).set(authHeader(user));
    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
    const persisted = response.body.data.verification.persisted;
    expect(persisted.map((row) => row.source).sort()).toEqual(["OWNERSHIP", "SATELLITE", "WEATHER"]);
    expect(persisted.every((row) => row.result === null && row.provider === null)).toBe(true);
    // The progress object tells the farmer a reviewer will look, without saying why internally.
    expect(response.body.data.progress.overallStatus).toBe("waiting_for_review");
  });

  it("VL-2: the reviewer's diagnostics still show the review case, the error codes, the attempt log and the examination", async () => {
    const { claimId } = await claimWithDeadJob("vl2");
    const response = await api().get(`/admin/claims/${claimId}/verification-diagnostics`).set(adminHeader("vl2-admin"));
    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.reviewCases).toEqual([
      expect.objectContaining({ status: "PENDING", source: "AI_IMAGE", reasons: ["automated_step_failed_ai_assessment"], failedStep: "ai_assessment", errorKind: "overload", errorCode: "PROVIDER_OVERLOAD" }),
    ]);
    const aiJob = data.jobs.find((job) => job.step === "ai_assessment");
    expect(aiJob).toMatchObject({ status: "dead", attempts: 1, lastError: { kind: "overload", code: "PROVIDER_OVERLOAD" } });
    expect(aiJob.attemptLog).toEqual([expect.objectContaining({ attempt: 1, outcome: "dead", code: "PROVIDER_OVERLOAD" })]);
    expect(JSON.stringify(data.evidence)).toContain("aiLandDocumentExamination");
    // The service's internal (default) audience is unchanged too.
    const internal = await getVerificationEvidenceView({ claimId, cognitoSub: (await VerificationJob.findOne({ claimId }).lean()).cognitoSub });
    expect(internal.persisted.some((row) => row.metadata && row.metadata.kind === "review_case")).toBe(true);
  });

  it("VL-3: the farmer's rows keep exactly the keys the frontend reads, with only harmless metadata", async () => {
    const { user, claimId } = await claimWithDeadJob("vl3");
    const response = await api().get(`/claims/${claimId}/verification`).set(authHeader(user));
    const persisted = response.body.data.verification.persisted;
    expect(persisted.length).toBeGreaterThan(0);
    for (const row of persisted) {
      for (const key of FRONTEND_ROW_KEYS) expect(row, key).toHaveProperty(key);
      expect(Object.keys(row.metadata).every((key) => ["documentCategory", "processingStatus", "analysisExecuted"].includes(key))).toBe(true);
      expect(row).toMatchObject({ providerVersion: null, evidenceVersion: null, evaluationVersion: null, reference: null, result: null });
      expect(row.claimId).toBe(claimId);
    }
    expect(persisted.find((row) => row.source === "OWNERSHIP").metadata).toEqual({ documentCategory: "land_record" });
    expect(persisted.find((row) => row.source === "SATELLITE").metadata).toEqual({ processingStatus: "disabled", analysisExecuted: false });
  });

  it("VL-4: nothing about another farmer's overlapping claim reaches the claimant (verification, progress, claim, verify)", async () => {
    const holder = await seedFarmer("vl4-holder");
    const holderClaim = await createClaim(holder);
    await uploadPhoto(holder.user, holderClaim);
    await submitClaim(holder.user, holderClaim);

    const claimant = await seedFarmer("vl4-claimant");
    const claimId = await createClaim(claimant, { geometry: squareGeometry(0.009) });
    await uploadPhoto(claimant.user, claimId);
    await submitClaim(claimant.user, claimId);
    await runQueue();

    const responses = [
      await api().get(`/claims/${claimId}/verification`).set(authHeader(claimant.user)),
      await api().get(`/claims/${claimId}/progress`).set(authHeader(claimant.user)),
      await api().get(`/claims/${claimId}`).set(authHeader(claimant.user)),
      await api().post(`/claims/${claimId}/verify`).set(authHeader(claimant.user)).send({}),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(holderClaim);
      expect(text).not.toContain(holder.user);
    }
  });
  it("VL-5: the farmer's claim reads carry the policy id but no policy hash, and no AI model or provider name in existing[]; the admin views keep both", async () => {
    const farmer = await seedFarmer("vl5");
    const claimId = await createClaim(farmer);
    await uploadPhoto(farmer.user, claimId);
    await submitClaim(farmer.user, claimId);
    await runQueue(claimId);
    const stored = await (await import("../models/ClaimAssessment.js")).default.findOne({ claimId }).lean();
    expect(stored.state).toBe("verified");
    expect(stored.policy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.model).toBeTruthy();

    const verification = await api().get(`/claims/${claimId}/verification`).set(authHeader(farmer.user));
    expect(verification.status).toBe(200);
    expect(verification.body.data.claim.assessment).toMatchObject({ policyId: "v1.1-safe-ai", policyHash: null });
    const existing = verification.body.data.verification.existing;
    expect(existing.map((record) => record.source)).toEqual(expect.arrayContaining(["GEOMETRY", "AI_IMAGE"]));
    expect(existing.every((record) => record.provider === null && record.providerVersion === null)).toBe(true);
    const detail = await api().get(`/claims/${claimId}`).set(authHeader(farmer.user));
    expect(detail.body.data.claim.assessment).toMatchObject({ policyId: "v1.1-safe-ai", policyHash: null });
    const verify = await api().post(`/claims/${claimId}/verify`).set(authHeader(farmer.user)).send({});
    expect(verify.body.data.verification).toMatchObject({ policyId: "v1.1-safe-ai", policyHash: null });
    for (const response of [verification, detail, verify]) {
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(stored.policy.hash);
      expect(text).not.toContain(stored.model);
      expect(text.toLowerCase()).not.toContain("gemini");
    }

    // The reviewer's views are unchanged: the hash and the model are there.
    const adminDetail = await api().get(`/admin/claims/${claimId}`).set(adminHeader("vl5-admin"));
    expect(adminDetail.status).toBe(200);
    expect(JSON.stringify(adminDetail.body)).toContain(stored.policy.hash);
    const diagnostics = await api().get(`/admin/claims/${claimId}/verification-diagnostics`).set(adminHeader("vl5-admin"));
    expect(diagnostics.body.data.assessment.policy).toEqual({ id: "v1.1-safe-ai", hash: stored.policy.hash });
    const internal = await getVerificationEvidenceView({ claimId, cognitoSub: farmer.user });
    expect(internal.existing.find((record) => record.source === "AI_IMAGE").provider).toBe(stored.model);
  });
});
