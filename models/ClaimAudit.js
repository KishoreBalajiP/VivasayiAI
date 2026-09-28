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

// Phase 10 (E9-S10) — enforce append-only behavior at the Mongoose layer (07 §9). The audit is
// the immutable source of truth for every claim event; no app path may ever update or delete an
// existing row. (deleteMany stays available for test/maintenance tooling — no application code
// path uses it.)
claimAuditSchema.pre("findOneAndUpdate", function () {
  throw new Error("ClaimAudit is append-only");
});
claimAuditSchema.pre("updateOne", function () {
  throw new Error("ClaimAudit is append-only");
});
claimAuditSchema.pre("findOneAndDelete", function () {
  throw new Error("ClaimAudit is append-only");
});
claimAuditSchema.pre("deleteOne", function () {
  throw new Error("ClaimAudit is append-only");
});
claimAuditSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(new Error("ClaimAudit is append-only"));
  }
  return next();
});

claimAuditSchema.index({ claimId: 1, createdAt: 1 });

export default mongoose.model("ClaimAudit", claimAuditSchema);