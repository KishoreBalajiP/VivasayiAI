import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Provider error taxonomy at its call sites (plan A1): PE-4..PE-6. The real claim-vision, assessment,
// queue and chat code runs against a fake Gemini model; Chroma, Cohere and the weather service are
// fakes too, so nothing leaves the process. The image-AI mode is read when config/env.js loads.
vi.hoisted(() => {
  process.env.IMAGE_AI_MODE = "live";
});

const mocks = vi.hoisted(() => ({ generate: vi.fn(), getCollection: vi.fn(), embedQuery: vi.fn(), weather: vi.fn() }));
vi.mock("chromadb", () => ({ CloudClient: class { getCollection(...a) { return mocks.getCollection(...a); } } }));
vi.mock("@langchain/cohere", () => ({ CohereEmbeddings: class { embedQuery(...a) { return mocks.embedQuery(...a); } } }));
vi.mock("@langchain/google-genai", () => ({ ChatGoogleGenerativeAI: class { generate(...a) { return mocks.generate(...a); } } }));
vi.mock("../services/weather.service.js", () => ({ getWeather: (...a) => mocks.weather(...a) }));

import ChatSession from "../models/ChatSession.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import District from "../models/District.js";
import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import logger from "../utils/logger.js";
import ImageRecord from "../models/ImageRecord.js";
import { putObject } from "../services/s3.service.js";
import { _resetCollectionCache, generateResponse } from "../services/chat.service.js";
import { analyzeClaimImage } from "../services/claimVision.service.js";
import claimAssessmentService from "../services/claimAssessment.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { queryOfficialLandRecord } from "../services/officialLandRecord.service.js";
import { drain, enqueue, ensureDefaultExecutors, setExecutor } from "../services/verificationJobs.service.js";
import {
  api,
  authHeader,
  clearTestDatabase,
  seedProfile,
  squareGeometry,
  startTestDatabase,
  stopTestDatabase,
} from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
const providerFailure = (status, message = `[${status}] provider refused the call`) => Object.assign(new Error(message), { status });
let seq = 0;
const newUser = (label) => `pe-${label}-${(++seq).toString(36)}`;

const seedSubmittedClaimWithPhoto = async (label) => {
  const user = newUser(label);
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "F", crop: "Paddy", geometry: squareGeometry(0.009) });
  const created = await api().post("/claims").set(authHeader(user)).send({
    parcelId: parcel.body.data.parcel.parcelId,
    eventType: "flood",
    eventDate: new Date(Date.now() - 2 * 86400000).toISOString(),
    geometry: squareGeometry(0.009),
    idempotencyKey: `idem-pe-${seq}`,
  });
  const claimId = created.body.data.claim.id;
  const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "p.png" });
  const { uploadId } = presign.body.data;
  const evidence = await ClaimEvidence.findOne({ uploadId });
  await putObject({ key: evidence.s3Key, buffer: PNG, mediaType: "image/png" });
  expect((await api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);
  expect((await api().post(`/claims/${claimId}/submit`).set(authHeader(user))).status).toBe(200);
  return { user, claimId };
};

