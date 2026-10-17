import FarmProfile from "../models/FarmProfile.js";
import LossClaim from "../models/LossClaim.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import { validateParcelGeometry } from "./parcelGeometry.service.js";
import { canTransition } from "./claimState.service.js";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { env } from "../config/env.js";
import { cancelJobsForClaim } from "./verificationJobs.service.js";

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
    claimantRelationship: doc.claimantRelationship ?? null,
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
  // E9-S9 (Phase 9) — additive decision surface so claim detail renders remaining-eligible /
  // overlap-warning cards without re-deriving (07 §8 attachment, 08_API_Documentation §10.8).
  verifiedAreaAcres: assessment.verifiedAreaAcres,
  remainingEligible: assessment.remainingEligible,
  previouslyVerifiedAcres: assessment.previouslyVerifiedAcres,
  inFlightAreaAcres: assessment.inFlightAreaAcres,
  overlapWarnings: assessment.overlapWarnings,
  spatialEvaluated: assessment.spatialEvaluated,
  aiAggregate: assessment.aiAggregate,
  weatherCorrelation: assessment.weatherCorrelation,
  rules: assessment.rules,
  state: assessment.state,
  reason: assessment.reason,
  decidedAt: assessment.decidedAt,
  decidedBy: assessment.decidedBy,
  adminNote: assessment.adminNote,
  // ADR-020 (additive): which parts of the claim are resolved, and whether a decision is on hold.
  // `held` means a required component is unresolved: there is no decision yet and the claim is still
  // `submitted`. Decisions made before policies existed report policyId "legacy" and no components.
  held: Boolean(!assessment.state && assessment.verification && assessment.verification.status === "held"),
  pendingComponents:
    assessment.hold && Array.isArray(assessment.hold.blocking)
      ? assessment.hold.blocking.map((item) => ({ component: item.component, outcome: item.outcome, action: item.action }))
      : [],
  components: assessment.components || null,
  policyId: assessment.policy && assessment.policy.id ? assessment.policy.id : "legacy",
  // ADR-022 (farmer audience): this serializer feeds only the farmer's own claim reads
  // (GET /claims/:id, GET /claims/:id/verification). The policy id says which rules decided; the hash
  // is an internal reproducibility detail and stays on the reviewer's side (admin views use their own
  // serializer, services/admin.service.js, and the verification diagnostics).
  policyHash: null,
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
  claimantRelationship = null,
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
      claimantRelationship,
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

// ADR-022: the round's verification plan is written INSIDE the request (awaited), so the job rows
// exist before the response is sent. A failure is a 503 for the client to retry: the claim is
// already saved, and the retry re-runs the (idempotent) plan. Nothing is queued when automated
// verification is off.
const schedulePlan = async ({ claimId, cognitoSub, requestId, trigger }) => {
  if (!env.claimAutomatedVerificationEnabled) return [];
  const { scheduleAutomatedVerification } = await import("./claimVerificationPipeline.service.js");
  return scheduleAutomatedVerification({ claimId, cognitoSub, requestId, trigger });
};

// A claim that has been submitted at least once and has since moved on from `submitted` (the worker
// decided it, or it waits for more evidence). A repeated submit for it is the same request arriving
// late, typically the browser's automatic retry of a submit whose answer was lost while the worker
// decided the claim within the retry delay (found by e2e E2E-03). A withdrawn claim is not included:
// withdrawing is the farmer's own later choice, and submitting it stays a 409.
export const wasSubmittedAndMovedOn = (claim) =>
  Boolean(claim) &&
  !["draft", "submitted", "withdrawn"].includes(claim.state) &&
  (Number(claim.submissionRound) >= 1 || Boolean(claim.firstSubmittedAt) || Boolean(claim.submittedAt));

export const submitForUser = async ({ cognitoSub, claimId, requestId = null }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found");

  // Safe repeated submission: an already-submitted claim returns as-is (no duplicate audit). Its plan
  // is ensured again, which recovers a plan an earlier request could not write.
  if (claim.state === "submitted") {
    await schedulePlan({ claimId: claim._id, cognitoSub, requestId, trigger: "submit_retry" });
    return { claim: serializeClaim(claim), idempotent: true };
  }

  // The same repeated submission after the round was already decided: answered as idempotent with the
  // claim as it now stands. Nothing is written and nothing is planned (the round's plan has run).
  if (wasSubmittedAndMovedOn(claim)) {
    return { claim: serializeClaim(claim), idempotent: true };
  }

  // Contract says submit = draft → submitted only; a more_evidence_required claim must use the
  // documented resubmit endpoint instead.
  if (claim.state !== "draft" || !canTransition(claim.state, "submitted")) {
    throw ApiError.conflict(`Claim can only be submitted from draft state`);
  }

  // Revalidate authoritative invariants before the transition — never re-trust the client.
  const dateCheck = eventDateCheck(claim.eventDate);
  if (!dateCheck.ok) throw ApiError.badRequest(dateCheck.reason);
  const geometryResult = validateParcelGeometry(claim.claimedGeometry);
  if (!geometryResult.ok) throw ApiError.badRequest(geometryResult.reason);

  // Compare-and-set on the expected state: of any number of concurrent submits exactly one moves the
  // claim, writes the audit row and builds the plan. `firstSubmittedAt` is the claim-window reference
  // (a resubmission overwrites `submittedAt`), and `submissionRound` scopes the plan.
  const now = new Date();
  const updated = await LossClaim.findOneAndUpdate(
    { _id: claim._id, cognitoSub, state: "draft" },
    {
      $set: { state: "submitted", submittedAt: now, firstSubmittedAt: now, claimedAreaAcres: geometryResult.acres },
      $inc: { submissionRound: 1 },
    },
    { new: true }
  );
  if (!updated) {
    const current = await LossClaim.findOne({ _id: claim._id, cognitoSub });
    if (current && current.state === "submitted") {
      await schedulePlan({ claimId: current._id, cognitoSub, requestId, trigger: "submit_retry" });
      return { claim: serializeClaim(current), idempotent: true };
    }
    if (wasSubmittedAndMovedOn(current)) return { claim: serializeClaim(current), idempotent: true };
    throw ApiError.conflict(`Claim can only be submitted from draft state`);
  }

  await ClaimAudit.create({
    claimId: updated._id,
    actor: "farmer",
    action: "submitted",
    fromState: "draft",
    toState: "submitted",
    reason: "Claim submitted by farmer",
    metadata: { claimedAreaAcres: updated.claimedAreaAcres, submissionRound: updated.submissionRound },
    requestId,
  });

  await schedulePlan({ claimId: updated._id, cognitoSub, requestId, trigger: "submit" });
  return { claim: serializeClaim(updated), idempotent: false };
};

