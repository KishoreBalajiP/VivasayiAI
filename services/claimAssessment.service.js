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
import { resolvePolicy } from "../config/verificationPolicy.js";
import { ProviderError, classifyProviderError, PROVIDER_ERROR_KINDS, PROVIDER_ERROR_CODES } from "../utils/providerErrors.js";
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
//     sanitized ApiError envelopes (no provider/Mongo/S3 internals). The envelope is a
//     ProviderError and the persisted `error` carries its `kind` and `code` (utils/providerErrors.js),
//     so the queue and the reviewer can tell a quota refusal from a defect.
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

// Fingerprint of an evidence set (`uploadId:updatedAt`, sorted) — the idempotency boundary shared
// by the assessment service (E9-S4) and the verification engine (E9-S5 recomputes it to confirm it
// is verifying the exact evidence set that was assessed). sha1 of the canonical string.
export const computeEvidenceVersion = (evidenceDocs) => {
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

// ADR-022 — budgets and the slot lease.
//   CLAIM_ASSESSMENT_PER_IMAGE_TIMEOUT_MS  the most one image's model call may take (default 25 s).
//   CLAIM_ASSESSMENT_TIMEOUT_MS            the whole loop's budget inside an HTTP request (default
//                                          25 s, see below); a queued job uses its own deadline.
//   CLAIM_ASSESSMENT_STALE_MS              a `processing` row written before slot leases existed
//                                          counts as abandoned this long after it started (10 min).
const getPerImageTimeoutMs = () => Number(process.env.CLAIM_ASSESSMENT_PER_IMAGE_TIMEOUT_MS) || 25000;
const getStaleAfterMs = () => Number(process.env.CLAIM_ASSESSMENT_STALE_MS) || 10 * 60 * 1000;
// A job does not start another image with less than this left before its deadline: it saves its
// progress and runs again instead of being cut off in the middle of a model call.
export const MIN_IMAGE_BUDGET_MS = 8000;
// The slot lease outlives one image's budget by this much (storage read, checkpoint write).
const SLOT_LEASE_SLACK_MS = 10_000;
const leaseAfter = (budgetMs, nowMs = Date.now()) => new Date(nowMs + budgetMs + SLOT_LEASE_SLACK_MS);
// "Released": the slot is free for the next caller, which resumes from the checkpoint.
const RELEASED_LEASE = new Date(0);

// Is the run that set this row to `processing` still alive?
const slotIsLive = (row, nowMs) => {
  if (row.slotLeaseUntil) return new Date(row.slotLeaseUntil).getTime() > nowMs;
  const started = row.startedAt ? new Date(row.startedAt).getTime() : 0;
  return started + getStaleAfterMs() > nowMs;
};

// Images assessed earlier for the SAME evidence set and prompt version (a checkpoint of a run that ran
// out of time, crashed or failed part-way): they are kept and not sent to the model again.
const resumableImages = (row, fingerprint) =>
  row && row.evidenceVersion === fingerprint && row.version === CLAIM_LOSS_ASSESSMENT_VERSION && Array.isArray(row.aiImageAssessments)
    ? row.aiImageAssessments.map((image) => (image.toObject ? image.toObject() : image))
    : [];

// Atomic slot acquisition. Exactly one worker proceeds per claim (unique claimId + status CAS).
// Returns { assessment, proceed, lease, resumeFrom }: `proceed: true` means THIS caller owns the slot
// (until `lease`, renewed after each image) and must run the pipeline, starting from `resumeFrom`;
// `proceed: false` means an in-flight/reused/completed assessment is returned as-is so concurrent
// requests never spawn a duplicate analysis run. A `processing` row whose lease lapsed (its run
// crashed or released the slot) is taken over by exactly one caller.
const acquireProcessingSlot = async (claimId, fingerprint) => {
  const nowMs = Date.now();
  const lease = leaseAfter(getPerImageTimeoutMs(), nowMs);
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
          startedAt: new Date(nowMs),
          slotLeaseUntil: lease,
        }),
        proceed: true,
        lease,
        resumeFrom: [],
      };
    } catch (error) {
      if (error?.code === 11000) {
        return acquireProcessingSlot(claimId, fingerprint); // concurrent create — re-enter
      }
      throw error;
    }
  }

  if (existing.status === "processing") {
    if (slotIsLive(existing, nowMs)) {
      return { assessment: existing, proceed: false }; // concurrent in-flight request → reuse
    }
    // Abandoned (or released) run: take it over. The filter is the lease we saw, so of several
    // callers exactly one wins.
    const resumeFrom = resumableImages(existing, fingerprint);
    const takeover = await ClaimAssessment.findOneAndUpdate(
      { claimId, status: "processing", slotLeaseUntil: existing.slotLeaseUntil ?? null },
      {
        $set: {
          version: CLAIM_LOSS_ASSESSMENT_VERSION,
          model: `${AIConfig.provider}/${AIConfig.model}`,
          evidenceVersion: fingerprint,
          aiImageAssessments: resumeFrom,
          error: null,
          failedAt: null,
          slotLeaseUntil: lease,
          ...(resumeFrom.length ? {} : { startedAt: new Date(nowMs) }),
        },
      },
      { new: true }
    );
    if (takeover) {
      logger.warn({ claimId: String(claimId), resumedImages: resumeFrom.length }, "assessment.slot_taken_over");
      return { assessment: takeover, proceed: true, lease, resumeFrom };
    }
    return { assessment: await ClaimAssessment.findOne({ claimId }), proceed: false };
  }
  if (existing.status === "completed" && existing.evidenceVersion === fingerprint) {
    return { assessment: existing, proceed: false }; // same version/evidence set → reuse
  }

  // pending / failed → take the slot; completed-with-different-evidence is handled below. A failed
  // run of the same evidence set keeps the images it finished.
  const resumeFrom = existing.status === "failed" ? resumableImages(existing, fingerprint) : [];
  const slot = await ClaimAssessment.findOneAndUpdate(
    { claimId, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "processing",
        version: CLAIM_LOSS_ASSESSMENT_VERSION,
        model: `${AIConfig.provider}/${AIConfig.model}`,
        evidenceVersion: fingerprint,
        aiImageAssessments: resumeFrom,
        error: null,
        failedAt: null,
        startedAt: new Date(nowMs),
        slotLeaseUntil: lease,
      },
    },
    { new: true }
  );
  if (slot) return { assessment: slot, proceed: true, lease, resumeFrom };

  if (existing.status === "completed") {
    // Evidence set changed since completion → re-assess (new version boundary, same record).
    const restarted = await ClaimAssessment.findOneAndUpdate(
      { claimId, status: "completed" },
      {
        $set: {
          status: "processing",
          evidenceVersion: fingerprint,
          aiImageAssessments: [],
          error: null,
          failedAt: null,
          startedAt: new Date(nowMs),
          slotLeaseUntil: lease,
        },
      },
      { new: true }
    );
    if (restarted) return { assessment: restarted, proceed: true, lease, resumeFrom: [] };
  }

  // Raced by another worker → return current state without running.
  return { assessment: await ClaimAssessment.findOne({ claimId }), proceed: false };
};

