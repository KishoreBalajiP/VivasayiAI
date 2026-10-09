import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { findOwned } from "./claim.service.js";
import {
  EVIDENCE_FOUNDATION_VERSION,
  EVIDENCE_SOURCES,
  EVIDENCE_STATUSES,
  FUTURE_EVIDENCE_SOURCES,
  OPERATIVE_EVIDENCE_SOURCES,
  buildVerificationEvidence,
  isOperativeEvidenceSource,
  projectExistingEvidence,
  validateEvidenceStatus,
} from "../utils/verificationEvidence.js";

// Phase 11 (E11-S11) — Verification Evidence Foundation (internal service, NO public endpoint).
//
// Domain operations over the generic VerificationEvidence collection. It is deliberately
// internal (no HTTP route): the foundation must not add public API surface, and future phases
// attach their own authorized workflows on top. Ownership is enforced exactly like the rest of
// the claim domain — the caller's cognitoSub must own the claim (foreign/unowned → 404), so no
// user can read or write another user's evidence.
//
// Auditing is append-only: every create and every allowed status change appends an immutable
// `ClaimAudit` row (actor "engine", requestId correlated, metadata free of storage internals).
// The evidence row itself is mutable only through `updateVerificationEvidenceStatus`; the audit
// trail is the historical source of truth (mirrors 07 §9).
//
// Non-operative sources (OWNERSHIP / SATELLITE) can be recorded NOW but are labelled
// `operative: false` and are never consumed by the deterministic engine this phase.

const IDEMPOTENCY_MIN_LENGTH = 8;
const IDEMPOTENCY_MAX_LENGTH = 64;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]+$/;

const assertValidClaimId = (claimId) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) {
    throw ApiError.badRequest("Valid claim id is required");
  }
};

const assertValidCognitoSub = (cognitoSub) => {
  if (!cognitoSub || typeof cognitoSub !== "string") {
    throw ApiError.unauthorized("Authentication required");
  }
};

const validateIdempotencyKey = (key) => {
  if (key === null || key === undefined || key === "") return null;
  if (typeof key !== "string") throw ApiError.badRequest("Invalid idempotency key");
  const trimmed = key.trim();
  if (
    trimmed.length < IDEMPOTENCY_MIN_LENGTH ||
    trimmed.length > IDEMPOTENCY_MAX_LENGTH ||
    !IDEMPOTENCY_PATTERN.test(trimmed)
  ) {
    throw ApiError.badRequest("Invalid idempotency key");
  }
  return trimmed;
};

const serialize = (doc) => {
  const record = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    id: String(record._id),
    claimId: String(record.claimId),
    source: record.source,
    status: record.status,
    confidence: record.confidence ?? null,
    observedAt: record.observedAt ?? null,
    provider: record.provider ?? null,
    providerVersion: record.providerVersion ?? null,
    evidenceVersion: record.evidenceVersion ?? null,
    evaluationVersion: record.evaluationVersion ?? null,
    reference: record.reference ?? null,
    metadata: record.metadata || {},
    result: record.result ?? null,
    operative: isOperativeEvidenceSource(record.source),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
};

const recordAudit = ({ claimId, action, reason, fromState = null, toState = null, metadata, requestId = null }) =>
  ClaimAudit.create({
    claimId,
    actor: "engine",
    action,
    fromState,
    toState,
    reason,
    metadata,
    requestId,
  });

// Record one canonical evidence row against an owner-scoped claim. Idempotent when an
// idempotencyKey is supplied (replaying the same key returns the existing row — never a
// duplicate, mirroring the claim-creation discipline).
export const recordVerificationEvidence = async ({
  claimId,
  cognitoSub,
  source,
  status = "NOT_CHECKED",
  confidence = null,
  observedAt = null,
  provider = null,
  providerVersion = null,
  evidenceVersion = null,
  evaluationVersion = null,
  reference = null,
  metadata = null,
  result = null,
  idempotencyKey = null,
  requestId = null,
} = {}) => {
  assertValidClaimId(claimId);
  assertValidCognitoSub(cognitoSub);
  const key = validateIdempotencyKey(idempotencyKey);

  // Authority check first: a caller may only write evidence for a claim they own.
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const built = buildVerificationEvidence({
    source,
    status,
    confidence,
    observedAt,
    provider,
    providerVersion,
    evidenceVersion,
    evaluationVersion,
    reference,
    metadata,
    result,
  });

  if (key) {
    const existing = await VerificationEvidence.findOne({
      claimId: claim._id,
      idempotencyKey: key,
    });
    if (existing) return { evidence: serialize(existing), idempotent: true };
  }

  let created;
  try {
    created = await VerificationEvidence.create({
      claimId: claim._id,
      source: built.source,
      status: built.status,
      confidence: built.confidence,
      observedAt: built.observedAt,
      provider: built.provider,
      providerVersion: built.providerVersion,
      evidenceVersion: built.evidenceVersion,
      evaluationVersion: built.evaluationVersion,
      reference: built.reference,
      metadata: built.metadata,
      result: built.result,
      idempotencyKey: key,
    });
  } catch (error) {
    if (error?.code === 11000 && key) {
      const raced = await VerificationEvidence.findOne({ claimId: claim._id, idempotencyKey: key });
      if (raced) return { evidence: serialize(raced), idempotent: true };
    }
    throw error;
  }

  await recordAudit({
    claimId: claim._id,
    action: "evidence_recorded",
    reason: `Verification evidence recorded (${built.source})`,
    fromState: claim.state,
    toState: claim.state,
    metadata: {
      source: built.source,
      status: built.status,
      provider: built.provider,
      providerVersion: built.providerVersion,
      evidenceVersion: built.evidenceVersion,
      operative: built.operative,
    },
    requestId,
  });

  return { evidence: serialize(created), idempotent: false };
};

