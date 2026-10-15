import { randomUUID } from "node:crypto";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import Appeal from "../models/Appeal.js";
import FarmProfile from "../models/FarmProfile.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import { serializeClaim, findOwned } from "./claim.service.js";
import { getSignedGetUrl } from "./s3.service.js";
import {
  QUEUE_STATES,
  normalizeQueueFilters,
  buildPostMatch,
  aiFailedExpression,
  serializeQueueEntry,
} from "./adminQueue.service.js";
import { computeDashboardMetrics } from "./adminDashboard.service.js";
import { buildInvestigationEntries, summarizeInvestigation } from "./adminInvestigation.service.js";
import {
  evaluateOverrideTransition,
  overridesRequireApprover,
  approverIsValid,
} from "./adminOverrideRules.service.js";
import {
  getActiveAppeal,
  allAppealsForClaim,
  resolveActiveAppealsForClaim,
} from "./appeal.service.js";

// Phase 10 (E9-S10) — Admin workflows (08_API_Documentation §10.10–10.12).
//
// Every function here is called ONLY behind requireAuth + requireRole("admin") (see routes/admin.js
// + app.js), and every actor identity (actorSub/actorEmail) comes from the verified session token,
// never from the request body. The review queue and investigation views are READ-ONLY; the single
// mutable admin operation is `overrideClaim`, which records an immutable AdminAction + ClaimAudit
// on every apply (never silent) with replay protection (owner+key-unique idempotencyKey).

// ---------------------------------------------------------------------------
// Admin claim detail (queued claims + an owning farmer lookup for review context)
// ---------------------------------------------------------------------------

const serializeAssessmentDoc = (assessment) => {
  if (!assessment) return null;
  const doc = assessment.toObject ? assessment.toObject() : assessment;
  return {
    status: doc.status ?? null,
    version: doc.version ?? null,
    model: doc.model ?? null,
    aiImageAssessments: (doc.aiImageAssessments || []).map((entry) => ({
      evidenceId: entry.evidenceId,
      uploadId: entry.uploadId,
      observation: entry.observation ?? null,
    })),
    startedAt: doc.startedAt ?? null,
    completedAt: doc.completedAt ?? null,
    failedAt: doc.failedAt ?? null,
    error: doc.error ?? null,
    approvedGeometry: doc.approvedGeometry ?? null,
    approvedAreaAcres: doc.approvedAreaAcres ?? null,
    verifiedAreaAcres: doc.verifiedAreaAcres ?? null,
    remainingEligible: doc.remainingEligible ?? null,
    previouslyVerifiedAcres: doc.previouslyVerifiedAcres ?? null,
    inFlightAreaAcres: doc.inFlightAreaAcres ?? null,
    overlapWarnings: doc.overlapWarnings ?? [],
    spatialEvaluated: doc.spatialEvaluated ?? false,
    aiAggregate: doc.aiAggregate ?? null,
    weatherCorrelation: doc.weatherCorrelation ?? null,
    rules: doc.rules ?? null,
    state: doc.state ?? null,
    reason: doc.reason ?? null,
    decidedAt: doc.decidedAt ?? null,
    decidedBy: doc.decidedBy ?? null,
    adminNote: doc.adminNote ?? null,
    verification: doc.verification ?? null,
  };
};

const serializeAudit = (row) => ({
  actor: row.actor,
  action: row.action,
  fromState: row.fromState,
  toState: row.toState,
  reason: row.reason,
  metadata: row.metadata ?? {},
  requestId: row.requestId,
  createdAt: row.createdAt,
});

const serializeAdminAction = (row) => ({
  id: row._id,
  claimId: row.claimId,
  action: row.action,
  actorSub: row.actorSub,
  actorEmail: row.actorEmail,
  priorState: row.priorState,
  targetState: row.targetState,
  reason: row.reason,
  adminNote: row.adminNote,
  approverSub: row.approverSub,
  appealId: row.appealId,
  idempotencyKey: row.idempotencyKey,
  metadata: row.metadata ?? {},
  requestId: row.requestId,
  createdAt: row.createdAt,
});