// `lease` (ADR-022): the slot lease this run holds. The failure is then only recorded while the run
// still owns the slot; a run that lost it to a takeover changes nothing and reports the current row.
const failAssessment = async ({ claimId, version, stage, message, requestId, kind = PROVIDER_ERROR_KINDS.DEFECT, lease = null }) => {
  const code = PROVIDER_ERROR_CODES[kind] || PROVIDER_ERROR_CODES.application_defect;
  const filter = lease ? { claimId, status: "processing", slotLeaseUntil: lease } : { claimId };
  const written = await ClaimAssessment.updateOne(
    filter,
    { $set: { status: "failed", failedAt: new Date(), error: { stage, message, kind, code }, slotLeaseUntil: null } }
  );
  if (lease && written.matchedCount === 0) {
    return { ...serialize(await ClaimAssessment.findOne({ claimId })), slotLost: true };
  }
  await ClaimAudit.create({
    claimId,
    actor: "engine",
    action: "assessment_failed",
    reason: null,
    metadata: { stage, version: version || CLAIM_LOSS_ASSESSMENT_VERSION, kind, code },
    requestId: requestId || null,
  });
  // Same sanitized 500 as before; the kind travels with it so the job's lastError records it.
  throw new ProviderError({ kind, operation: "claim.assessment", statusCode: 500, message });
};

