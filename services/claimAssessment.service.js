import crypto from "node:crypto";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import LossClaim from "../models/LossClaim.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import * as s3Service from "./s3.service.js";
import { analyzeClaimImage } from "./claimVision.service.js";
import {
  CLAIM_LOSS_ASSESSMENT_VERSION,
  CLAIM_LOSS_OBSERVATION_FIELDS,
} from "../src/ai/ClaimLossVisionTemplates.js";
import AIConfig from "../src/ai/AIConfig.js";

// E9-S4 (ADR-019) — Claim Evidence AI Assessment (internal service, NO public endpoint; §18).
//
// Invoked by the future Claim Verification Engine (E9-S5) or directly (tests). It:
//   - is claim/owner scoped: only claim-owned evidence in an allowed usable state ("stored")
//     ever reaches the vision stage; foreign claims/evidence → 404; no client-supplied URLs,
//     S3 keys, cognitoSub, or claim state are ever accepted (the service reads only its frozen
//     { claimId, cognitoSub, requestId } signature);
//   - is idempotent + concurrency-safe: a unique `claimassessment` row per claim, guarded by an
//     atomic status CAS (pending/failed → processing); concurrent requests reuse the running or
//     completed assessment and never spawn a duplicate analysis run;
//   - persists ONLY the AI-evidence stage (status/version/model/evidenceVersion/aiImageAssessments/
//     aiAggregate). It NEVER writes the decision fields and NEVER transitions the claim state;
//   - is auditable: appends `ai_completed` / `assessment_failed` rows to `claimaudit` (actor
//     "engine"), metadata never contains s3Key/bucket/owner/prompt/URLs/image content;
//   - is retry-safe: failures are persisted as `status: "failed"` (retryable) and surfaced as
//     sanitized ApiError envelopes (no provider/Mongo/S3 internals).
//
// The AI aggregate is deterministic (documented rules): damageDetected = any true; damageType /
// severity = most frequent across images (severity tie → more severe); confidence = most
// conservative; uncertain = any image uncertain or unknown damage; inconsistencies = the UNION of
// per-image notes plus deterministic cross-image conflicts (different crop / conflicting damage /
// different damage type / different severity). VisibleAffectedPortion and severity stay
// QUALITATIVE — no severity→acreage conversion exists anywhere in this codebase (P4).

const ALLOWED_EVIDENCE_STATUS = ["stored"]; // usable state after the presign→store lifecycle

// Conservative ordering used only to pick an aggregate value, never to derive area/amounts.
const SEVERITY_RANK = { minor: 1, moderate: 2, severe: 3 };
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1, unclear: 0, unknown: 0 };

// Persistence-boundary guardrail: even if an adapter output ever slipped past claimVision's
// normalizer, only the FROZEN whitelist fields may reach MongoDB. Unknown fields (including
// acreage/polygon/compensation/approval/status keys) are structurally impossible to persist.
const scrubObservation = (observation) => {
  const out = {};
  for (const key of CLAIM_LOSS_OBSERVATION_FIELDS) {
    out[key] = observation && observation[key] !== undefined ? observation[key] : null;
  }
  out.uncertain = !observation || observation.uncertain === false ? false : true;
  out.inconsistencies = Array.isArray(out.inconsistencies) ? out.inconsistencies : [];
  return out;
};

const computeEvidenceVersion = (evidenceDocs) => {
  const parts = evidenceDocs
    .map((doc) => `${doc.uploadId}:${doc.updatedAt ? doc.updatedAt.getTime() : 0}`)
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(parts).digest("hex");
};

const pickByCount = (values, tieBreak) => {
  if (values.length === 0) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const value of values) {
    const count = counts.get(value);
    const tieWin = count === bestCount && tieBreak && tieBreak(value, best) > 0;
    if (count > bestCount || tieWin) {
      best = value;
      bestCount = count;
    }
  }
  return best;
};

const uniqueNonEmpty = (values) => Array.from(new Set(values.filter(Boolean)));