describe("provider errors at their call sites", () => {
  let mongo;

  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
    for (const step of ["satellite", "weather", "land_documents", "official_land_record", "engine"]) {
      setExecutor(step, async () => ({ fake: step }));
    }
    await ensureDefaultExecutors(); // the real ai_assessment executor
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of [ChatSession, ClaimAssessment, ClaimAudit, ClaimEvidence, District, ImageRecord, LossClaim, VerificationEvidence, VerificationJob]) {
      await model.deleteMany({});
    }
    await District.create({ name: "Thanjavur", lat: 10.78, lon: 79.14, regionType: "Delta" });
    _resetCollectionCache();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.embedQuery.mockResolvedValue([0.1]);
    mocks.getCollection.mockResolvedValue({ query: vi.fn().mockResolvedValue({ documents: [["Paddy needs water."]], metadatas: [[{ filename: "paddy.csv" }]] }) });
    mocks.weather.mockResolvedValue({ status: "ok", freshness: "fresh", current: null, forecast: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.GEMINI_TIMEOUT_MS;
  });

  it("PE-4: a Gemini 429 during the photo check is recorded as quota on the assessment and PROVIDER_QUOTA on the job", async () => {
    const { user, claimId } = await seedSubmittedClaimWithPhoto("quota");
    mocks.generate.mockRejectedValue(providerFailure(429, "[429 Too Many Requests] You exceeded your current quota"));
    const { job } = await enqueue({ claimId, cognitoSub: user, step: "ai_assessment" });

    const [result] = await drain({ claimId, maxJobs: 1 });
    expect(result).toMatchObject({ step: "ai_assessment", outcome: "retry_scheduled" });

    const assessment = await ClaimAssessment.findOne({ claimId }).lean();
    expect(assessment.status).toBe("failed");
    expect(assessment.error).toMatchObject({ stage: "provider", kind: "quota", code: "PROVIDER_QUOTA", message: "Failed to analyze claim evidence image" });
    const stored = await VerificationJob.findById(job._id).lean();
    expect(stored.status).toBe("queued");
    expect(stored.lastError.code).toBe("PROVIDER_QUOTA");
    const audit = await ClaimAudit.findOne({ claimId, action: "assessment_failed" }).lean();
    expect(audit.metadata).toMatchObject({ kind: "quota", code: "PROVIDER_QUOTA" });
    expect(JSON.stringify(audit)).not.toContain("exceeded your current quota");
    // The claim is untouched: a provider refusal is not a finding.
    expect((await LossClaim.findById(claimId)).state).toBe("submitted");
  });

  it("PE-5: a rejected Gemini key in chat returns 503 'temporarily unavailable' and is logged at error level for an operator", async () => {
    const user = newUser("auth");
    await seedProfile(user);
    const errors = [];
    vi.spyOn(logger, "error").mockImplementation((record) => { errors.push(record); });
    mocks.generate.mockRejectedValue(providerFailure(400, "[400 Bad Request] API key not valid. Please pass a valid API key."));

    const response = await api().post("/chat").set(authHeader(user)).send({ message: "when should I irrigate paddy" });
    expect(response.status).toBe(503);
    expect(response.body.message).toBe("AI service is temporarily unavailable");
    expect(JSON.stringify(response.body)).not.toMatch(/API key|400 Bad Request/);

    const record = errors.find((entry) => entry && entry.kind === "auth_config");
    expect(record).toMatchObject({ code: "PROVIDER_AUTH_CONFIG", provider: "gemini", operation: "chat.text_generate", operatorAction: true, retryable: true });
    expect(JSON.stringify(record)).not.toContain("API key not valid");

    // 401 / 403 from the provider are the same operator problem.
    mocks.generate.mockRejectedValueOnce(providerFailure(403));
    await expect(generateResponse({ message: "when should I irrigate paddy", cognitoSub: user })).rejects.toMatchObject({
      statusCode: 503,
      message: "AI service is temporarily unavailable",
      kind: "auth_config",
    });

    // The photo-diagnosis chat turn: the vision call answers, the reasoning call is refused (403).
    const presign = await api().post("/upload/presign").set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "leaf.png" });
    expect(presign.status).toBe(200);
    const { uploadId } = presign.body.data;
    await putObject({ key: (await ImageRecord.findOne({ uploadId })).s3Key, buffer: PNG, mediaType: "image/png" });
    expect((await api().post(`/upload/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);
    errors.length = 0;
    mocks.generate.mockReset();
    mocks.generate
      .mockResolvedValueOnce({ generations: [[{ text: JSON.stringify({ crop: "paddy", symptoms: [], likelyIssues: [], confidence: "low", uncertain: true, summary: "leaf" }) }]] })
      .mockRejectedValueOnce(providerFailure(403, "[403 Forbidden] Method doesn't allow unregistered callers. Please use API Key."));
    const image = await api().post("/chat").set(authHeader(user)).send({ message: "what is wrong with this leaf", language: "en", uploadId });
    expect(image.status).toBe(503);
    expect(image.body.message).toBe("AI service is temporarily unavailable");
    expect(JSON.stringify(image.body)).not.toMatch(/API Key|403 Forbidden/);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    const imageRecord = errors.find((entry) => entry && entry.kind === "auth_config");
    expect(imageRecord).toMatchObject({ code: "PROVIDER_AUTH_CONFIG", provider: "gemini", operation: "image.reason_generate", operatorAction: true });
    expect(JSON.stringify(imageRecord)).not.toContain("unregistered callers");
    // The photo is kept; only the analysis is marked failed, so the farmer can retry.
    expect((await ImageRecord.findOne({ uploadId })).status).toBe("failed");
  });

  it("P4-08b: under v1-legacy an unreadable model answer is still an UNSURE photo and the assessment completes", async () => {
    expect(resolvePolicy().id).toBe("v1-legacy");
    const { user, claimId } = await seedSubmittedClaimWithPhoto("legacy-malformed");
    mocks.generate.mockResolvedValue({ generations: [[{ text: "not json" }]] });

    const result = await claimAssessmentService.assessClaimEvidence({ claimId, cognitoSub: user });
    expect(result.status).toBe("completed");
    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0].observation).toMatchObject({ uncertain: true, confidence: "unclear", damageDetected: null });
    expect(result.aiAggregate.uncertain).toBe(true);
    // One call, no retry and no failure: malformed output is not a provider error under v1-legacy.
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    const stored = await ClaimAssessment.findOne({ claimId }).lean();
    expect(stored).toMatchObject({ status: "completed", error: null });
    expect(await ClaimAudit.countDocuments({ claimId, action: "assessment_failed" })).toBe(0);
    expect(await ClaimAudit.countDocuments({ claimId, action: "ai_completed" })).toBe(1);
  });

  it("PE-6: existing HTTP statuses and messages are unchanged at every classified call site", async () => {
    const user = newUser("compat");
    await seedProfile(user);
    const ask = () => generateResponse({ message: "when should I irrigate paddy", cognitoSub: user });

    // Chat: quota and overload stay 503 "busy"; a timeout stays the sanitized 500.
    for (const status of [429, 503]) {
      mocks.generate.mockRejectedValueOnce(providerFailure(status));
      await expect(ask()).rejects.toMatchObject({ statusCode: 503, message: "AI service is busy. Please try again later." });
    }
    process.env.GEMINI_TIMEOUT_MS = "50";
    mocks.generate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(ask()).rejects.toMatchObject({ statusCode: 500, message: "Failed to generate chat response" });
    delete process.env.GEMINI_TIMEOUT_MS;
    // An unclassified provider error is still the generic 500.
    mocks.generate.mockRejectedValueOnce(new Error("something odd"));
    await expect(ask()).rejects.toMatchObject({ statusCode: 500, message: "Failed to generate chat response" });

    // Claim vision: every provider failure is still the sanitized 500, now with a kind.
    const image = { imageBuffer: PNG, mediaType: "image/png" };
    for (const [failure, kind] of [[providerFailure(429), "quota"], [providerFailure(503), "overload"], [new Error("upstream 500"), "application_defect"]]) {
      mocks.generate.mockRejectedValueOnce(failure);
      await expect(analyzeClaimImage(image)).rejects.toMatchObject({ statusCode: 500, message: "Failed to analyze claim evidence image", kind });
    }
    process.env.GEMINI_TIMEOUT_MS = "50";
    mocks.generate.mockImplementationOnce(() => new Promise(() => {}));
    await expect(analyzeClaimImage(image)).rejects.toMatchObject({ statusCode: 500, message: "Failed to analyze claim evidence image", kind: "timeout" });
    delete process.env.GEMINI_TIMEOUT_MS;
    // Under the default ("unsure") an unreadable answer is still an uncertain observation, not an error.
    mocks.generate.mockResolvedValueOnce({ generations: [[{ text: "not json" }]] });
    expect(await analyzeClaimImage(image)).toMatchObject({ uncertain: true, confidence: "unclear" });
    mocks.generate.mockResolvedValueOnce({ generations: [[{ text: "not json" }]] });
    await expect(analyzeClaimImage({ ...image, onUnparseable: "throw" })).rejects.toMatchObject({
      statusCode: 500, message: "Failed to analyze claim evidence image", kind: "malformed_response", code: "PROVIDER_MALFORMED",
    });

    // Official land record: still `unavailable` with the same reason, now with a reasonCode kind.
    const saved = { mode: process.env.LAND_RECORD_MODE, url: process.env.LAND_RECORD_PROVIDER_URL, key: process.env.LAND_RECORD_API_KEY };
    process.env.LAND_RECORD_MODE = "live";
    process.env.LAND_RECORD_PROVIDER_URL = "http://127.0.0.1:9/land-record";
    process.env.LAND_RECORD_API_KEY = "test-placeholder";
    try {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));
      const down = await queryOfficialLandRecord({ state: "Tamil Nadu", district: "Thanjavur", surveyNumber: "1" });
      expect(down).toMatchObject({ status: "unavailable", reason: "Official land-record provider unavailable", reasonCode: "network" });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 429 }));
      const busy = await queryOfficialLandRecord({ state: "Tamil Nadu", district: "Thanjavur", surveyNumber: "1" });
      expect(busy).toMatchObject({ status: "unavailable", reason: "Official land-record provider error (HTTP 429)", reasonCode: "quota" });
    } finally {
      for (const [name, value] of [["LAND_RECORD_MODE", saved.mode], ["LAND_RECORD_PROVIDER_URL", saved.url], ["LAND_RECORD_API_KEY", saved.key]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
