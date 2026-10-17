import { expect } from "vitest";
import LossClaim from "../../models/LossClaim.js";
import ClaimEvidence from "../../models/ClaimEvidence.js";
import ClaimAssessment from "../../models/ClaimAssessment.js";
import ClaimAudit from "../../models/ClaimAudit.js";
import ImageRecord from "../../models/ImageRecord.js";
import VerificationEvidence from "../../models/VerificationEvidence.js";
import VerificationJob from "../../models/VerificationJob.js";
import AdminAction from "../../models/AdminAction.js";
import Appeal from "../../models/Appeal.js";
import { putObject } from "../../services/s3.service.js";
import { drain, setExecutor } from "../../services/verificationJobs.service.js";
import { recordEvidenceRun } from "../../services/verificationEvidence.service.js";
import { api, authHeader, clearTestDatabase, seedProfile, squareGeometry } from "../helpers.js";

// Shared API-level claim flow for the ADR-022 suites (progress, leak fix, verify, authz, decision
// consistency, worker). Everything goes through the real HTTP API and the real queue; only the model
// (vi.mock in each suite) and the supporting satellite/weather providers (fakeSupportingExecutors) are
// replaced, so no test reaches a network provider.

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
export const DAY_MS = 86400000;
export const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

// Model answers (claim vision JSON contract).
export const OBSERVATIONS = Object.freeze({
  damage: {
    cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate",
    visibleAffectedPortion: "lower portion of the visible field shows standing water", confidence: "high", uncertain: false,
    inconsistencies: [], observations: ["standing water in the furrows"], imageQuality: "good",
  },
  no_damage: {
    cropDetected: "rice", damageDetected: false, damageType: null, severity: null,
    visibleAffectedPortion: null, confidence: "high", uncertain: false,
    inconsistencies: [], observations: ["healthy green canopy"], imageQuality: "good",
  },
  uncertain: {
    cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate",
    visibleAffectedPortion: "unclear", confidence: "low", uncertain: true,
    inconsistencies: ["image too dark to judge"], observations: [], imageQuality: "fair",
  },
});
export const LAND_RECORD_EXTRACTION = {
  documentType: "land_record", issuingAuthority: "Revenue Department", recordNumber: "R-77", state: "Tamil Nadu", district: "Thanjavur",
  taluk: "Papanasam", village: "Ammapettai", surveyNumber: "123/4A", subdivisionNumber: "2", holderNames: ["Murugan"],
  parcelExtent: 1.2, extentUnit: "acre", documentDate: "2024-03-01", additionalIdentifiers: [], unreadable: false, language: "ta",
  confidence: "high", imageQuality: "good", uncertainFields: [],
};
export const modelAnswer = (value) => ({ generations: [[{ text: typeof value === "string" ? value : JSON.stringify(value) }]] });
export const providerFailure = (status) => Object.assign(new Error(`[${status}] provider refused the call`), { status });
// The text part of a model call: tells a land-document examination from a photo check.
export const promptOf = (args) => String(args?.[0]?.[0]?.[1]?.content?.[0]?.text || "");

export const ALL_MODELS = [LossClaim, ClaimEvidence, ClaimAssessment, ClaimAudit, ImageRecord, VerificationEvidence, VerificationJob, AdminAction, Appeal];
export const resetDatabase = async () => {
  await clearTestDatabase();
  for (const model of ALL_MODELS) await model.deleteMany({});
};

// Supporting evidence without a network: weather records an AVAILABLE rainfall row; satellite records
// what the real adapter records when imagery exists but processing is off (IMAGERY_FOUND / disabled).
// `calls` collects every executor call, so a suite can prove nothing ran.
export const fakeSupportingExecutors = (calls = []) => {
  setExecutor("weather", async (job) => {
    calls.push(`weather:${String(job.claimId)}`);
    await recordEvidenceRun({
      claimId: job.claimId, cognitoSub: job.cognitoSub, component: "weather", keyPrefix: "wx", inputFingerprint: `wx-${String(job.claimId)}`,
      source: "WEATHER", status: "AVAILABLE", provider: "open-meteo", observedAt: new Date(), evaluationVersion: "weather-archive-v1",
      metadata: { api: "archive" }, result: { rainfallTotalMm: 42, rainfallPeakMm: 30, daysWithRain: 2 },
    });
    return { status: "AVAILABLE" };
  });
  setExecutor("satellite", async (job) => {
    calls.push(`satellite:${String(job.claimId)}`);
    await recordEvidenceRun({
      claimId: job.claimId, cognitoSub: job.cognitoSub, component: "satellite", keyPrefix: "sat2", inputFingerprint: `sat-${String(job.claimId)}`,
      source: "SATELLITE", status: "PENDING", provider: "cdse-sentinel", evaluationVersion: "satellite-adapter-ndvi-v2",
      metadata: { outcome: "IMAGERY_FOUND", processingStatus: "disabled", analysisExecuted: false, sceneCount: 3 },
      result: { quality: "discovery_only", analyzed: false },
    });
    return { recorded: true, status: "PENDING" };
  });
  return calls;
};

