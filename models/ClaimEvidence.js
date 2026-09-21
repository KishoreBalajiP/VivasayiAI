import mongoose from "mongoose";

// F-49 (ADR-019) — Claim Evidence image (07_Database_Design §7).
//
// Reuses the existing presigned-S3 pipeline (same states as ImageRecord), scoped by claimId
// instead of cognitoSub. Phase 2 fills status → stored + server-measured size/width/height on
// complete. `exifGps` / `perceptualHash` / `aiAssessment` are reserved (null) — populated by
// the later evidence-storage phase (E9-S6); never computed or trusted here.

const aiAssessmentSchema = new mongoose.Schema(
  {
    cropDetected: { type: String, default: null },
    damageDetected: { type: Boolean, default: null },
    damageType: { type: String, default: null },
    severity: { type: String, default: null },
    confidence: { type: String, default: null },
    uncertain: { type: Boolean, default: true },
    visibleAffectedPortion: { type: String, default: null },
    imageQuality: { type: String, default: null },
    observations: { type: [String], default: [] },
  },
  { _id: false }
);

const claimEvidenceSchema = new mongoose.Schema(
  {
    claimId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LossClaim",
      required: true,
      index: true,
    },
    // Server-generated image identifier: `img_<uuid>`. Never client-supplied.
    uploadId: { type: String, required: true, unique: true },
    // Owner-scoped private-S3 key: `claims/<claimId>/<uploadId>/image.<ext>` inside the upload
    // namespace (services/s3.service.js buildObjectKey). Never exposed to clients.
    s3Key: { type: String, required: true },
    mediaType: { type: String, required: true },
    size: { type: Number, required: true }, // declared at presign; server-measured on store
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    exifGps: {
      lat: { type: Number, default: null },
      lon: { type: Number, default: null },
      accuracy: { type: Number, default: null },
    },
    perceptualHash: { type: String, default: null }, // E9-S6 dedup — not Phase 2
    aiAssessment: { type: aiAssessmentSchema, default: null },
    uploadedAt: { type: Date, default: null },
    // Presigned-pipeline lifecycle (ImageRecord-compatible): pending → uploaded → stored | failed.
    status: {
      type: String,
      enum: ["pending", "uploaded", "stored", "processing", "completed", "failed"],
      default: "pending",
    },
  },
  { timestamps: true }
);

claimEvidenceSchema.index({ claimId: 1, uploadedAt: 1 });

export default mongoose.model("ClaimEvidence", claimEvidenceSchema);