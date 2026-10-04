import mongoose from "mongoose";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import AdminAction from "../models/AdminAction.js";
import Appeal from "../models/Appeal.js";
import FarmProfile from "../models/FarmProfile.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import { serializeClaim, findOwned } from "./claim.service.js";
import { getSignedGetUrl } from "./s3.service.js";
import ChatSession from "../models/ChatSession.js";
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

const signStoredEvidenceUrls = async (evidenceDocs) => {
  const urls = [];
  for (const entry of evidenceDocs) {
    if (entry.status !== "stored") continue;
    try {
      const { url, expiresIn } = await getSignedGetUrl({
        key: entry.s3Key,
        expiresInSeconds: 5 * 60,
      });
      urls.push({ uploadId: entry.uploadId, url, expiresIn });
    } catch {
      // best-effort: a failed sign never fails the whole detail view
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
  const evidenceDocs = Array.isArray(claim.evidence) ? claim.evidence : [];
  const evidenceUrls = await signStoredEvidenceUrls(evidenceDocs);

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
  const userStats = await getDashboardStats();
  return {
    rangeDays: Number(rangeDays) || 90,
    metrics,
    counts: userStats.counts,
    recentUsers: userStats.recentUsers,
  };
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

  // Replay protection FIRST: the same claim+overrideKey may only ever map to ONE admin action,
  // and an exact replay must return the recorded result idempotently — even if the claim has
  // since reached the target state (where the transition guard below would otherwise 409).
  const key = typeof overrideKey === "string" ? overrideKey.trim() || null : null;
  if (key) {
    const prior = await AdminAction.findOne({ claimId: claim._id, idempotencyKey: key });
    if (prior) {
      return {
        claim: serializeClaim(claim, serializeAssessmentDoc(await ClaimAssessment.findOne({ claimId: claim._id }))),
        adminAction: serializeAdminAction(prior),
        idempotent: true,
      };
    }
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

  // Replay protection: the same owner+key may only ever map to ONE admin action on the claim.
  // (Pre-check happens before the transition guard; 11000 recovery covers the concurrent race.)

  const priorState = claim.state;
  const decidedAt = new Date();
  claim.state = toState;
  claim.decidedAt = decidedAt;
  try {
    await claim.save();
  } catch (error) {
    // Overriding into verified/partially_verified must not collide with the existing unique
    // parcel+eventDate+eventType claim index (a batch duplicate the engine already protected).
    if (error?.code === 11000) {
      throw ApiError.conflict("A verified claim already exists for this parcel and event date");
    }
    throw error;
  }

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
    const created = await ClaimAssessment.create({
      claimId: claim._id,
      ...decisionFields,
      verification: { status: "completed", completedAt: decidedAt, version: null },
    });
    assessment = created;
  }
  const adminAssessment = serializeAssessmentDoc(assessment);

  // Resolve every active appeal with the override decision (kind: overridden).
  const resolvedAppeals = await resolveActiveAppealsForClaim({
    claimId: claim._id,
    decision: { kind: "overridden", toState, reason, adminNote: adminNote ?? null },
    decidedBySub: actorSub,
    requestId,
  });

  const activeAppeal = resolvedAppeals[0] ?? null;

  // Immutable ADMIN decision record. A duplicate-key race (same overrideKey) is treated as the
  // replay-safe idempotent response exactly like claim creation.
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
      idempotencyKey: key,
      metadata: {
        claimedAreaAcres: claim.claimedAreaAcres,
        administeredApproverRequired: env.adminOverrideApproverAcreThreshold > 0,
      },
      requestId,
    });
  } catch (error) {
    if (error?.code === 11000 && key) {
      const raced = await AdminAction.findOne({ claimId: claim._id, idempotencyKey: key });
      if (raced) {
        return {
          claim: serializeClaim(claim, adminAssessment),
          adminAction: serializeAdminAction(raced),
          idempotent: true,
        };
      }
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
  });

  return {
    claim: serializeClaim(claim, adminAssessment),
    adminAction: serializeAdminAction(adminAction),
    resolvedAppeals: resolvedAppeals.map((appeal) => ({ id: appeal._id, status: appeal.status })),
    idempotent: false,
  };
};