export const withdrawForUser = async ({ cognitoSub, claimId, requestId = null }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found");

  if (!canTransition(claim.state, "withdrawn")) {
    throw ApiError.conflict(`Claim cannot be withdrawn from ${claim.state} state`);
  }

  // Compare-and-set: the engine's own `submitted → processing` lock and a withdrawal can race, and
  // exactly one of them wins. A claim the engine has locked can no longer be withdrawn.
  const fromState = claim.state;
  const updated = await LossClaim.findOneAndUpdate(
    { _id: claim._id, cognitoSub, state: fromState },
    { $set: { state: "withdrawn" } },
    { new: true }
  );
  if (!updated) {
    const current = await LossClaim.findOne({ _id: claim._id, cognitoSub });
    // A concurrent withdrawal already won: same result, no second audit row.
    if (current && current.state === "withdrawn") return serializeClaim(current);
    throw ApiError.conflict(`Claim cannot be withdrawn from ${current ? current.state : claim.state} state`);
  }

  await ClaimAudit.create({
    claimId: updated._id,
    actor: "farmer",
    action: "withdrawn",
    fromState,
    toState: "withdrawn",
    reason: "Claim withdrawn by farmer",
    requestId,
  });

  // Queued checks for a withdrawn claim would only spend provider calls. A job already running is
  // stopped by the queue's own withdrawn-claim guard.
  await cancelJobsForClaim({ claimId: updated._id, reason: "claim_withdrawn" }).catch((error) =>
    logger.warn({ claimId: String(updated._id), requestId, err: error?.message }, "verification.cancel_failed")
  );

  return serializeClaim(updated);
};

// B4 (ADR-022): a resubmit whose response was lost (for example a 503 because the plan could not be
// written) is retried by the client. The claim is then already `submitted` by THAT resubmission, so
// the retry is answered as idempotent instead of 409. Round 1 is the first submit, so any later
// round was a resubmission; claims from before `submissionRound` existed are recognised by their
// latest submission audit row being a `resubmitted` one.
const lastSubmissionWasResubmit = async (claim) => {
  if ((claim.submissionRound || 0) >= 2) return true;
  const latest = await ClaimAudit.findOne({ claimId: claim._id, action: { $in: ["submitted", "resubmitted"] } })
    .sort({ createdAt: -1, _id: -1 })
    .select("action metadata")
    .lean();
  if (!latest || latest.action !== "resubmitted") return false;
  const round = latest.metadata && latest.metadata.submissionRound;
  return round === undefined || round === null || round === claim.submissionRound;
};

export const resubmitForUser = async ({ cognitoSub, claimId, requestId = null }) => {
  const claim = await LossClaim.findOne({ _id: claimId, cognitoSub });
  if (!claim) throw ApiError.notFound("Claim not found");

  if (claim.state === "submitted" && (await lastSubmissionWasResubmit(claim))) {
    await schedulePlan({ claimId: claim._id, cognitoSub, requestId, trigger: "resubmit_retry" });
    return { claim: serializeClaim(claim), idempotent: true };
  }

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

  // Compare-and-set on the expected state (see submitForUser). `firstSubmittedAt` is left alone: the
  // claim window is measured at the FIRST submission.
  const now = new Date();
  const updated = await LossClaim.findOneAndUpdate(
    { _id: claim._id, cognitoSub, state: "more_evidence_required" },
    { $set: { state: "submitted", submittedAt: now }, $inc: { submissionRound: 1 } },
    { new: true }
  );
  if (!updated) {
    const current = await LossClaim.findOne({ _id: claim._id, cognitoSub });
    // A concurrent resubmit of the same round won (from more_evidence_required the only way to
    // `submitted` is a resubmit): this request is its duplicate.
    if (current && current.state === "submitted" && (current.submissionRound || 0) === (claim.submissionRound || 0) + 1) {
      await schedulePlan({ claimId: current._id, cognitoSub, requestId, trigger: "resubmit_retry" });
      return { claim: serializeClaim(current), idempotent: true };
    }
    throw ApiError.conflict("Claim can only be resubmitted from more_evidence_required state");
  }

  await ClaimAudit.create({
    claimId: updated._id,
    actor: "farmer",
    action: "resubmitted",
    fromState: "more_evidence_required",
    toState: "submitted",
    reason: "Claim resubmitted with new evidence",
    metadata: { submissionRound: updated.submissionRound },
    requestId,
  });

  await schedulePlan({ claimId: updated._id, cognitoSub, requestId, trigger: "resubmit" });
  return { claim: serializeClaim(updated), idempotent: false };
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