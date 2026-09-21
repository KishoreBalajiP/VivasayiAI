import mongoose from "mongoose";

// F-49 (ADR-019) — Append-only Claim Audit Trail (07_Database_Design §9).
//
// NEVER updated or deleted; only appended. Farmer actions (created → submitted → withdrawn /
// resubmitted) are written here during claim transitions. Engine/admin actions arrive with the
// verification phases. `createdAt` is server-set; `updatedAt` is suppressed (append-only).

const claimAuditSchema = new mongoose.Schema(
  {
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LossClaim",
      required: true,
      index: true,
    },
    actor: { type: String, enum: ["farmer", "engine", "admin"], required: true },
    // "created", "submitted", "withdrawn", "resubmitted", … (07 §9, action is free-form).
    action: { type: String, required: true },
    fromState: { type: String, default: null },
    toState: { type: String, default: null },
    reason: { type: String, default: null },
    metadata: { type: Object, default: {} },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

claimAuditSchema.index({ claimId: 1, createdAt: 1 });

export default mongoose.model("ClaimAudit", claimAuditSchema);