const EVIDENCE_URL_TTL_SECONDS = 5 * 60;

// Signs a short-lived GET URL for each STORED evidence photo of a claim. The S3 key is read from
// the database here and used only to sign; it is never part of the serialized claim (the detail
// view populates evidence with `-s3Key`), so the raw object key never reaches the client.
const signStoredEvidenceUrls = async (evidenceIds) => {
  if (!evidenceIds.length) return [];
  const rows = await ClaimEvidence.find({ _id: { $in: evidenceIds }, status: "stored" })
    .select("uploadId s3Key")
    .lean();
  const urls = [];
  for (const entry of rows) {
    try {
      const url = await getSignedGetUrl({
        key: entry.s3Key,
        expiresInSeconds: EVIDENCE_URL_TTL_SECONDS,
      });
      urls.push({ uploadId: entry.uploadId, url, expiresIn: EVIDENCE_URL_TTL_SECONDS });
    } catch (error) {
      // best-effort: a failed sign never fails the whole detail view, but it must not be silent
      logger.warn({ err: error, uploadId: entry.uploadId }, "admin evidence url signing failed");
    }
  }
  return urls;
};

export const getAdminClaimDetail = async ({ claimId, actorSub }) => {
  const claim = await LossClaim.findById(claimId).populate({
    path: "evidence",
    select: "-s3Key",
  });
  if (!claim) throw ApiError.notFound("Claim not found");

  const [assessment, appeals, audits, adminActions, profile, farmer] = await Promise.all([
    ClaimAssessment.findOne({ claimId: claim._id }),
    allAppealsForClaim(claim._id),
    ClaimAudit.find({ claimId: claim._id }).sort({ createdAt: 1 }),
    AdminAction.find({ claimId: claim._id }).sort({ createdAt: 1 }),
    FarmProfile.findOne({ cognitoSub: claim.cognitoSub }),
    User.findOne({ cognitoSub: claim.cognitoSub }),
  ]);

  const parcel =
    (profile?.parcels || []).find((item) => item.parcelId === claim.parcelId) ?? null;
  const evidenceIds = (Array.isArray(claim.evidence) ? claim.evidence : []).map((doc) => doc._id);
  const evidenceUrls = await signStoredEvidenceUrls(evidenceIds);

  const base = serializeClaim(claim, serializeAssessmentDoc(assessment));
  return {
    ...base,
    farmer: { cognitoSub: claim.cognitoSub, email: farmer?.email ?? null, name: farmer?.name ?? null },
    parcel: parcel
      ? {
          parcelId: parcel.parcelId,
          name: parcel.name ?? null,
          crop: parcel.crop ?? null,
          calculatedAreaAcres: parcel.calculatedAreaAcres ?? null,
          geometry: parcel.geometry ?? null,
        }
      : null,
    evidenceUrls,
    appeals: appeals.map((appeal) => ({
      id: appeal._id,
      status: appeal.status,
      reason: appeal.reason,
      statement: appeal.statement,
      evidence: (appeal.evidence || []).map((entry) => ({
        uploadId: entry.uploadId,
        mediaType: entry.mediaType,
        size: entry.size,
        uploadedAt: entry.uploadedAt,
      })),
      decision: appeal.decision ?? null,
      createdAt: appeal.createdAt,
      resolvedAt: appeal.resolvedAt,
    })),
    audit: audits.map(serializeAudit),
    adminActions: adminActions.map(serializeAdminAction),
    meta: {
      requestedBy: actorSub,
      requestedAt: new Date().toISOString(),
    },
  };
};

// ---------------------------------------------------------------------------
// Read-only review queue (08_API_Documentation §10.10)
// ---------------------------------------------------------------------------