let seq = 0;
export const nextUser = (label) => `flow-${label}-${(++seq).toString(36)}-${Date.now().toString(36)}`;

export const seedFarmer = async (label, { origin = [0, 0], parcelSize = 0.009 } = {}) => {
  const user = nextUser(label);
  expect((await seedProfile(user)).status).toBe(200);
  const parcel = await api().post("/profile/parcels").set(authHeader(user)).send({ name: "Field", crop: "Paddy", geometry: squareGeometry(parcelSize, origin) });
  expect(parcel.status).toBe(200);
  return { user, parcelId: parcel.body.data.parcel.parcelId };
};

export const createClaim = async (farmer, { geometry = squareGeometry(0.009), eventDaysAgo = 2, relationship = undefined, eventType = "flood" } = {}) => {
  const body = { parcelId: farmer.parcelId, eventType, eventDate: daysAgo(eventDaysAgo), geometry, idempotencyKey: `idem-flow-${++seq}-${Date.now().toString(36)}` };
  if (relationship) body.claimantRelationship = relationship;
  const created = await api().post("/claims").set(authHeader(farmer.user)).send(body);
  expect(created.status).toBe(200);
  return created.body.data.claim.id;
};

export const uploadPhoto = async (user, claimId) => {
  const presign = await api().post(`/claims/${claimId}/evidence/presign`).set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "photo.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  const evidence = await ClaimEvidence.findOne({ uploadId });
  await putObject({ key: evidence.s3Key, buffer: PNG, mediaType: "image/png" });
  const completed = await api().post(`/claims/${claimId}/evidence/${uploadId}/complete`).set(authHeader(user));
  expect(completed.status).toBe(200);
  return uploadId;
};

// Attach a stored private upload to the claim as a land document (the farmer's own API calls).
export const attachDocument = async (user, claimId, documentCategory = undefined) => {
  const presign = await api().post("/upload/presign").set(authHeader(user)).send({ contentType: "image/png", size: PNG.length, filename: "doc.png" });
  expect(presign.status).toBe(200);
  const { uploadId } = presign.body.data;
  await putObject({ key: (await ImageRecord.findOne({ uploadId })).s3Key, buffer: PNG, mediaType: "image/png" });
  expect((await api().post(`/upload/${uploadId}/complete`).set(authHeader(user))).status).toBe(200);
  const attached = await api().post(`/claims/${claimId}/ownership`).set(authHeader(user)).send(documentCategory ? { uploadId, documentCategory } : { uploadId });
  expect(attached.status).toBe(200);
  return attached.body.data.evidence.id;
};

export const submitClaim = async (user, claimId) => {
  const response = await api().post(`/claims/${claimId}/submit`).set(authHeader(user));
  expect(response.status).toBe(200);
  return response;
};

// Run the claim's queue the way the worker does, `stepMs` of fake time per batch, until no job is
// queued or running. Returns every job outcome in order.
export const runQueue = async (claimId = null, { rounds = 60, stepMs = 60_000, startAt = Date.now() } = {}) => {
  let clock = startAt;
  const outcomes = [];
  const filter = { status: { $in: ["queued", "running"] }, ...(claimId ? { claimId } : {}) };
  for (let i = 0; i < rounds; i += 1) {
    outcomes.push(...(await drain({ claimId, now: () => new Date(clock), maxJobs: 25 })));
    if ((await VerificationJob.countDocuments(filter)) === 0) return outcomes;
    clock += stepMs;
  }
  throw new Error(`queue did not settle: ${JSON.stringify(await VerificationJob.find(filter).select("step status runAt attempts").lean())}`);
};

// A snapshot of everything a request could change for a claim: job attempts/runAt/status, audits,
// evidence, appeals, admin actions, the claim and its assessment.
export const sideEffectSnapshot = async (claimId) => {
  const [claim, assessment, jobs, audits, evidence, photos, appeals, actions] = await Promise.all([
    LossClaim.findById(claimId).select("state submittedAt decidedAt submissionRound updatedAt").lean(),
    ClaimAssessment.findOne({ claimId }).select("status state updatedAt verification").lean(),
    VerificationJob.find({ claimId }).select("step status attempts runAt leaseOwner updatedAt").sort({ _id: 1 }).lean(),
    ClaimAudit.countDocuments({ claimId }),
    VerificationEvidence.find({ claimId }).select("status updatedAt").sort({ _id: 1 }).lean(),
    ClaimEvidence.find({ claimId }).select("status updatedAt").sort({ _id: 1 }).lean(),
    Appeal.countDocuments({ claimId }),
    AdminAction.countDocuments({ claimId }),
  ]);
  return JSON.parse(JSON.stringify({ claim, assessment, jobs, audits, evidence, photos, appeals, actions }));
};