const normalizePage = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeLimit = (value, fallback = 20) => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, 100);
};

const getDashboardStats = async () => {
  const [
    totalUsers,
    activeUsers,
    blockedUsers,
    adminUsers,
    totalFarmProfiles,
    totalChatSessions,
    recentUsers,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ status: "active" }),
    User.countDocuments({ status: "blocked" }),
    User.countDocuments({ role: "admin" }),
    FarmProfile.countDocuments(),
    ChatSession.countDocuments(),
    User.find({})
      .select("name email role status createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
  ]);

  return {
    counts: {
      totalUsers,
      activeUsers,
      blockedUsers,
      adminUsers,
      totalFarmProfiles,
      totalChatSessions,
    },
    recentUsers,
  };
};

const listUsers = async ({
  page = 1,
  limit = 20,
  search = "",
  status,
  role,
}) => {
  const currentPage = normalizePage(page, 1);
  const currentLimit = normalizeLimit(limit);

  const filter = {};

  if (search && search.trim()) {
    const safeSearch = search
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const regex = new RegExp(safeSearch, "i");

    filter.$or = [
      { name: regex },
      { email: regex },
      { cognitoSub: regex },
    ];
  }

  if (status && ["active", "blocked"].includes(status)) {
    filter.status = status;
  }

  if (role && ["user", "admin"].includes(role)) {
    filter.role = role;
  }

  const skip = (currentPage - 1) * currentLimit;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select(
        "name email cognitoSub language role status createdAt updatedAt"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(currentLimit)
      .lean(),

    User.countDocuments(filter),
  ]);

  return {
    users,
    pagination: {
      page: currentPage,
      limit: currentLimit,
      total,
      totalPages: Math.ceil(total / currentLimit),
    },
  };
};

const getUserById = async (userId) => {
  if (!mongoose.isValidObjectId(userId)) throw ApiError.badRequest("Invalid user id");

  const user = await User.findById(userId)
    .select(
      "name email cognitoSub language role status createdAt updatedAt"
    )
    .lean();

  if (!user) {
    throw ApiError.notFound("User not found");
  }

  const [farmProfile, chatSessionCount] = await Promise.all([
    FarmProfile.findOne({ cognitoSub: user.cognitoSub }).lean(),

    user.cognitoSub
      ? ChatSession.countDocuments({
          cognitoSub: user.cognitoSub,
        })
      : 0,
  ]);

  return {
    user,
    farmProfile: farmProfile || null,
    chatSessionCount,
  };
};

const updateUserStatus = async ({
  userId,
  status,
  requesterCognitoSub,
}) => {
  if (!mongoose.isValidObjectId(userId)) {
    throw ApiError.badRequest("Invalid user id");
  }

  if (!["active", "blocked"].includes(status)) {
    throw ApiError.badRequest("Status must be active or blocked");
  }

  const existingUser = await User.findById(userId)
    .select("cognitoSub")
    .lean();

  if (!existingUser) {
    throw ApiError.notFound("User not found");
  }

  if (
    existingUser.cognitoSub === requesterCognitoSub &&
    status === "blocked"
  ) {
    throw ApiError.badRequest(
      "You cannot block your own admin account"
    );
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set: { status } },
    {
      new: true,
      runValidators: true,
    }
  )
    .select(
      "name email cognitoSub language role status createdAt updatedAt"
    )
    .lean();

  if (!user) {
    throw ApiError.notFound("User not found");
  }

  return user;
};

export default {
  getAdminClaimDetail,
  listReviewQueue,
  overrideClaim,
  getDashboard,
  getInvestigation,

  getDashboardStats,
  listUsers,
  getUserById,
  updateUserStatus,
};