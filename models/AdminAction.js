import mongoose from "mongoose";

// Phase 10 (E9-S10) — Immutable Admin Action (07_Database_Design §15).
//
// The durable record of every admin decision (override / appeal resolution / manual review).
// Append-only like ClaimAudit: never updated, never deleted. Every row IS an audit entry —
// actor (sub + email), timestamp (createdAt), requestId, prior state, target state and reason
// are all mandatory so an override is NEVER silent.
//
// Replay protection / idempotency: `idempotencyKey` is unique per claim+action (sparse), so the
// same override request retried after a dropped response cannot double-apply.

export const ADMIN_ACTIONS = ["override", "appeal_resolution", "manual_review"];

const adminActionSchema = new mongoose.Schema(
  {
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LossClaim",
      required: true,
      index: true,
    },
    action: { type: String, enum: ADMIN_ACTIONS, required: true },
    // Admin identity from the verified session token — never from the request body.
    actorSub: { type: String, required: true },
    actorEmail: { type: String, default: null },
    priorState: { type: String, default: null },
    targetState: { type: String, default: null },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    adminNote: { type: String, default: null, trim: true, maxlength: 4000 },
    // Optional second-admin approval (for high-acreage overrides when configured).
    approverSub: { type: String, default: null },
    appealId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appeal",
      default: null,
    },
    // Client-supplied idempotency key for replay protection (owner/claim-scoped unique).
    idempotencyKey: { type: String, default: null },
    // Snapshot of the decision surface at override time (remaining eligible, verified acres…).
    metadata: { type: Object, default: {} },
    requestId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Replay protection: one admin action per idempotencyKey per claim.
adminActionSchema.index({ claimId: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
adminActionSchema.index({ claimId: 1, createdAt: 1 });

// Append-only guards (ClaimAudit §9 same discipline).
adminActionSchema.pre("findOneAndUpdate", function () {
  throw new Error("AdminAction is append-only");
});
adminActionSchema.pre("updateOne", function () {
  throw new Error("AdminAction is append-only");
});
adminActionSchema.pre("findOneAndDelete", function () {
  throw new Error("AdminAction is append-only");
});
adminActionSchema.pre("deleteOne", function () {
  throw new Error("AdminAction is append-only");
});
adminActionSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(new Error("AdminAction is append-only"));
  }
  return next();
});

export default mongoose.model("AdminAction", adminActionSchema);