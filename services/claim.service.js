import FarmProfile from "../models/FarmProfile.js";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { validateParcelGeometry } from "./parcelGeometry.service.js";
import { canTransition, applyTransition } from "./claimState.service.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";

// F-49 (ADR-019) — claim lifecycle service. Ownership is scoped by the authenticated cognitoSub
// at every step (E1-S5/D-35). Probe, documented invariants:
//   - claimedAreaAcres is SERVER-calculated from claimedGeometry (P4) — never a body field.
//   - eventDate is validated server-side against CLAIM_WINDOW_DAYS (P2) — not client authority.
//   - farmer transitions go through claimState.service's centralized machine; every real
//     transition appends a ClaimAudit row (actor farmer, 07 §9).
//   - create is idempotent via an owner-scoped idempotencyKey (compound unique index).

const toEvidencePojo = (evidence) => ({
  uploadId: evidence.uploadId,
  mediaType: evidence.mediaType,
  size: evidence.size,
  width: evidence.width,
  height: evidence.height,
  status: evidence.status,
  uploadedAt: evidence.uploadedAt,
  createdAt: evidence.createdAt,
});

// Serializer keeps the API surface minimal: no cognitoSub/profileId/idempotencyKey and never
// the private s3Key/bucket/config of any evidence (15_Security §5).
export const serializeClaim = (claim, assessment = null) => {
  const doc = claim.toObject ? claim.toObject() : claim;
  return {
    id: doc._id,
    parcelId: doc.parcelId,
    parcelSnapshot: doc.parcelSnapshot,
    eventType: doc.eventType,
    eventDate: doc.eventDate,
    claimedGeometry: doc.claimedGeometry,
    claimedAreaAcres: doc.claimedAreaAcres,
    evidence: (doc.evidence || []).map((entry) =>
      entry && typeof entry === "object" && entry.uploadId
        ? toEvidencePojo(entry)
        : String(entry)
    ),
    state: doc.state,
    submittedAt: doc.submittedAt,
    processedAt: doc.processedAt,
    decidedAt: doc.decidedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    assessment,
  };
};

const serializeAssessment = (assessment) => ({
  approvedGeometry: assessment.approvedGeometry,
  approvedAreaAcres: assessment.approvedAreaAcres,
  aiAggregate: assessment.aiAggregate,
  weatherCorrelation: assessment.weatherCorrelation,
  rules: assessment.rules,
  state: assessment.state,
  reason: assessment.reason,
  decidedAt: assessment.decidedAt,
  decidedBy: assessment.decidedBy,
  adminNote: assessment.adminNote,
});

// Shared by the evidence service for ownership-scoped claim lookups.
export const findOwned = (cognitoSub, claimId) =>
  LossClaim.findOne({ _id: claimId, cognitoSub });

const eventDateCheck = (date, requestId = null) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, reason: "Event date is invalid" };
  }
  const now = Date.now();
  if (d.getTime() > now) {
    return { ok: false, reason: "Event date cannot be in the future" };
  }
  const windowMs = env.claimWindowDays * 24 * 60 * 60 * 1000;
  if (d.getTime() < now - windowMs) {
    return {
      ok: false,
      reason: `Event date is outside the ${env.claimWindowDays}-day claim window`,
    };
  }
  return { ok: true };
};

export const createForUser = async ({
  cognitoSub,
  parcelId,
  eventType,
  eventDate,
  geometry,
  idempotencyKey,
  requestId = null,
}) => {
  const profile = await FarmProfile.findOne({ cognitoSub });
  if (!profile) throw ApiError.notFound("Farm profile not found");

  const parcel = profile.parcels.find((p) => p.parcelId === parcelId);
  if (!parcel) throw ApiError.notFound("Parcel not found");

  const key = String(idempotencyKey).trim();
  const existing = await LossClaim.findOne({ cognitoSub, idempotencyKey: key });
  if (existing) return { claim: serializeClaim(existing), idempotent: true };

  const date = new Date(eventDate);
  const dateCheck = eventDateCheck(date);
  if (!dateCheck.ok) throw ApiError.badRequest(dateCheck.reason);

  const geometryResult = validateParcelGeometry(geometry);
  if (!geometryResult.ok) throw ApiError.badRequest(geometryResult.reason);

  // Server-owned FarmProfile parcel snapshot (client never supplies these values).
  const snapshot = {
    parcelId: parcel.parcelId,
    name: parcel.name ?? null,
    crop: parcel.crop ?? null,
    parcelAreaAcres: parcel.calculatedAreaAcres ?? 0,
  };

  let claim;
  try {
    claim = await LossClaim.create({
      cognitoSub,
      profileId: profile._id,
      parcelId,
      parcelSnapshot: snapshot,
      eventType,
      eventDate: date,
      claimedGeometry: geometry,
      claimedAreaAcres: geometryResult.acres,
      evidence: [],
      state: "draft",
      idempotencyKey: key,
    });
  } catch (error) {
    // Race-safe idempotency: a concurrent identical create wins the unique index; the loser
    // returns the winner's claim instead of failing.
    if (error?.code === 11000) {
      const raced = await LossClaim.findOne({ cognitoSub, idempotencyKey: key });
      if (raced) return { claim: serializeClaim(raced), idempotent: true };
    }
    throw error;
  }

  await ClaimAudit.create({
    claimId: claim._id,
    actor: "farmer",
    action: "created",
    fromState: null,
    toState: "draft",
    reason: "Claim created by farmer",
    metadata: {
      parcelId,
      eventType,
      eventDate: claim.eventDate,
      claimedAreaAcres: claim.claimedAreaAcres,
      idempotencyKey: key,
    },
    requestId,
  });

  return { claim: serializeClaim(claim), idempotent: false };
};

