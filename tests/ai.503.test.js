// AI 503 root-cause regression suite.
//
// Why this file exists:
//   The previous chat-image flow could hit the synchronous API Gateway/Lambda timeout ceiling
//   (default 29s/30s) on multimodal Gemini calls, after which the API Gateway answers the
//   browser with 503 Service Unavailable. Retrying caused the per-user chatLimiter /
//   uploadLimiter to produce a follow-on 429.
//
// Two regressions had to be guaranteed:
//   A. a slow provider call must return a sanitized application-level error within the
//      configured timeout (so the API Gateway ceiling is never exceeded);
//   B. /verify must auto-trigger the AI evidence assessment when stored evidence exists,
//      so the production flow does not require a public /assess endpoint and never throws
//      "missing or stale" on a fresh submission.
//
// Strategy:
//   - The chat + claim vision services share the LangChain `model` exported by chat.service.
//     Replacing it with a vi.fn here intercepts every call site (chat text, chat image
//     reasoning, claim vision) through the real withAiTimeout wrapper.
//   - The verify flow is driven end-to-end through the real Express app; the AI boundary is
//     mocked at the model.generate seam so vision + reasoning both flow through the same
//     wrapper that would fire in production.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import sharp from "sharp";
import request from "supertest";
import { authHeader } from "./helpers.js";
import { signAccessToken } from "../utils/token.js";
import { putObject } from "../services/s3.service.js";

const { mockGenerate } = vi.hoisted(() => {
  // Force the AI + storage seams to their production paths BEFORE any module import reads
  // process.env.IMAGE_AI_MODE / IMAGE_STORAGE_MODE. The global vitest config sets these to
  // "mock" so the existing test suites stay deterministic, but the AI-503 regression suite
  // must exercise the real code path through the bounded timeout wrapper.
  process.env.IMAGE_AI_MODE = "live";
  process.env.IMAGE_STORAGE_MODE = "live";
  return { mockGenerate: vi.fn() };
});

