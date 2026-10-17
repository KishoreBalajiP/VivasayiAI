import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A11, AZ) — an authorisation sweep over EVERY claim route (/claims/:id/*, including
// /progress) and EVERY admin route. Another farmer gets 404 (the claim does not exist for them), a
// farmer on an admin route gets 403, an anonymous caller 401 — and none of those requests changes
// anything: no job attempt, no runAt, no audit row, no evidence, no model or executor call. Automated
// verification and drain-on-read are ON, so a read that drained before checking ownership would show.
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

import claimRoutes from "../routes/claims.js";
import adminRoutes from "../routes/admin.js";
import ImageRecord from "../models/ImageRecord.js";
import VerificationJob from "../models/VerificationJob.js";
import { putObject } from "../services/s3.service.js";
import { setExecutor } from "../services/verificationJobs.service.js";
import { api, authHeader, startTestDatabase, stopTestDatabase } from "./helpers.js";
import { OBSERVATIONS, PNG, attachDocument, createClaim, modelAnswer, resetDatabase, seedFarmer, sideEffectSnapshot, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const STEPS = ["ai_assessment", "land_documents", "official_land_record", "satellite", "weather", "engine"];
const routeList = (router) =>
  router.stack.filter((layer) => layer.route).flatMap((layer) => Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`));

// Every claim-scoped and admin route, with a request that would succeed for the right caller.
const claimRouteTable = ({ claimId, uploadId, documentId, intruderUploadId }) => [
  { route: "GET /:claimId", path: `/claims/${claimId}` },
  { route: "GET /:claimId/verification", path: `/claims/${claimId}/verification` },
  { route: "GET /:claimId/progress", path: `/claims/${claimId}/progress` },
  { route: "GET /:claimId/appeal", path: `/claims/${claimId}/appeal` },
  { route: "GET /:claimId/ownership", path: `/claims/${claimId}/ownership` },
  { route: "GET /:claimId/evidence/:evidenceId/url", path: `/claims/${claimId}/evidence/${uploadId}/url` },
  { route: "GET /:claimId/ownership/:evidenceId/url", path: `/claims/${claimId}/ownership/${documentId}/url` },
  { route: "POST /:claimId/submit", path: `/claims/${claimId}/submit` },
  { route: "POST /:claimId/withdraw", path: `/claims/${claimId}/withdraw` },
  { route: "POST /:claimId/resubmit", path: `/claims/${claimId}/resubmit` },
  { route: "POST /:claimId/verify", path: `/claims/${claimId}/verify`, body: {} },
  { route: "POST /:claimId/appeal", path: `/claims/${claimId}/appeal`, body: { reason: "The decision does not match my field at all." } },
  { route: "POST /:claimId/evidence/presign", path: `/claims/${claimId}/evidence/presign`, body: { contentType: "image/png", size: PNG.length, filename: "x.png" } },
  { route: "POST /:claimId/evidence/:evidenceId/complete", path: `/claims/${claimId}/evidence/${uploadId}/complete` },
  { route: "DELETE /:claimId/evidence/:evidenceId", path: `/claims/${claimId}/evidence/${uploadId}` },
  { route: "POST /:claimId/ownership", path: `/claims/${claimId}/ownership`, body: { uploadId: intruderUploadId, documentCategory: "land_record" } },
  { route: "POST /:claimId/verification/land-documents", path: `/claims/${claimId}/verification/land-documents` },
  { route: "POST /:claimId/verification/satellite", path: `/claims/${claimId}/verification/satellite` },
  { route: "POST /:claimId/verification/official-land-record", path: `/claims/${claimId}/verification/official-land-record` },
];
const adminRouteTable = ({ claimId, documentId, reviewCaseId }) => [
  { route: "GET /claims", path: "/admin/claims" },
  { route: "GET /claims/:claimId", path: `/admin/claims/${claimId}` },
  { route: "POST /claims/:claimId/override", path: `/admin/claims/${claimId}/override`, body: { toState: "verified", reason: "Approve this claim for me please" } },
  { route: "GET /claims/:claimId/ownership", path: `/admin/claims/${claimId}/ownership` },
  { route: "POST /claims/:claimId/ownership/:evidenceId/review", path: `/admin/claims/${claimId}/ownership/${documentId}/review`, body: { status: "AVAILABLE", reason: "Looks fine to me, accept it" } },
  { route: "GET /claims/:claimId/review-cases", path: `/admin/claims/${claimId}/review-cases` },
  { route: "POST /claims/:claimId/review-cases/:evidenceId/decision", path: `/admin/claims/${claimId}/review-cases/${reviewCaseId}/decision`, body: { decision: "AVAILABLE", reason: "Resolve this case as accepted" } },
  { route: "GET /claims/:claimId/verification-diagnostics", path: `/admin/claims/${claimId}/verification-diagnostics` },
  { route: "POST /claims/:claimId/jobs/requeue", path: `/admin/claims/${claimId}/jobs/requeue`, body: { reason: "Requeue everything for my claim" } },
  { route: "GET /dashboard", path: "/admin/dashboard" },
  { route: "GET /investigation", path: "/admin/investigation" },
];
const send = (entry, headers = {}) => {
  const [method] = entry.route.split(" ");
  let request = api()[method.toLowerCase()](entry.path);
  for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
  return entry.body ? request.send(entry.body) : request;
};

describe("authorisation sweep over every claim and admin route (AZ)", () => {
  let mongo;
  const calls = [];
  let owner;
  let intruder;
  let ids;
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    calls.length = 0;
    mocks.generate.mockReset();
    mocks.generate.mockResolvedValue(modelAnswer(OBSERVATIONS.damage));
    for (const step of STEPS) setExecutor(step, async (job) => { calls.push(`${step}:${String(job.claimId)}`); return { fake: step }; });

    // The owner's submitted claim: a photo, a land document, a due plan, and a review case.
    const farmer = await seedFarmer("az-owner");
    const claimId = await createClaim(farmer);
    const uploadId = await uploadPhoto(farmer.user, claimId);
    const documentId = await attachDocument(farmer.user, claimId, "land_record");
    await submitClaim(farmer.user, claimId);
    const { createReviewCase } = await import("../services/manualReview.service.js");
    const reviewCase = await createReviewCase({ claimId, cognitoSub: farmer.user, source: "AI_IMAGE", reasons: ["ai_no_damage_needs_review"], metadata: { component: "manual_review" } });
    owner = { ...farmer, claimId };
    // The intruder: a farmer with a profile, a parcel and an upload of their own.
    intruder = await seedFarmer("az-intruder");
    const presign = await api().post("/upload/presign").set(authHeader(intruder.user)).send({ contentType: "image/png", size: PNG.length, filename: "doc.png" });
    const intruderUploadId = presign.body.data.uploadId;
    await putObject({ key: (await ImageRecord.findOne({ uploadId: intruderUploadId })).s3Key, buffer: PNG, mediaType: "image/png" });
    await api().post(`/upload/${intruderUploadId}/complete`).set(authHeader(intruder.user));
    ids = { claimId, uploadId, documentId, intruderUploadId, reviewCaseId: String(reviewCase._id) };
    expect(await VerificationJob.countDocuments({ claimId, status: "queued", runAt: { $lte: new Date() } })).toBeGreaterThan(0);
  });

  const expectNothingHappened = async (before, label) => {
    expect(await sideEffectSnapshot(owner.claimId), label).toEqual(before);
    expect(calls, label).toEqual([]);
    expect(mocks.generate, label).not.toHaveBeenCalled();
  };

  it("AZ-1: another farmer reading any of the claim's routes (claim, verification, progress, appeal, documents, signed URLs) gets 404 and drains nothing", async () => {
    const before = await sideEffectSnapshot(owner.claimId);
    const reads = claimRouteTable(ids).filter((entry) => entry.route.startsWith("GET"));
    expect(reads).toHaveLength(7);
    for (const entry of reads) {
      const response = await send(entry, authHeader(intruder.user));
      expect(response.status, entry.route).toBe(404);
      const text = JSON.stringify(response.body);
      expect(text, entry.route).not.toContain(owner.user);
      expect(text, entry.route).not.toContain(ids.uploadId);
    }
    const list = await api().get("/claims").set(authHeader(intruder.user));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(owner.claimId);
    await expectNothingHappened(before, "reads");
  });

  it("AZ-2: another farmer calling any of the claim's mutating routes (lifecycle, verify, appeal, evidence, documents, manual checks) gets 404 and changes nothing", async () => {
    const before = await sideEffectSnapshot(owner.claimId);
    const writes = claimRouteTable(ids).filter((entry) => !entry.route.startsWith("GET"));
    expect(writes).toHaveLength(12);
    for (const entry of writes) {
      const response = await send(entry, authHeader(intruder.user));
      expect(response.status, entry.route).toBe(404);
    }
    await expectNothingHappened(before, "writes");
    // The intruder's own upload was not attached anywhere either.
    expect((await ImageRecord.findOne({ uploadId: ids.intruderUploadId }).lean()).status).not.toBe("attached");
  });

  it("AZ-3: a farmer — even the claim's owner — calling any admin route gets 403 and changes nothing", async () => {
    const before = await sideEffectSnapshot(owner.claimId);
    for (const entry of adminRouteTable(ids)) {
      for (const user of [owner.user, intruder.user]) {
        const response = await send(entry, authHeader(user));
        expect(response.status, `${entry.route} as ${user}`).toBe(403);
      }
    }
    await expectNothingHappened(before, "admin");
  });

  it("AZ-4: an anonymous caller gets 401 everywhere, and the sweep covers every claim and admin route that exists", async () => {
    const before = await sideEffectSnapshot(owner.claimId);
    const claimTable = claimRouteTable(ids);
    const adminTable = adminRouteTable(ids);
    for (const entry of [...claimTable, ...adminTable]) {
      const response = await send(entry);
      expect(response.status, entry.route).toBe(401);
    }
    await expectNothingHappened(before, "anonymous");

    // A route added later without an entry here fails this test.
    const claimScoped = routeList(claimRoutes).filter((route) => route.includes(":claimId"));
    expect(claimTable.map((entry) => entry.route).sort()).toEqual(claimScoped.sort());
    expect(adminTable.map((entry) => entry.route).sort()).toEqual(routeList(adminRoutes).sort());
  });
});
