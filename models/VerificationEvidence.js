import mongoose from "mongoose";
import {
  EVIDENCE_SOURCES,
  EVIDENCE_STATUSES,
} from "../utils/verificationEvidence.js";

// Phase 11 (E11-S11) — Verification Evidence Foundation (07_Database_Design §10).
//
// A generic, source-neutral evidence row for the claim verification system. It supplements —
// never replaces — the existing image-specific `ClaimEvidence` collection (which is bound to the
// presigned-S3 upload lifecycle and cannot represent GEOMETRY/WEATHER/OWNERSHIP/SATELLITE). It
// also does not touch `ClaimAssessment` (the deterministic decision record). This collection is
// the plug-in surface for future Ownership Verification (Phase 12) and Satellite Verification
// (Phase 13+).
//
// Append-friendly + auditable: rows are created by services/verificationEvidence.service.js, and
// every create/status change also appends an immutable `ClaimAudit` entry. `source` and `status`
// are the frozen Phase 11 vocabularies (utils/verificationEvidence.js). `status` is an
// EVIDENCE-level state — it is never a claim lifecycle state and never copied into `claim.state`.
//
// Source-neutral by design: it carries only generic provider/version/timestamp/metadata/result
// fields. No ownership-document or satellite-provider specific column is introduced in this phase.

const verificationEvidenceSchema = new mongoose.Schema(
  {
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LossClaim",
      required: true,
      index: true,
    },
    source: { type: String, enum: EVIDENCE_SOURCES, required: true },
    status: { type: String, enum: EVIDENCE_STATUSES, default: "NOT_CHECKED" },
    // Normalized confidence in [0, 1] when the source can express one; null otherwise.
    confidence: { type: Number, default: null, min: 0, max: 1 },
    // When the evidence was observed / collected (provider time), not when the row was written.
    observedAt: { type: Date, default: null },
    provider: { type: String, default: null },
    providerVersion: { type: String, default: null },
    // Fingerprint of the evidence set/version this row represents (idempotency boundary).
    evidenceVersion: { type: String, default: null },
    // Version of the evaluation/verification logic that produced the record (engine/provider).
    evaluationVersion: { type: String, default: null },
    // Opaque, non-secret reference the owning phase uses to locate its own evidence (e.g. an
    // uploadId / observation id). NEVER an s3Key or signed URL.
    reference: { type: String, default: null },
    // Safe, source-neutral context (see validateEvidencePayload) — no storage internals/secrets.
    metadata: { type: Object, default: {} },
    // Consistency/outcome information when applicable (e.g. { consistent, code, note }).
    result: { type: Object, default: null },
    // Optional owner-supplied idempotency key; uniqueness is CLAIM-scoped (compound sparse index).
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true }
);

verificationEvidenceSchema.index({ claimId: 1, source: 1, createdAt: -1 });
// Idempotency is CLAIM-scoped and only applies when a key is supplied. A partial index (string
// type) is used instead of sparse because rows without a key store the field as `null`, which a
// sparse index would still consider present (and collide on).
verificationEvidenceSchema.index(
  { claimId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

export default mongoose.model("VerificationEvidence", verificationEvidenceSchema);
