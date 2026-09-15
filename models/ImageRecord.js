import mongoose from "mongoose";

// E3 (D-22 Option 1 / D-23): image metadata record. MongoDB stores metadata ONLY —
// never binary (07_Database_Design: no binary-in-Mongo). The normalized image itself
// lives in private S3 (services/s3.service.js); this document records where it is, how
// it was stored, and the outcome of the vision + reasoning pipeline that consumed it.
//
// Ownership is scoped by the authenticated user's cognitoSub (E1-S5, D-35). uploadId is
// always server-generated (`img_<uuid>`); it is never derived from, or derived to, any
// client-supplied filename, and never exposed through S3 keys in API responses.

const visionIssueSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    type: {
      type: String,
      enum: ["pest", "disease", "deficiency", "environmental", "other"],
      default: "other",
    },
    confidence: {
      type: String,
      enum: ["high", "medium", "low", "uncertain"],
      default: "low",
    },
    evidence: { type: [String], default: [] },
  },
  { _id: false }
);

const visionResultSchema = new mongoose.Schema(
  {
    crop: { type: String, default: null },
    symptoms: { type: [String], default: [] },
    likelyIssues: { type: [visionIssueSchema], default: [] },
    confidence: {
      type: String,
      enum: ["high", "medium", "low", "unclear"],
      default: "unclear",
    },
    uncertain: { type: Boolean, default: true },
    summary: { type: String, default: null },
  },
  { _id: false }
);

const imageRecordSchema = new mongoose.Schema(
  {
    // E1-S5 (D-35): ownership scoped by the authenticated user's stable cognitoSub
    // (immutable, non-spoofable). userEmail is retained as a display/legacy key.
    cognitoSub: { type: String, required: true, index: true },
    userEmail: { type: String },
    // Server-generated image identifier: `img_<uuid>`.
    uploadId: { type: String, required: true, unique: true },
    // Object key in private S3. Never exposed to clients and never built from a
    // client-supplied filename.
    s3Key: { type: String, required: true },
    // Original (as-received) transport metadata.
    mediaType: { type: String, required: true },
    size: { type: Number, required: true },
    // Normalized image actually stored in S3 (dimension-capped, EXIF-stripped re-encode).
    processed: {
      mediaType: { type: String, required: true },
      size: { type: Number, required: true },
      width: { type: Number, required: true },
      height: { type: Number, required: true },
    },
    // Pipeline state machine: stored → processing → completed | failed.
    status: {
      type: String,
      enum: ["stored", "processing", "completed", "failed"],
      default: "stored",
    },
    // Chat session the image was diagnosed in (first owned session that ran analysis).
    chatSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatSession",
      default: null,
    },
    // Structured vision observation (parsed + normalized JSON).
    vision: { type: visionResultSchema, default: null },
    // Final farmer-facing response from the last analysis.
    response: {
      text: { type: String, default: null },
      language: { type: String, enum: ["en", "ta", null], default: null },
    },
    // Sanitized internal error state (debugging only — never echoed verbatim to clients;
    // the API error handler returns only the generic routing message).
    error: {
      stage: { type: String, default: null },
      message: { type: String, default: null },
    },
  },
  { timestamps: true }
);

// The two access paths are: by uploadId+owner (single upload) and by owner (chronological
// list). Both are indexed so a user's image history stays cheap; uploadId is globally
// unique and also unique-indexed.
imageRecordSchema.index({ cognitoSub: 1, createdAt: -1 });

export default mongoose.model("ImageRecord", imageRecordSchema);