export const listReviewQueue = async ({ actorSub, rawFilters = {} }) => {
  const filters = normalizeQueueFilters(rawFilters);
  const skip = (filters.page - 1) * filters.limit;

  // Aggregation notes:
  //  - $lookup on "claimassessments" (ClaimAssessment collection) and "appeals" (Appeal active
  //    only) add the assessment + active appeal; $addFields projects the pure hasActiveAppeal /
  //    aiFailed flags that buildPostMatch consumes;
  //  - NO cognitoSub, profileId, idempotencyKey or s3 material is projected (admin isolation).
  const pipeline = [
    {
      $lookup: {
        from: "claimassessments",
        localField: "_id",
        foreignField: "claimId",
        as: "assessments",
      },
    },
    {
      $addFields: { assessment: { $arrayElemAt: ["$assessments", 0] } },
    },
    {
      $lookup: {
        from: "appeals",
        let: { claimId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$claimId", "$$claimId"] },
                  { $in: ["$status", ["submitted", "under_review"]] },
                ],
              },
            },
          },
        ],
        as: "appeals",
      },
    },
    {
      $addFields: {
        appeal: { $arrayElemAt: ["$appeals", 0] },
        hasActiveAppeal: { $gt: [{ $size: "$appeals" }, 0] },
        aiFailed: aiFailedExpression,
      },
    },
    {
      $match: buildPostMatch(filters),
    },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        data: [
          { $sort: { decidedAt: -1, createdAt: -1 } },
          { $skip: skip },
          { $limit: filters.limit },
        ],
      },
    },
  ];

  const [result] = await LossClaim.aggregate(pipeline);
  const total = result?.metadata?.[0]?.total ?? 0;
  const rows = result?.data ?? [];
  const items = rows.map((row) => {
    const claim = { ...row, assessment: row.assessment ?? null, appeal: row.appeal ?? null };
    return serializeQueueEntry(claim);
  });
  return {
    items,
    total,
    page: filters.page,
    limit: filters.limit,
    filters: {
      status: filters.status,
      eventType: filters.eventType,
      search: filters.search,
      withAppeal: filters.withAppeal,
      aiFailed: filters.aiFailed,
    },
  };
};

// ---------------------------------------------------------------------------
// Operations dashboard (08_API_Documentation §10.12)
// ---------------------------------------------------------------------------

export const getDashboard = async ({ rangeDays = 90 } = {}) => {
  const rangeMs = Math.max(1, Number(rangeDays) || 90) * 24 * 60 * 60 * 1000;
  const from = new Date(Date.now() - rangeMs);
  const claims = await LossClaim.find({ createdAt: { $gte: from } }).lean();
  const ids = claims.map((claim) => claim._id);
  const [assessments, appeals] = await Promise.all([
    ClaimAssessment.find({ claimId: { $in: ids } }).lean(),
    Appeal.find({ claimId: { $in: ids } }).lean(),
  ]);
  const assessmentMap = new Map(assessments.map((row) => [String(row.claimId), row]));
  const activeAppealMap = new Map();
  for (const appeal of appeals) {
    const key = String(appeal.claimId);
    if (!activeAppealMap.has(key) && ["submitted", "under_review"].includes(appeal.status)) {
      activeAppealMap.set(key, appeal);
    }
  }
  const rows = claims.map((claim) => ({
    ...claim,
    assessment: assessmentMap.get(String(claim._id)) ?? null,
    appeal: activeAppealMap.get(String(claim._id)) ?? null,
  }));
  const metrics = computeDashboardMetrics({ claims: rows, appeals });
  return { rangeDays: Number(rangeDays) || 90, metrics };
};

// ---------------------------------------------------------------------------
// Fraud investigation (observation only — never mutates, 08_API_Documentation §10.11)
// ---------------------------------------------------------------------------

