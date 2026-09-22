import mongoose from "mongoose";

// F-49 (ADR-019) — Deterministic Verification Result (07_Database_Design §8).
//
// Phase 2/3 created the persistence STRUCTURE ONLY: no row was written until the verification
// phases. Phase 4 (E9-S4) writes the AI-EVIDENCE stage: `status` / `startedAt` / `completedAt` /
// `failedAt`, `version`, `model`, `evidenceVersion`, `aiImageAssessments` (per-image frozen
// observations + evidence references) and `aiAggregate` (deterministic cross-image aggregate).
// Phase 5 (E9-S5) writes the FINAL decision stage via the deterministic verification engine:
// `rules`, `state`, `reason`, `decidedAt`, `decidedBy` ("engine"), approved geometry/area for
// verified claims, and the `verification` lifecycle subdocument. All fields are additive
// (07 §14 rule 1 — nothing removed). `adminNote` / `weatherCorrelation` stay null (admin is
// exception-only P7; weather is supporting-only P3 and none is wired in Phase 5).

const aiImageObservationSchema = new mongoose.Schema(
  {
    // FROZEN claim-loss observation contract (ADR-019 / 09 §6.1 / E9-S4). `null` = the AI
    // could not determine the value from the evidence. `inconsistencies` captures both the
    // model's own notes and normalizer guardrail events (unauthorized fields stripped).
    cropDetected: { type: String, default: null },
    damageDetected: { type: Boolean, default: null },
    damageType: { type: String, default: null },
    severity: { type: String, default: null },
    visibleAffectedPortion: { type: String, default: null },
    confidence: { type: String, default: null },
    uncertain: { type: Boolean, default: true },
    inconsistencies: { type: [String], default: [] },
    observations: { type: [String], default: [] },
    imageQuality: { type: String, default: null },
  },
  { _id: false }
);

const aiImageAssessmentSchema = new mongoose.Schema(
  {
    evidenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClaimEvidence",
      required: true,
    },
    uploadId: { type: String, required: true }, // display reference only; never an s3Key
    observation: { type: aiImageObservationSchema, required: true },
  },
  { _id: false }
);

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

// E9-S5 (ADR-019) — deterministic verification lifecycle (additive, 07 §8). Written by the claim
// verification service: `status: "verifying"` while the pure engine decision is being persisted,
// `"completed"` after the decision (with claim transition), `"failed"` on a retryable internal
// gate failure (stage is sanitized; the claim is NOT transitioned on failure).
const verificationSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["pending", "verifying", "completed", "failed"],
      default: "pending",
    },
    version: { type: String, default: null }, // VERIFICATION_ENGINE_VERSION
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    error: {
      stage: { type: String, default: null },
      message: { type: String, default: null },
    },
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
    // --- Phase 4 (E9-S4) AI-evidence stage fields ---
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
    },
    // Assessment configuration/prompt version (src/ai/ClaimLossVisionTemplates.js). Distinguishes
    // results generated under different prompt/schema versions; never silently overwritten.
    version: { type: String, default: null },
    // Provider/model identifier captured at run time (`provider/model`).
    model: { type: String, default: null },
    // Fingerprint of the assessed evidence set (stable even when an assessment is reused).
    evidenceVersion: { type: String, default: null },
    // Per-image frozen observations with evidence references (reproducibility; no raw image bytes).
    aiImageAssessments: { type: [aiImageAssessmentSchema], default: [] },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    // Sanitized processing error (stage + short message). Never contains provider internals,
    // prompts, URLs, keys, or image content.
    error: {
      stage: { type: String, default: null },
      message: { type: String, default: null },
    },
    // --- E9-S5 (Phase 5) — final deterministic decision (written by the verification engine) ---
    approvedGeometry: { type: Object, default: null },
    approvedAreaAcres: { type: Number, default: null },
    aiAggregate: { type: aiAggregateSchema, default: null },
    weatherCorrelation: { type: weatherCorrelationSchema, default: null },
    rules: { type: rulesSchema, default: null },
    state: { type: String, default: null }, // mirrors claim.state at decision time
    reason: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: String, enum: ["engine", "admin"], default: "engine" },
    adminNote: { type: String, default: null }, // admin override only (P7, exception-only)
    // E9-S5 — deterministic verification lifecycle (written by the verification service only).
    verification: { type: verificationSchema, default: () => ({}) },
  },
  { timestamps: true }
);

export default mongoose.model("ClaimAssessment", claimAssessmentSchema);