import Appeal from "../models/Appeal.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { APPEAL_ELIGIBLE_STATES, APPEAL_STATUSES } from "../models/Appeal.js";
import ApiError from "../utils/ApiError.js";
import { findOwned } from "./claim.service.js";

// Phase 10 (E9-S10) — Farmer appeal + additional-evidence workflow (08_API_Documentation §10.9).
//
// Ownership flows through the claim: every path first resolves the caller's claim via
// `{ _id, cognitoSub }` (404 for foreign). Farmers may appeal ONLY eligible engine decisions
// (rejected / out_of_limit / duplicate_area / more_evidence_required) — the frozen terminal
// states never change as a SIDE effect of an appeal. An appeal is a review request: it is
// resolved only when an admin records an override (or upholds) decision via the immutable
// AdminAction path (services/admin.service.js).
//
// One ACTIVE appeal per claim at a time (partial unique index in models/Appeal.js); resubmitting
// while an appeal is active is idempotent and returns the existing appeal. Every submission appends
// a ClaimAudit row (actor farmer, requestId correlated).

const serializeAppeal = (appeal) => {
  const doc = appeal.toObject ? appeal.toObject() : appeal;
  return {
    id: doc._id,
    status: doc.status,
    reason: doc.reason,
    statement: doc.statement,
    evidence: (doc.evidence || []).map((entry) => ({
      uploadId: entry.uploadId,
      mediaType: entry.mediaType,
      size: entry.size,
      uploadedAt: entry.uploadedAt,
    })),
    decision: doc.decision ?? null,
    createdAt: doc.createdAt,
    resolvedAt: doc.resolvedAt,
  };
};

export const createAppealForUser = async ({
  cognitoSub,
  claimId,
  reason,
  statement = null,
  requestId = null,
}) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  // Eligible EXCEPTION decisions only; verified/partial/withdrawn/draft/submitted CANNOT appeal.
  if (!APPEAL_ELIGIBLE_STATES.includes(claim.state)) {
    throw ApiError.conflict(
      `Claim in ${claim.state} state is not eligible for appeal`
    );
  }

  // Idempotent: an already-active appeal for this claim returns as-is.
  const existing = await Appeal.findOne({
    claimId: claim._id,
    status: { $in: ["submitted", "under_review"] },
  });
  if (existing) return { appeal: serializeAppeal(existing), idempotent: true };

  const appeal = await Appeal.create({
    claimId: claim._id,
    cognitoSub,
    status: "submitted",
    reason,
    statement: statement || null,
    evidence: [],
  });

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "farmer",
    action: "appeal_submitted",
    fromState: claim.state,
    toState: claim.state,
    reason: "Farmer appealed the verification decision",
    metadata: { appealId: appeal._id, reason },
    requestId,
  });

  return { appeal: serializeAppeal(appeal), idempotent: false };
};

export const getAppealForUser = async ({ cognitoSub, claimId }) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) return null;
  const appeal = await Appeal.findOne({ claimId: claim._id }).sort({ createdAt: -1 });
  if (!appeal) return null;
  return serializeAppeal(appeal);
};

// Active (open) appeal for a claim — used by the admin queue/detail and by the evidence gate.
export const getActiveAppeal = async (claimId) =>
  Appeal.findOne({ claimId, status: { $in: ["submitted", "under_review"] } });

// Called by claimEvidence.completeEvidence AFTER a successful store while the appeal is active:
// records the newly stored evidence on the appeal (dedupe by uploadId). Never throws — if the
// appeal vanished (resolved concurrently) the evidence record simply isn't appended.
export const recordAppealEvidence = async ({
  claimId,
  uploadId,
  mediaType = null,
  size = null,
  width = null,
  height = null,
  uploadedAt = null,
}) => {
  try {
    const appeal = await getActiveAppeal(claimId);
    if (!appeal) return null;
    const exists = (appeal.evidence || []).some((entry) => entry.uploadId === uploadId);
    if (exists) return appeal;
    appeal.evidence.push({ uploadId, mediaType, size, width, height, uploadedAt });
    await appeal.save();
    return appeal;
  } catch {
    return null;
  }
};

// Called by claimEvidence.deleteEvidence after removal while an appeal is active (dedupe-safe).
export const removeAppealEvidence = async ({ claimId, uploadId }) => {
  try {
    const appeal = await getActiveAppeal(claimId);
    if (!appeal) return null;
    const before = appeal.evidence.length;
    appeal.evidence = (appeal.evidence || []).filter((entry) => entry.uploadId !== uploadId);
    if (appeal.evidence.length !== before) await appeal.save();
    return appeal;
  } catch {
    return null;
  }
};

// Resolve every ACTIVE appeal for a claim once an admin decision lands. decision.kind is either
// "overridden" (claim state changed by an admin) or "upheld" (admin confirms the current state).
export const resolveActiveAppealsForClaim = async ({
  claimId,
  decision,
  decidedBySub,
  requestId = null,
}) => {
  const active = await Appeal.find({
    claimId,
    status: { $in: ["submitted", "under_review"] },
  });
  if (active.length === 0) return [];
  const now = new Date();
  const updated = [];
  for (const appeal of active) {
    appeal.status = "resolved";
    appeal.decision = {
      kind: decision.kind ?? "overridden",
      toState: decision.toState ?? null,
      reason: decision.reason ?? null,
      adminNote: decision.adminNote ?? null,
      decidedBySub,
      decidedAt: now,
    };
    appeal.resolvedAt = now;
    await appeal.save();
    updated.push(appeal);
  }
  return updated;
};

export const allAppealsForClaim = async (claimId) =>
  Appeal.find({ claimId }).sort({ createdAt: 1 });

export { APPEAL_ELIGIBLE_STATES, APPEAL_STATUSES };

export default {
  createAppealForUser,
  getAppealForUser,
  getActiveAppeal,
  recordAppealEvidence,
  removeAppealEvidence,
  resolveActiveAppealsForClaim,
  allAppealsForClaim,
  serializeAppeal,
  APPEAL_ELIGIBLE_STATES,
  APPEAL_STATUSES,
};