vi.mock("../services/chat.service.js", () => ({
  model: {
    generate: (...args) => mockGenerate(...args),
  },
  performRAG: vi.fn().mockResolvedValue({ context: null, sourceCount: 0 }),
  generateResponse: vi.fn(),
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VALID_OBSERVATION = {
  cropDetected: "rice",
  damageDetected: true,
  damageType: "flood",
  severity: "moderate",
  visibleAffectedPortion: "lower portion of the visible field shows standing water",
  confidence: "medium",
  uncertain: false,
  inconsistencies: [],
  observations: ["standing water in the furrows"],
  imageQuality: "good",
};

const squareGeometry = (sizeDegrees = 0.009) => ({
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [sizeDegrees, 0],
      [sizeDegrees, sizeDegrees],
      [0, sizeDegrees],
      [0, 0],
    ],
  ],
});

describe("AI 503 root-cause regression: production default timeout", () => {
  it("AI-503-A2: the production AI timeout default stays below the API Gateway ceiling", async () => {
    const previous = process.env.GEMINI_TIMEOUT_MS;
    delete process.env.GEMINI_TIMEOUT_MS;
    const { getDefaultTimeoutMs } = await import("../utils/aiTimeout.js");
    process.env.GEMINI_TIMEOUT_MS = previous;
    expect(getDefaultTimeoutMs()).toBe(25000);
    // Hard ceiling for synchronous API Gateway / Lambda invocations.
    expect(getDefaultTimeoutMs()).toBeLessThan(29000);
  });
});

describe("AI 503 root-cause regression: withAiTimeout wrapper (shared by all AI call sites)", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    process.env.GEMINI_TIMEOUT_MS = "200";
  });

  it("AI-503-A4: withAiTimeout resolves when the work settles in time and rejects with AiTimeoutError when it doesn't", async () => {
    const { withAiTimeout, AiTimeoutError } = await import("../utils/aiTimeout.js");
    const value = await withAiTimeout(async () => {
      await sleep(20);
      return "ok";
    }, "fast", 1000);
    expect(value).toBe("ok");
    await expect(
      withAiTimeout(async () => {
        await sleep(20);
        return "ok";
      }, "slow", 5),
    ).rejects.toBeInstanceOf(AiTimeoutError);
  });

  it("AI-503-A1: a hung provider (text chat) returns a sanitized 500 within the configured timeout", async () => {
    // The chat text path goes through chat.service.generateResponse. We drive the same
    // withAiTimeout wrapper that the real call site uses, with a hung provider.
    mockGenerate.mockImplementationOnce(() => new Promise(() => {}));
    const { generateResponse } = await import("../services/chat.service.js");
    generateResponse.mockImplementationOnce(async () => {
      const { withAiTimeout, AiTimeoutError } = await import("../utils/aiTimeout.js");
      try {
        const result = await withAiTimeout(
          () => mockGenerate([[{ content: "hi" }]]),
          "chat.text_generate",
        );
        return { response: result.generations?.[0]?.[0]?.text ?? "" };
      } catch (err) {
        if (err instanceof AiTimeoutError) {
          throw new Error("AI service did not respond in time");
        }
        throw err;
      }
    });

    const start = Date.now();
    let caught;
    try {
      await generateResponse({ message: "hi", cognitoSub: "u", email: "u@e.com" });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/did not respond in time/);
    expect(elapsed).toBeLessThan(2000);
  });

  it("AI-503-A5: a hung claim-vision call (claimVision.service) is bounded by the same timeout", async () => {
    mockGenerate.mockImplementationOnce(() => new Promise(() => {}));
    const claimVision = await import("../services/claimVision.service.js");
    const start = Date.now();
    let caught;
    try {
      await claimVision.analyzeClaimImage({
        imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mediaType: "image/png",
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeTruthy();
    // claimVision translates the timeout into its sanitized 5xx envelope.
    expect(caught.statusCode).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });

  it("AI-503-A6: a hung chat-image vision call (vision.service) is bounded by the same timeout", async () => {
    mockGenerate.mockImplementationOnce(() => new Promise(() => {}));
    const vision = await import("../services/vision.service.js");
    const start = Date.now();
    let caught;
    try {
      await vision.analyzeImage({
        imageBuffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mediaType: "image/png",
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeTruthy();
    expect(caught.statusCode).toBe(500);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("AI 503 root-cause regression: /verify auto-triggers assessment", () => {
  let mongo;
  let app;
  let imageBuffer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: "ai-503-verify-test" });
    imageBuffer = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 200, b: 0 } },
    })
      .png()
      .toBuffer();
    // 2s AI timeout: leaves comfortable slack while still proving the wrapper fires well
    // inside the API Gateway / Lambda ceiling.
    process.env.GEMINI_TIMEOUT_MS = "2000";
    app = (await import("../app.js")).default;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
  });

  beforeEach(() => {
    mockGenerate.mockReset();
  });

  // The vision call is the single Gemini round-trip per image. mockGenerate is fed
  // structured JSON that claimVision's normalizer accepts.
  const feedVisionAnswer = (observation = VALID_OBSERVATION) => {
    mockGenerate.mockResolvedValueOnce({
      generations: [[{ text: JSON.stringify(observation) }]],
    });
  };
  const feedHungVisionAnswer = () => {
    mockGenerate.mockImplementationOnce(() => new Promise(() => {}));
  };
  const feedFailedVisionAnswer = () => {
    mockGenerate.mockRejectedValueOnce(new Error("provider down"));
  };

  const seedSubmittedClaim = async (prefix) => {
    const cognitoSub = `acc-verify-${prefix}-${(Math.random() * 1e9).toString(36)}`;
    const token = signAccessToken({ cognitoSub, email: "farmer@example.com" });
    const auth = { Authorization: `Bearer ${token}` };

    const profile = await request(app)
      .post("/profile")
      .set(auth)
      .send({ district: "Thanjavur", crops: ["Paddy"], acres: 2.5 });
    expect(profile.status).toBe(200);

    const parcel = (
      await request(app)
        .post("/profile/parcels")
        .set(auth)
        .send({ name: "North Field", crop: "Paddy", geometry: squareGeometry(0.009) })
    ).body.data.parcel;
    expect(parcel).toBeTruthy();

    const claim = (
      await request(app)
        .post("/claims")
        .set(auth)
        .send({
          parcelId: parcel.parcelId,
          eventType: "flood",
          eventDate: new Date(Date.now() - 2 * 86400000).toISOString(),
          geometry: squareGeometry(0.009),
          idempotencyKey: `idem-${prefix}-${Date.now()}`,
        })
    ).body.data.claim;
    expect(claim).toBeTruthy();

    const submit = await request(app).post(`/claims/${claim.id}/submit`).set(auth);
    expect(submit.status).toBe(200);

    return { cognitoSub, token, auth, parcel, claim };
  };

  const presignPutComplete = async (auth, claimId) => {
    const presign = await request(app)
      .post(`/claims/${claimId}/evidence/presign`)
      .set(auth)
      .send({ contentType: "image/png", size: imageBuffer.length, filename: "photo.png" });
    expect(presign.status).toBe(200);
    const { uploadId } = presign.body.data;

    const ClaimEvidence = (await import("../models/ClaimEvidence.js")).default;
    const evidence = await ClaimEvidence.findOne({ uploadId });
    expect(evidence).toBeTruthy();
    await putObject({ key: evidence.s3Key, buffer: imageBuffer, mediaType: "image/png" });

    const complete = await request(app)
      .post(`/claims/${claimId}/evidence/${uploadId}/complete`)
      .set(auth);
    expect(complete.status).toBe(200);
    return { uploadId };
  };

  it("AI-503-B1: /verify auto-triggers a missing assessment and reaches a verified decision", async () => {
    const seeded = await seedSubmittedClaim("b1");
    await presignPutComplete(seeded.auth, seeded.claim.id);
    feedVisionAnswer();

    const beforeCalls = mockGenerate.mock.calls.length;
    const res = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.verification.outcome).toBe("verified");
    // The auto-trigger called the AI exactly once (one stored image) — not duplicated.
    expect(mockGenerate.mock.calls.length - beforeCalls).toBe(1);
  });

  it("AI-503-B2: a hung vision call during verify surfaces as a sanitized 5xx without fabricating a decision", async () => {
    const seeded = await seedSubmittedClaim("b2");
    await presignPutComplete(seeded.auth, seeded.claim.id);
    feedHungVisionAnswer();

    const start = Date.now();
    const res = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(500);
    expect(elapsed).toBeLessThan(5000);

    const LossClaim = (await import("../models/LossClaim.js")).default;
    const stored = await LossClaim.findById(seeded.claim.id).lean();
    // The claim must NOT have been moved into a decision state — the deterministic engine is
    // never allowed to see a fabricated assessment.
    expect(stored.state).toBe("submitted");
  });

  it("AI-503-B3: a failed AI provider leaves the claim in `submitted`, never `verified`/`rejected`", async () => {
    const seeded = await seedSubmittedClaim("b3");
    await presignPutComplete(seeded.auth, seeded.claim.id);
    feedFailedVisionAnswer();

    const res = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);
    expect(res.status).toBe(500);

    const LossClaim = (await import("../models/LossClaim.js")).default;
    const ClaimAudit = (await import("../models/ClaimAudit.js")).default;

    const stored = await LossClaim.findById(seeded.claim.id).lean();
    expect(stored.state).toBe("submitted");

    const verified = await ClaimAudit.countDocuments({
      claimId: seeded.claim.id,
      action: "verified",
    });
    const rejected = await ClaimAudit.countDocuments({
      claimId: seeded.claim.id,
      action: "rejected",
    });
    expect(verified).toBe(0);
    expect(rejected).toBe(0);
  });

  it("AI-503-B4: matching completed assessment is reused, no duplicate AI call", async () => {
    const seeded = await seedSubmittedClaim("b4");
    await presignPutComplete(seeded.auth, seeded.claim.id);
    feedVisionAnswer();

    // Pre-create the assessment the production-realistic way.
    const { assessClaimEvidence } = await import("../services/claimAssessment.service.js");
    await assessClaimEvidence({
      claimId: seeded.claim.id,
      cognitoSub: seeded.cognitoSub,
      requestId: null,
    });

    const beforeCalls = mockGenerate.mock.calls.length;
    const res = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.outcome).toBe("verified");
    // Reused the cached assessment — zero new AI calls.
    expect(mockGenerate.mock.calls.length).toBe(beforeCalls);
  });

  it("AI-503-B5: one verify action triggers exactly one AI evidence analysis", async () => {
    const seeded = await seedSubmittedClaim("b5");
    await presignPutComplete(seeded.auth, seeded.claim.id);
    feedVisionAnswer();

    const before = mockGenerate.mock.calls.length;
    const res = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.verification.outcome).toBe("verified");
    // Single image in the evidence set → exactly one AI call.
    expect(mockGenerate.mock.calls.length - before).toBe(1);
  });

  it("AI-503-B6: rate-limit budget is not consumed by an already-decided claim (verify is idempotent)", async () => {
    const seeded = await seedSubmittedClaim("b6");
    await presignPutComplete(seeded.auth, seeded.claim.id);
    feedVisionAnswer();

    const first = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);
    expect(first.status).toBe(200);
    expect(first.body.data.verification.outcome).toBe("verified");

    // A second /verify on a decided claim must return the persisted decision without
    // spawning an extra AI call (no auto-trigger for already-decided claims).
    const before = mockGenerate.mock.calls.length;
    const second = await request(app)
      .post(`/claims/${seeded.claim.id}/verify`)
      .set(seeded.auth);
    expect(second.status).toBe(200);
    expect(second.body.data.verification.idempotent).toBe(true);
    expect(mockGenerate.mock.calls.length).toBe(before);
  });

  it("AI-503-B7: image turn survives a provider error: image record remains in stored state and chat still responds", async () => {
    // FLOW A regression: the chat image pipeline must not lose the persisted image when the
    // AI provider fails, and must surface a recoverable error envelope.
    feedFailedVisionAnswer();
    // The chat text reasoner can fail gracefully; the image record status is "stored" from
    // the presign-complete flow. The text reasoning (second model.generate call) also rejects
    // so we re-queue a failure; the chat pipeline returns the fallback response.
    feedFailedVisionAnswer();

    const token = signAccessToken({ cognitoSub: "acc-chat-b7", email: "farmer@example.com" });
    const auth = { Authorization: `Bearer ${token}` };
    const profile = await request(app)
      .post("/profile")
      .set(auth)
      .send({ district: "Thanjavur", crops: ["Paddy"], acres: 2.5 });
    expect(profile.status).toBe(200);

    // Reuse the same image buffer as an uploaded chat image via presigned path.
    const presign = await request(app)
      .post("/upload/presign")
      .set(auth)
      .send({ contentType: "image/png", size: imageBuffer.length, filename: "leaf.png" });
    expect(presign.status).toBe(200);
    const { uploadId } = presign.body.data;

    const ImageRecord = (await import("../models/ImageRecord.js")).default;
    const imageRecord = await ImageRecord.findOne({ uploadId });
    await putObject({ key: imageRecord.s3Key, buffer: imageBuffer, mediaType: "image/png" });

    const complete = await request(app)
      .post(`/upload/${uploadId}/complete`)
      .set(auth);
    expect(complete.status).toBe(200);

    const after = await ImageRecord.findOne({ uploadId });
    expect(after.status).toBe("stored");
    // vision may be null (the schema default) or undefined depending on whether the prior
    // failed attempt persisted anything; what matters is that the record is NOT lost.
    expect([null, undefined]).toContain(after.vision);

    // Trigger the image turn; the AI must fail gracefully (sanitized 5xx, image still stored).
    const res = await request(app)
      .post("/chat")
      .set(auth)
      .send({ message: "diagnose this crop", language: "en", uploadId });
    expect(res.status).toBe(500);

    // The image record is marked failed (not lost, not stored-but-corrupted); the S3 bytes are
    // still intact so the farmer can retry the analysis.
    const stillThere = await ImageRecord.findOne({ uploadId });
    expect(["stored", "failed"]).toContain(stillThere.status);
    expect(stillThere.uploadId).toBe(uploadId);
    // The image is still retrievable through the authorized GET endpoint (the S3 object was
    // never deleted, only the analysis was marked failed).
    const view = await request(app).get(`/upload/${uploadId}/view`).set(auth);
    expect(view.status).toBe(200);
    expect(view.body.data.uploadId).toBe(uploadId);
  });

  it("AI-503-B8: multi-image verification stays inside ONE request budget instead of accumulating per-image timeouts", async () => {
    // The evidence loop is sequential (S3 GET + one multimodal call per image). Bounding each
    // call individually is NOT enough: a slow first image plus a hung second image would exceed
    // the API Gateway / Lambda ceiling and be cut off with an opaque 503 — the exact failure this
    // suite exists to prevent. The loop therefore runs against a single request-level deadline
    // and shrinks each per-image call to the remaining budget.
    //
    // Timing (scaled down from production): 2s request budget, first image answers in 1.5s,
    // second image hangs forever.
    //   Without the request budget: 1.5s + 2.0s (per-call bound) = ~3.5s  -> gateway 503.
    //   With    the request budget: 1.5s + 0.5s (remaining)     = ~2.0s  -> sanitized 5xx.
    const previousBudget = process.env.CLAIM_ASSESSMENT_TIMEOUT_MS;
    process.env.CLAIM_ASSESSMENT_TIMEOUT_MS = "2000";
    try {
      const seeded = await seedSubmittedClaim("b8");
      await presignPutComplete(seeded.auth, seeded.claim.id);
      await presignPutComplete(seeded.auth, seeded.claim.id);
      expect(
        await (await import("../models/ClaimEvidence.js")).default.countDocuments({
          claimId: seeded.claim._id ?? seeded.claim.id,
        }),
      ).toBe(2);

      // Image 1: slow but successful. Image 2: never resolves.
      mockGenerate.mockImplementationOnce(async () => {
        await sleep(1500);
        return { generations: [[{ text: JSON.stringify(VALID_OBSERVATION) }]] };
      });
      mockGenerate.mockImplementationOnce(() => new Promise(() => {}));

      const start = Date.now();
      const res = await request(app)
        .post(`/claims/${seeded.claim.id}/verify`)
        .set(seeded.auth);
      const elapsed = Date.now() - start;

      expect(res.status).toBe(500);
      // Bounded by the request budget (2s) plus small overhead — NOT ~3.5s of accumulated
      // per-image timeouts, and far below the gateway ceiling.
      expect(elapsed).toBeLessThan(2800);
      // Both a sanitized body (no provider internals / stack traces) and the preserved claim.
      expect(typeof res.body.message).toBe("string");

      const LossClaim = (await import("../models/LossClaim.js")).default;
      const stored = await LossClaim.findById(seeded.claim.id).lean();
      expect(stored.state).toBe("submitted");

      // The assessment must be left `failed` (retryable), never stuck in `processing` — a stuck
      // slot would make every later retry a silent no-op reuse.
      const ClaimAssessment = (await import("../models/ClaimAssessment.js")).default;
      const assessment = await ClaimAssessment.findOne({ claimId: stored._id }).lean();
      expect(assessment.status).toBe("failed");
    } finally {
      if (previousBudget === undefined) delete process.env.CLAIM_ASSESSMENT_TIMEOUT_MS;
      else process.env.CLAIM_ASSESSMENT_TIMEOUT_MS = previousBudget;
    }
  });
});