// Policy v1.1-safe-ai treats an unreadable model answer as a provider failure (retried, then held
// for a person) instead of an "unsure" photo. Older policies keep the historical behaviour, and
// their call to the vision service is unchanged.
const visionOptionsForPolicy = () =>
  resolvePolicy().aiMalformedOutput === "unavailable" ? { onUnparseable: "throw" } : {};

// The evidence loop is SEQUENTIAL (one S3 GET + one multimodal Gemini call per image), so bounding
// each call individually is not enough inside an HTTP request: two slow images would still overrun
// the API Gateway / Lambda ceiling and be cut off with an opaque 503. In "request" mode the whole
// loop therefore runs against one request-level deadline that stays under that ceiling, and each
// per-image AI call is shrunk to whatever budget remains.
//
// Exceeding the budget is a REAL, retryable failure: it routes through the same `failAssessment`
// path as any provider error, so the assessment is marked `failed` (never left stuck in
// `processing`, which would make every later retry a no-op reuse) and the caller gets a sanitized
// 5xx instead of a gateway 503. The claim itself stays `submitted` and its evidence is untouched.
//
// "job" mode (ADR-022, the queue): every image gets its own budget (the per-image timeout, never more
// than what is left of the job's deadline), and progress is checkpointed after every image. When the
// deadline leaves too little for another image the run releases its slot with the checkpoint saved
// and returns `{ status: "processing", partial: true }`; the next run resumes after the last
// image assessed. Without a deadline only the per-image timeout applies.
const getAssessmentBudgetMs = () => Number(process.env.CLAIM_ASSESSMENT_TIMEOUT_MS) || 25000;