const buildAggregate = (images) => {
  const observations = images.map((image) => image.observation);
  const some = (pred) => observations.some(pred);

  const damageDetected =
    some((o) => o.damageDetected === true)
      ? true
      : observations.length > 0 && observations.every((o) => o.damageDetected === false)
        ? false
        : null;

  const damageTypes = observations
    .map((o) => (o.damageDetected === false ? null : o.damageType))
    .filter(Boolean);
  const severities = observations.map((o) => o.severity).filter(Boolean);

  const confidenceLevels = observations.map((o) => o.confidence || "unknown");
  const worstConfidence = confidenceLevels.reduce(
    (worst, level) =>
      CONFIDENCE_RANK[level] < CONFIDENCE_RANK[worst] ? level : worst,
    observations.length ? confidenceLevels[0] : "unclear"
  );

  const inconsistencies = [];
  if (uniqueNonEmpty(observations.map((o) => o.cropDetected)).length > 1) {
    inconsistencies.push("Different crops detected across evidence images");
  }
  if (some((o) => o.damageDetected === true) && some((o) => o.damageDetected === false)) {
    inconsistencies.push("Conflicting damage statuses across evidence images");
  }
  if (uniqueNonEmpty(damageTypes).length > 1) {
    inconsistencies.push("Different damage types reported across evidence images");
  }
  if (uniqueNonEmpty(severities).length > 1) {
    inconsistencies.push("Different severity levels reported across evidence images");
  }

  return {
    damageDetected,
    damageType: pickByCount(damageTypes),
    severity: pickByCount(severities, (a, b) => (SEVERITY_RANK[a] || 0) - (SEVERITY_RANK[b] || 0)),
    confidence: worstConfidence,
    uncertain: some((o) => o.uncertain === true) || damageDetected === null,
    inconsistencies,
    imageCount: observations.length,
  };
};