export const listForUser = async (cognitoSub) => {
  const claims = await LossClaim.find({ cognitoSub })
    .sort({ createdAt: -1 })
    .populate({ path: "evidence", select: "-s3Key" });
  return claims.map((claim) => serializeClaim(claim));
};

export const getForUser = async (cognitoSub, claimId) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub }).populate({
    path: "evidence",
    select: "-s3Key",
  });
  if (!claim) return null;
  const assessment = await ClaimAssessment.findOne({ claimId: claim._id });
  return serializeClaim(claim, assessment ? serializeAssessment(assessment) : null);
};

export const submitForUser = async ({ cognitoSub, claimId, requestId = null }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found");

  // Safe repeated submission: an already-submitted claim returns as-is (no duplicate audit).
  if (claim.state === "submitted") return { claim: serializeClaim(claim), idempotent: true };

  // Contract says submit = draft → submitted only; a more_evidence_required claim must use the
  // documented resubmit endpoint instead.
  if (claim.state !== "draft") {
    throw ApiError.conflict(`Claim can only be submitted from draft state`);
  }

  // Revalidate authoritative invariants before the transition — never re-trust the client.
  const dateCheck = eventDateCheck(claim.eventDate);
  if (!dateCheck.ok) throw ApiError.badRequest(dateCheck.reason);
  const geometryResult = validateParcelGeometry(claim.claimedGeometry);
  if (!geometryResult.ok) throw ApiError.badRequest(geometryResult.reason);

  const { claim: updated, fromState, toState } = applyTransition({
    claim,
    toState: "submitted",
  });
  updated.claimedAreaAcres = geometryResult.acres; // server-authoritative, idempotent
  updated.submittedAt = new Date();
  await updated.save();

  await ClaimAudit.create({
    claimId: updated._id,
    actor: "farmer",
    action: "submitted",
    fromState,
    toState,
    reason: "Claim submitted by farmer",
    metadata: { claimedAreaAcres: updated.claimedAreaAcres },
    requestId,
  });

  return { claim: serializeClaim(updated), idempotent: false };
};

export const withdrawForUser = async ({ cognitoSub, claimId, requestId = null }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found");

  if (!canTransition(claim.state, "withdrawn")) {
    throw ApiError.conflict(`Claim cannot be withdrawn from ${claim.state} state`);
  }

  const { claim: updated, fromState, toState } = applyTransition({
    claim,
    toState: "withdrawn",
  });
  await updated.save();

  await ClaimAudit.create({
    claimId: updated._id,
    actor: "farmer",
    action: "withdrawn",
    fromState,
    toState,
    reason: "Claim withdrawn by farmer",
    requestId,
  });

  return serializeClaim(updated);
};

export const resubmitForUser = async ({ cognitoSub, claimId, requestId = null }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found");

  // Per P6 resubmission is only ever from more_evidence_required.
  if (claim.state !== "more_evidence_required") {
    throw ApiError.conflict("Claim can only be resubmitted from more_evidence_required state");
  }

  // P6: resubmission limits/cooldown are configurable and server-enforced.
  const prior = await ClaimAudit.find({ claimId: claim._id, action: "resubmitted" }).sort({
    createdAt: 1,
  });
  if (prior.length >= env.claimMaxResubmissions) {
    throw ApiError.conflict("Maximum resubmissions reached");
  }
  const last = prior[prior.length - 1];
  if (last && Date.now() - new Date(last.createdAt).getTime() < env.claimResubmitCooldownMs) {
    throw ApiError.conflict("Claim cannot be resubmitted yet");
  }

  const { claim: updated, fromState, toState } = applyTransition({
    claim,
    toState: "submitted",
  });
  updated.submittedAt = new Date();
  await updated.save();

  await ClaimAudit.create({
    claimId: updated._id,
    actor: "farmer",
    action: "resubmitted",
    fromState,
    toState,
    reason: "Claim resubmitted with new evidence",
    requestId,
  });

  return serializeClaim(updated);
};

export default {
  createForUser,
  listForUser,
  getForUser,
  submitForUser,
  withdrawForUser,
  resubmitForUser,
  findOwned,
  serializeClaim,
};