export const getInvestigation = async ({ rangeDays = 90 } = {}) => {
  const rangeMs = Math.max(1, Number(rangeDays) || 90) * 24 * 60 * 60 * 1000;
  const from = new Date(Date.now() - rangeMs);
  const claims = await LossClaim.find({ createdAt: { $gte: from } }).lean();
  const ids = claims.map((claim) => claim._id);
  const [assessments, users] = await Promise.all([
    ClaimAssessment.find({ claimId: { $in: ids } }).lean(),
    User.find({ cognitoSub: { $in: [...new Set(claims.map((claim) => claim.cognitoSub))] } }).lean(),
  ]);
  const assessmentMap = new Map(assessments.map((row) => [String(row.claimId), row]));
  const userMap = new Map(users.map((row) => [row.cognitoSub, row]));
  const rows = claims.map((claim) => ({
    ...claim,
    ownerKey: claim.cognitoSub,
    farmerEmail: userMap.get(claim.cognitoSub)?.email ?? null,
    assessment: assessmentMap.get(String(claim._id)) ?? null,
  }));
  const entries = buildInvestigationEntries(rows);
  const summary = summarizeInvestigation(entries);
  return { rangeDays: Number(rangeDays) || 90, summary, entries };
};

// ---------------------------------------------------------------------------
// Admin override — the ONLY mutable admin operation (08_API_Documentation §10.10)
// ---------------------------------------------------------------------------

const RACE_WAIT_ATTEMPTS = 10;
const RACE_WAIT_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findOverrideByKey = (claimId, key) =>
  AdminAction.findOne({ claimId, idempotencyKey: key, action: "override" });

