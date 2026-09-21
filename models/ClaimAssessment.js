import mongoose from "mongoose";

// F-49 (ADR-019) — Deterministic Verification Result (07_Database_Design §8).
//
// Phase 2 creates the persistence STRUCTURE ONLY: no row is ever written until the
// deterministic rule engine ships (E9-S3/S4 — no LLM in the decision path). All fields are
// nullable and never fabricated; the claim detail response returns it as `assessment: null`
// until then.

const aiAggregateSchema = new mongoose.Schema(
  {
    damageDetected: { type: Boolean, default: null },
    damageType: { type: String, default: null },
    severity: { type: String, default: null },
    confidence: { type: String, default: null },
    uncertain: { type: Boolean, default: true },
    inconsistencies: { type: [String], default: [] },
    imageCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const weatherCorrelationSchema = new mongoose.Schema(
  {
    eventMatch: { type: Boolean, default: null },
    precipitationMm: { type: Number, default: null },
    weatherCode: { type: Number, default: null },
    source: { type: String, default: null },
  },
  { _id: false }
);

const rulesSchema = new mongoose.Schema(
  {
    areaCheck: { passed: Boolean, remainingEligible: Number },
    overlapCheck: { passed: Boolean, overlapArea: Number },
    aiCheck: { passed: Boolean, reason: String },
    weatherCheck: { passed: Boolean, reason: String },
    eventTypeCheck: { passed: Boolean },
    timelinessCheck: { passed: Boolean },
  },
  { _id: false }
);

const claimAssessmentSchema = new mongoose.Schema(
  {
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LossClaim",
      required: true,
      unique: true,
    },
    approvedGeometry: { type: Object, default: null },
    approvedAreaAcres: { type: Number, default: null },
    aiAggregate: { type: aiAggregateSchema, default: null },
    weatherCorrelation: { type: weatherCorrelationSchema, default: null },
    rules: { type: rulesSchema, default: null },
    state: { type: String, default: null }, // mirrors claim.state at decision time
    reason: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: String, enum: ["engine", "admin"], default: "engine" },
    adminNote: { type: String, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("ClaimAssessment", claimAssessmentSchema);