const processImagesAndFinish = async ({ claimId, evidenceDocs, fingerprint, version, requestId, lease: initialLease, resumeFrom = [], mode = "request", deadline = null }) => {
  const perImageMs = getPerImageTimeoutMs();
  const overallDeadline =
    mode === "job" ? (Number.isFinite(Number(deadline)) && deadline !== null ? Number(deadline) : null) : Date.now() + getAssessmentBudgetMs();
  const visionOptions = visionOptionsForPolicy();
  let lease = initialLease;
  const owned = () => (lease ? { claimId, status: "processing", slotLeaseUntil: lease } : { claimId });
  const lostSlot = async () => ({ ...serialize(await ClaimAssessment.findOne({ claimId })), slotLost: true });

  // Already assessed for this evidence set (same upload, same evidence row): kept, in evidence order.
  const done = new Map(resumeFrom.map((image) => [`${image.uploadId}:${String(image.evidenceId)}`, image]));
  const images = [];

  try {
    for (const evidence of evidenceDocs) {
      const prior = done.get(`${evidence.uploadId}:${String(evidence._id)}`);
      if (prior) {
        images.push(prior);
        continue;
      }

      const remainingMs = overallDeadline === null ? Number.POSITIVE_INFINITY : overallDeadline - Date.now();
      if (mode === "job" && remainingMs < MIN_IMAGE_BUDGET_MS) {
        // Out of time for another image: save the progress, free the slot and run again.
        const released = await ClaimAssessment.updateOne(owned(), { $set: { aiImageAssessments: images, slotLeaseUntil: RELEASED_LEASE } });
        if (lease && released.matchedCount === 0) return lostSlot();
        logger.info({ claimId: String(claimId), assessed: images.length, imageCount: evidenceDocs.length }, "assessment.partial_checkpoint");
        return { ...serialize(await ClaimAssessment.findOne({ claimId })), status: "processing", partial: true };
      }
      if (remainingMs <= 0) {
        logger.warn(
          { claimId, uploadId: evidence.uploadId, imageCount: evidenceDocs.length },
          "Claim evidence assessment exhausted its request time budget"
        );
        return failAssessment({
          claimId,
          version,
          stage: "provider",
          message: "Claim evidence assessment exceeded its time budget",
          requestId,
          kind: PROVIDER_ERROR_KINDS.TIMEOUT,
          lease,
        });
      }

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
          kind: PROVIDER_ERROR_KINDS.STORAGE,
          lease,
        });
      }
      if (!object) {
        return failAssessment({
          claimId,
          version,
          stage: "storage",
          message: "Image storage unavailable",
          requestId,
          kind: PROVIDER_ERROR_KINDS.STORAGE,
          lease,
        });
      }
      const observation = await analyzeClaimImage({
        imageBuffer: object.buffer,
        mediaType: object.mediaType || evidence.mediaType,
        timeoutMs: Math.min(perImageMs, remainingMs),
        ...visionOptions,
      });
      images.push({
        evidenceId: evidence._id,
        uploadId: evidence.uploadId,
        observation: scrubObservation(observation),
      });

      // Checkpoint: a crash or a takeover from here on never pays for this image again. The lease is
      // renewed for the next image.
      const nextLease = leaseAfter(perImageMs);
      const kept = await ClaimAssessment.updateOne(owned(), { $set: { aiImageAssessments: images, slotLeaseUntil: nextLease } });
      if (lease && kept.matchedCount === 0) return lostSlot();
      lease = nextLease;
    }

    const aggregate = buildAggregate(images);

    const completed = await ClaimAssessment.updateOne(
      owned(),
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          aiImageAssessments: images,
          aiAggregate: aggregate,
          error: null,
          slotLeaseUntil: null,
        },
      }
    );
    if (lease && completed.matchedCount === 0) return lostSlot();

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

    const final = await ClaimAssessment.findOne({ claimId });
    return serialize(final);
  } catch (error) {
    const kind = classifyProviderError(error);
    if (error instanceof ApiError) {
      return failAssessment({
        claimId,
        version,
        stage: "provider",
        message: error.message,
        requestId,
        kind,
        lease,
      });
    }
    // Kind and error name only: a raw provider error message can carry a prompt or a URL.
    logger.error({ claimId, kind, errName: error?.name || null }, "Claim evidence assessment failed");
    return failAssessment({
      claimId,
      version,
      stage: "provider",
      message: "Claim evidence assessment failed",
      requestId,
      kind,
      lease,
    });
  }
};

// Internal assessment entry point. Only { claimId, cognitoSub, requestId } are read — any other
// supplied data (imageUrl, s3Key, body fields, claim state) is structurally ignored. `mode` and
// `deadline` are set by the queue's step executor only (ADR-022, see processImagesAndFinish).
export const assessClaimEvidence = async ({ claimId, cognitoSub, requestId, mode = "request", deadline = null }) => {
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
  const { assessment, proceed, lease, resumeFrom } = await acquireProcessingSlot(claim._id, fingerprint);

  if (!proceed) {
    return serialize(assessment); // already running or reused completed assessment
  }

  return processImagesAndFinish({
    claimId: claim._id,
    evidenceDocs,
    fingerprint,
    version: assessment.version,
    requestId,
    lease,
    resumeFrom,
    mode: mode === "job" ? "job" : "request",
    deadline,
  });
};

export default { assessClaimEvidence };