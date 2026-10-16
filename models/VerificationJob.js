import mongoose from "mongoose";

// ADR-021 — one unit of automated verification work for a claim, stored in MongoDB.
//
// AWS Lambda freezes the execution environment as soon as the HTTP response is sent, so the old
// fire-and-forget pipeline could simply never finish. A job row survives that: whoever runs next
// (the verify call, a status read, or a scheduled worker) claims due jobs with an atomic update,
// and a job whose lease expired is picked up again. No extra AWS service is required; the same
// rows can later be fed from SQS or EventBridge without changing the data model.

export const JOB_STEPS = [
  "ai_assessment",
  "land_documents",
  "official_land_record",
  "satellite",
  "weather",
  "engine",
];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead"];

const verificationJobSchema = new mongoose.Schema(
  {
    claimId: { type: mongoose.Schema.Types.ObjectId, ref: "LossClaim", required: true, index: true },
    cognitoSub: { type: String, required: true },
    step: { type: String, enum: JOB_STEPS, required: true },
    status: { type: String, enum: JOB_STATUSES, default: "queued" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAt: { type: Date, default: () => new Date() },
    leaseOwner: { type: String, default: null },
    leaseUntil: { type: Date, default: null },
    // `${claimId}:${step}` while the job is active (queued or running); removed when it finishes.
    // The unique partial index below makes "at most one active job per claim and step" a database
    // guarantee, so duplicate triggers and concurrent submits cannot create duplicate work.
    activeKey: { type: String, default: undefined },
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
    resultSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

verificationJobSchema.index({ status: 1, runAt: 1 });
verificationJobSchema.index(
  { activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: { $type: "string" } } }
);

export default mongoose.model("VerificationJob", verificationJobSchema);
