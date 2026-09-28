import mongoose from "mongoose";

// Phase 10 (E9-S10) — Farmer Appeal (07_Database_Design §15).
//
// A farmer may appeal ONLY eligible engine decisions (rejected / out_of_limit /
// duplicate_area / more_evidence_required). Terminal states remain protected: an appeal never
// mutates the claim state directly — it opens a review that only an admin override (with an
// immutable audit entry + reason + actor + requestId) may close by deciding the claim.
//
// Contract:
//  - One ACTIVE appeal per claim at a time (partial unique index below). A resolved appeal is
//    terminal; a farmer may submit a NEW appeal only after the previous one was resolved.
//  - `evidence[]` is an additive snapshot of the additional evidence uploadIds the farmer
//    attached to the appeal (server-recorded via the claim-evidence pipeline while the appeal
//    is active). It never contains s3Keys or signed URLs.
//  - `decision` is written only when an admin resolves the appeal (via override or by
//    upholding the current decision). `adminNote` is the internal justification.

export const APPEAL_STATUSES = ["submitted", "under_review", "resolved"];

export const APPEAL_ELIGIBLE_STATES = [
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "more_evidence_required",
];

const appealEvidenceSchema = new mongoose.Schema(
  {
    uploadId: { type: String, required: true },
    mediaType: { type: String, default: null },
    size: { type: Number, default: null },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false }
);

const appealDecisionSchema = new mongoose.Schema(
  {
    // "upheld" — the current decision stands; "overridden" — an admin override changed it.
    kind: { type: String, enum: ["upheld", "overridden"], default: null },
    toState: { type: String, default: null },
    reason: { type: String, default: null },
    adminNote: { type: String, default: null },
    decidedBySub: { type: String, default: null },
    decidedAt: { type: Date, default: null },
  },
  { _id: false }
);

const appealSchema = new mongoose.Schema(
  {
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LossClaim",
      required: true,
    },
    // Farmer who owns the appeal (must match the claim's owner; server-verified).
    cognitoSub: { type: String, required: true, index: true },
    status: { type: String, enum: APPEAL_STATUSES, default: "submitted", index: true },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    statement: { type: String, default: null, trim: true, maxlength: 4000 },
    evidence: { type: [appealEvidenceSchema], default: [] },
    decision: { type: appealDecisionSchema, default: null },
    resolvedAt: { type: Date, default: null },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One active (non-resolved) appeal per claim.
appealSchema.index(
  { claimId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["submitted", "under_review"] } },
  }
);
appealSchema.index({ claimId: 1, createdAt: -1 });

export default mongoose.model("Appeal", appealSchema);