// Change an evidence row's status (the only allowed mutation). Ownership flows through the
// owning claim; from/to are captured in the append-only audit trail.
export const updateVerificationEvidenceStatus = async ({
  evidenceId,
  cognitoSub,
  status,
  result = undefined,
  requestId = null,
} = {}) => {
  assertValidCognitoSub(cognitoSub);
  if (!evidenceId || !mongoose.isValidObjectId(String(evidenceId))) {
    throw ApiError.badRequest("Valid evidence id is required");
  }
  const statusCheck = validateEvidenceStatus(status);
  if (!statusCheck.ok) throw ApiError.badRequest(statusCheck.reason);

  const evidence = await VerificationEvidence.findById(String(evidenceId));
  if (!evidence) throw ApiError.notFound("Evidence not found");

  const claim = await findOwned(cognitoSub, evidence.claimId);
  if (!claim) throw ApiError.notFound("Evidence not found"); // IDOR-safe: foreign → 404

  // Validate the optional result payload before mutating anything.
  const patch = { status };
  if (result !== undefined) {
    const built = buildVerificationEvidence({
      source: evidence.source,
      status,
      confidence: evidence.confidence,
      observedAt: evidence.observedAt,
      provider: evidence.provider,
      providerVersion: evidence.providerVersion,
      evidenceVersion: evidence.evidenceVersion,
      evaluationVersion: evidence.evaluationVersion,
      reference: evidence.reference,
      metadata: evidence.metadata,
      result,
    });
    patch.result = built.result;
  }

  const fromStatus = evidence.status;
  const updated = await VerificationEvidence.findOneAndUpdate(
    { _id: evidence._id },
    { $set: patch },
    { new: true }
  );

  await recordAudit({
    claimId: claim._id,
    action: "evidence_status_updated",
    reason: `Verification evidence status ${fromStatus} → ${status}`,
    fromState: claim.state,
    toState: claim.state,
    metadata: {
      source: evidence.source,
      fromStatus,
      toStatus: status,
      operative: isOperativeEvidenceSource(evidence.source),
    },
    requestId,
  });

  return serialize(updated);
};

// Owner-scoped read of the persisted evidence rows (optionally filtered by source).
export const listVerificationEvidenceForClaim = async ({ claimId, cognitoSub, source = null } = {}) => {
  assertValidClaimId(claimId);
  assertValidCognitoSub(cognitoSub);

  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const query = { claimId: claim._id };
  if (source) {
    if (!EVIDENCE_SOURCES.includes(source)) throw ApiError.badRequest("Unknown evidence source");
    query.source = source;
  }
  const rows = await VerificationEvidence.find(query).sort({ createdAt: 1 });
  return rows.map(serialize);
};

// Unified, owner-scoped view: the persisted foundation rows PLUS a read-only projection of the
// evidence the existing system already produces (GEOMETRY / AI_IMAGE / WEATHER). No migration,
// no fabrication — existing claims simply project from data they already have.
export const getVerificationEvidenceView = async ({ claimId, cognitoSub } = {}) => {
  assertValidClaimId(claimId);
  assertValidCognitoSub(cognitoSub);

  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const [persisted, assessment, evidenceDocs] = await Promise.all([
    VerificationEvidence.find({ claimId: claim._id }).sort({ createdAt: 1 }),
    ClaimAssessment.findOne({ claimId: claim._id }),
    ClaimEvidence.find({ claimId: claim._id }).lean(),
  ]);

  const existing = projectExistingEvidence({
    claim,
    assessment,
    evidenceDocs,
    weatherCorrelation: assessment ? assessment.weatherCorrelation : null,
  });

  return {
    claimId: String(claim._id),
    foundationVersion: EVIDENCE_FOUNDATION_VERSION,
    persisted: persisted.map(serialize),
    existing,
    operativeSources: [...OPERATIVE_EVIDENCE_SOURCES],
    futureSources: [...FUTURE_EVIDENCE_SOURCES],
    statusVocabulary: [...EVIDENCE_STATUSES],
  };
};

// Legacy-claim safety: a claim is fully usable whether or not it has any foundation rows. This
// is an explicit, cheap read used by tests and future migration tooling (idempotent).
export const claimHasVerificationEvidence = async (claimId) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) return false;
  const count = await VerificationEvidence.countDocuments({ claimId });
  return count > 0;
};

export default {
  recordVerificationEvidence,
  updateVerificationEvidenceStatus,
  listVerificationEvidenceForClaim,
  getVerificationEvidenceView,
  claimHasVerificationEvidence,
};