export const overrideClaim = async ({
  claimId,
  actorSub,
  actorEmail = null,
  toState,
  reason,
  adminNote = null,
  approverSub = null,
  overrideKey = null,
  requestId = null,
}) => {
  const claim = await LossClaim.findById(claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const replayResult = async (action) => {
    const current = (await LossClaim.findById(claim._id)) ?? claim;
    return {
      claim: serializeClaim(current, serializeAssessmentDoc(await ClaimAssessment.findOne({ claimId: claim._id }))),
      adminAction: serializeAdminAction(action),
      idempotent: true,
    };
  };

  // Replay protection FIRST: the same claim+overrideKey may only ever map to ONE admin action,
  // and an exact replay must return the recorded result idempotently — even if the claim has
  // since reached the target state (where the transition guard below would otherwise 409).
  const key = typeof overrideKey === "string" ? overrideKey.trim() || null : null;
  if (key) {
    const prior = await findOverrideByKey(claim._id, key);
    if (prior) return replayResult(prior);
  }

  const transition = evaluateOverrideTransition({ fromState: claim.state, toState });
  if (!transition.ok) throw ApiError.conflict(transition.reason);

  if (approverSub != null && !approverIsValid({ actorSub, approverSub })) {
    throw ApiError.badRequest("Approver must be a different admin identity");
  }

  // Optional second-admin approval for high-acreage overrides (15_Security §5).
  if (overridesRequireApprover({ overriddenAcres: claim.claimedAreaAcres, threshold: env.adminOverrideApproverAcreThreshold })) {
    if (!approverSub) {
      throw ApiError.conflict("A second admin approval is required for this override");
    }
  }

  const priorState = claim.state;
  const priorDecidedAt = claim.decidedAt ?? null;
  const decidedAt = new Date();
  const activeAppeal = await getActiveAppeal(claim._id);

  // Atomic state change: only succeeds if the claim is STILL in the state this decision was based
  // on. A concurrent override (or the engine) that moved the claim first makes this one lose
  // cleanly with 409 instead of silently overwriting it.
  let updated;
  try {
    updated = await LossClaim.findOneAndUpdate(
      { _id: claim._id, state: priorState },
      { $set: { state: toState, decidedAt } },
      { new: true }
    );
  } catch (error) {
    // Overriding into verified/partially_verified must not collide with the existing unique
    // parcel+eventDate+eventType claim index (a batch duplicate the engine already protected).
    if (error?.code === 11000) {
      throw ApiError.conflict("A verified claim already exists for this parcel and event date");
    }
    throw error;
  }
  if (!updated) {
    // Lost the race. If the winner used the SAME client key this is a replay, not a conflict;
    // give the winner a moment to write its AdminAction before deciding.
    if (key) {
      for (let attempt = 0; attempt < RACE_WAIT_ATTEMPTS; attempt += 1) {
        const raced = await findOverrideByKey(claim._id, key);
        if (raced) return replayResult(raced);
        await sleep(RACE_WAIT_MS);
      }
    }
    throw ApiError.conflict("Claim state changed while the override was being applied; reload and retry");
  }

  // The AdminAction is written IMMEDIATELY after the state change so an override can never be
  // silent. Keyless overrides get a server-generated key so they can never collide on the
  // per-claim unique key index (the previous null-key collision made the second keyless override
  // fail AFTER the claim had already been changed).
  const actionKey = key ?? `ovr_auto_${String(claim._id)}_${randomUUID()}`;
  let adminAction;
  try {
    adminAction = await AdminAction.create({
      claimId: claim._id,
      action: "override",
      actorSub,
      actorEmail,
      priorState,
      targetState: toState,
      reason,
      adminNote: adminNote ?? null,
      approverSub: approverSub ?? null,
      appealId: activeAppeal?._id ?? null,
      idempotencyKey: actionKey,
      metadata: {
        claimedAreaAcres: claim.claimedAreaAcres,
        administeredApproverRequired: env.adminOverrideApproverAcreThreshold > 0,
      },
      requestId,
    });
  } catch (error) {
    // Could not record the decision: undo our state change (only if nobody has touched the claim
    // since) so the claim never sits in a state without its AdminAction.
    await LossClaim.updateOne(
      { _id: claim._id, state: toState, decidedAt },
      { $set: { state: priorState, decidedAt: priorDecidedAt } }
    ).catch((rollbackError) =>
      logger.error({ err: rollbackError, claimId: String(claim._id) }, "override rollback failed")
    );
    if (error?.code === 11000 && key) {
      const raced = await findOverrideByKey(claim._id, key);
      if (raced) return replayResult(raced);
    }
    throw error;
  }

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "admin",
    action: "overridden",
    fromState: priorState,
    toState,
    reason: "Admin override of the verification decision",
    metadata: { adminNote: adminNote ?? null, adminActionId: adminAction._id },
    requestId,
  }).catch((error) => {
    logger.error(
      { err: error, claimId: String(claim._id), adminActionId: String(adminAction._id) },
      "override applied but its ClaimAudit row could not be written"
    );
    throw error;
  });

  let assessment = await ClaimAssessment.findOne({ claimId: claim._id });
  const decisionFields = {
    state: toState,
    decidedBy: "admin",
    decidedAt,
    reason,
    adminNote: adminNote ?? null,
  };
  if (assessment) {
    assessment.state = decisionFields.state;
    assessment.decidedBy = "admin";
    assessment.decidedAt = decidedAt;
    assessment.reason = reason;
    assessment.adminNote = adminNote ?? null;
    if (assessment.verification) {
      assessment.verification = {
        ...assessment.verification.toObject ? assessment.verification.toObject() : assessment.verification,
        status: "completed",
        completedAt: decidedAt,
      };
    }
    await assessment.save();
  } else {
    assessment = await ClaimAssessment.create({
      claimId: claim._id,
      ...decisionFields,
      verification: { status: "completed", completedAt: decidedAt, version: null },
    });
  }
  const adminAssessment = serializeAssessmentDoc(assessment);

  // Resolve every active appeal with the override decision (kind: overridden).
  const resolvedAppeals = await resolveActiveAppealsForClaim({
    claimId: claim._id,
    decision: { kind: "overridden", toState, reason, adminNote: adminNote ?? null },
    decidedBySub: actorSub,
    requestId,
  });

  return {
    claim: serializeClaim(updated, adminAssessment),
    adminAction: serializeAdminAction(adminAction),
    resolvedAppeals: resolvedAppeals.map((appeal) => ({ id: appeal._id, status: appeal.status })),
    idempotent: false,
  };
};

export default {
  getAdminClaimDetail,
  listReviewQueue,
  getDashboard,
  getInvestigation,
  overrideClaim,
};