const serialize = (doc) => ({
  claimId: doc.claimId,
  status: doc.status,
  version: doc.version,
  model: doc.model,
  evidenceVersion: doc.evidenceVersion,
  aiAggregate: doc.aiAggregate || null,
  assessments: (doc.aiImageAssessments || []).map((image) => ({
    evidenceId: image.evidenceId,
    uploadId: image.uploadId,
    observation: image.observation,
  })),
  imageCount: (doc.aiAggregate && doc.aiAggregate.imageCount) || 0,
  uncertain: (doc.aiAggregate && doc.aiAggregate.uncertain) ?? null,
  error: doc.error || null,
  startedAt: doc.startedAt,
  completedAt: doc.completedAt,
  failedAt: doc.failedAt,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

// Atomic slot acquisition. Exactly one worker proceeds per claim (unique claimId + status CAS).
// Returns { assessment, proceed }: `proceed: true` means THIS caller owns the slot and must run the
// pipeline; `proceed: false` means an in-flight/reused/completed assessment is returned as-is so
// concurrent requests never spawn a duplicate analysis run.
const acquireProcessingSlot = async (claimId, fingerprint) => {
  const existing = await ClaimAssessment.findOne({ claimId });

  if (!existing) {
    try {
      return {
        assessment: await ClaimAssessment.create({
          claimId,
          status: "processing",
          version: CLAIM_LOSS_ASSESSMENT_VERSION,
          model: `${AIConfig.provider}/${AIConfig.model}`,
          evidenceVersion: fingerprint,
          startedAt: new Date(),
        }),
        proceed: true,
      };
    } catch (error) {
      if (error?.code === 11000) {
        return acquireProcessingSlot(claimId, fingerprint); // concurrent create — re-enter
      }
      throw error;
    }
  }

  if (existing.status === "processing") {
    return { assessment: existing, proceed: false }; // concurrent in-flight request → reuse
  }
  if (existing.status === "completed" && existing.evidenceVersion === fingerprint) {
    return { assessment: existing, proceed: false }; // same version/evidence set → reuse
  }

  // pending / failed → take the slot; completed-with-different-evidence is handled below.
  const slot = await ClaimAssessment.findOneAndUpdate(
    { claimId, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "processing",
        version: CLAIM_LOSS_ASSESSMENT_VERSION,
        model: `${AIConfig.provider}/${AIConfig.model}`,
        evidenceVersion: fingerprint,
        error: null,
        failedAt: null,
        startedAt: new Date(),
      },
    },
    { new: true }
  );
  if (slot) return { assessment: slot, proceed: true };

  if (existing.status === "completed") {
    // Evidence set changed since completion → re-assess (new version boundary, same record).
    const restarted = await ClaimAssessment.findOneAndUpdate(
      { claimId, status: "completed" },
      {
        $set: {
          status: "processing",
          evidenceVersion: fingerprint,
          error: null,
          failedAt: null,
          startedAt: new Date(),
        },
      },
      { new: true }
    );
    if (restarted) return { assessment: restarted, proceed: true };
  }

  // Raced by another worker → return current state without running.
  return { assessment: await ClaimAssessment.findOne({ claimId }), proceed: false };
};

const failAssessment = async ({ claimId, version, stage, message, requestId }) => {
  await ClaimAssessment.updateOne(
    { claimId },
    { $set: { status: "failed", failedAt: new Date(), error: { stage, message } } }
  );
  await ClaimAudit.create({
    claimId,
    actor: "engine",
    action: "assessment_failed",
    reason: null,
    metadata: { stage, version: version || CLAIM_LOSS_ASSESSMENT_VERSION },
    requestId: requestId || null,
  });
  throw ApiError.internal(message);
};

const processImagesAndFinish = async ({ claimId, evidenceDocs, fingerprint, version, requestId }) => {
  const images = [];

  try {
    for (const evidence of evidenceDocs) {
      let object;
      try {
        object = await s3Service.getObject(evidence.s3Key);
      } catch (error) {
        logger.warn({ claimId, uploadId: evidence.uploadId }, "Assessment storage fetch failed");
        return failAssessment({
          claimId,
          version,
          stage: "storage",
          message: "Image storage unavailable",
          requestId,
        });
      }
      if (!object) {
        return failAssessment({
          claimId,
          version,
          stage: "storage",
          message: "Image storage unavailable",
          requestId,
        });
      }
      const observation = await analyzeClaimImage({
        imageBuffer: object.buffer,
        mediaType: object.mediaType || evidence.mediaType,
      });
      images.push({
        evidenceId: evidence._id,
        uploadId: evidence.uploadId,
        observation: scrubObservation(observation),
      });
    }

    const aggregate = buildAggregate(images);

    await ClaimAssessment.updateOne(
      { claimId },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          aiImageAssessments: images,
          aiAggregate: aggregate,
          error: null,
        },
      }
    );

    await ClaimAudit.create({
      claimId,
      actor: "engine",
      action: "ai_completed",
      reason: null,
      metadata: {
        version: version || CLAIM_LOSS_ASSESSMENT_VERSION,
        evidenceVersion: fingerprint,
        imageCount: images.length,
        uncertain: aggregate.uncertain,
      },
      requestId: requestId || null,
    });

    const completed = await ClaimAssessment.findOne({ claimId });
    return serialize(completed);
  } catch (error) {
    if (error instanceof ApiError) {
      return failAssessment({
        claimId,
        version,
        stage: "provider",
        message: error.message,
        requestId,
      });
    }
    logger.error({ err: error, claimId }, "Claim evidence assessment failed");
    return failAssessment({
      claimId,
      version,
      stage: "provider",
      message: "Claim evidence assessment failed",
      requestId,
    });
  }
};

// Internal assessment entry point. Only { claimId, cognitoSub, requestId } are read — any other
// supplied data (imageUrl, s3Key, body fields, claim state) is structurally ignored.
export const assessClaimEvidence = async ({ claimId, cognitoSub, requestId }) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) {
    throw ApiError.badRequest("Valid claim id is required");
  }
  if (!cognitoSub || typeof cognitoSub !== "string") {
    throw ApiError.unauthorized("Authentication required");
  }

  const claim = await LossClaim.findById(String(claimId));
  if (!claim || claim.cognitoSub !== cognitoSub) {
    throw ApiError.notFound("Claim not found"); // IDOR-safe: foreign claims resolve to 404
  }

  const evidenceDocs = await ClaimEvidence.find({
    claimId: claim._id,
    status: { $in: ALLOWED_EVIDENCE_STATUS },
  })
    .sort({ uploadedAt: 1 })
    .lean();

  if (evidenceDocs.length === 0) {
    throw ApiError.badRequest("No stored evidence to assess");
  }

  const fingerprint = computeEvidenceVersion(evidenceDocs);
  const { assessment, proceed } = await acquireProcessingSlot(claim._id, fingerprint);

  if (!proceed) {
    return serialize(assessment); // already running or reused completed assessment
  }

  return processImagesAndFinish({
    claimId: claim._id,
    evidenceDocs,
    fingerprint,
    version: assessment.version,
    requestId,
  });
};

export default { assessClaimEvidence };