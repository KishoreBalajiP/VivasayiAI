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

// `cancelled` (additive): the job will never run because its claim was withdrawn or decided by a
// person (see cancelJobsForClaim). It is finished, like succeeded or dead.
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead", "cancelled"];

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
    // `kind`/`retryable`/`at` (additive, ADR-022) classify the failure with utils/providerErrors.js,
    // so the queue can cap application defects and the dead-job sweep can tell a quota refusal (worth
    // retrying later) from a missing key (a person has to act first). `message` is sanitized.
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      kind: { type: String, default: null },
      retryable: { type: Boolean, default: null },
      at: { type: Date, default: null },
    },
    resultSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    // Set when the job is cancelled before it ran (additive).
    cancelledAt: { type: Date, default: undefined },
    cancelReason: { type: String, default: undefined },
    // How often the step asked to run again later (`rescheduleAt`) instead of finishing (additive).
    // Attempts are not consumed by that, so this count is what bounds an engine that keeps reporting
    // "in progress" (see runJob).
    rescheduleCount: { type: Number, default: 0 },

    // --- ADR-022 (additive). Absent on rows written before these fields existed. ---
    // The plan this job belongs to: `r<submissionRound>` for the plan a submit or resubmit builds,
    // `r<round>:ev:<evidence version>` / `r<round>:doc:<evidenceId>` for late evidence. A unique
    // index (below) makes "each planned step runs once per plan" a database guarantee, so a repeated
    // submit can re-run ensurePlan to recover a lost plan without re-running finished steps.
    // Recovery and re-evaluation jobs carry no planKey; they are deduplicated by `activeKey` only.
    planKey: { type: String, default: undefined },
    // The HTTP request that created the job, and the claim round it serves (`clm_<id>_r<round>`).
    requestId: { type: String, default: null },
    correlationId: { type: String, default: null },
    // Lifecycle times of the step itself (the document's own createdAt/updatedAt also move on lease
    // renewals and put-backs, so they say nothing about progress).
    startedAt: { type: Date, default: null }, // first time the step actually ran
    lastAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    deadAt: { type: Date, default: null },
    // The last attempts (at most 10): when each ran and how it ended.
    attemptLog: {
      type: [
        new mongoose.Schema(
          {
            attempt: { type: Number, default: null },
            at: { type: Date, default: null },
            outcome: { type: String, default: null },
            code: { type: String, default: null },
            kind: { type: String, default: null },
            durationMs: { type: Number, default: null },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    // Dead-job recovery (requeueDeadJobs): the new job points at the dead one it replaces and counts
    // the recovery rounds; the dead row keeps its history and records when it was re-queued.
    recoveryRound: { type: Number, default: 0 },
    recoveredFrom: { type: mongoose.Schema.Types.ObjectId, default: null },
    requeuedAt: { type: Date, default: null },
    // Late evidence (a photo or a document added after submit) arrived while this job was RUNNING, so
    // the run may have read the evidence as it was before. Set by enqueue (`rerunIfRunning`); runJob
    // then queues the step once more instead of finishing it. Absent when never requested.
    rerunRequested: { type: Boolean, default: undefined },
  },
  { timestamps: true }
);

verificationJobSchema.index({ status: 1, runAt: 1 });
verificationJobSchema.index(
  { activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: { $type: "string" } } }
);
// ADR-022: one job per step per plan. Partial on string keys, so legacy rows and recovery jobs
// (no planKey) are not indexed and can never collide.
verificationJobSchema.index(
  { claimId: 1, step: 1, planKey: 1 },
  { unique: true, partialFilterExpression: { planKey: { $type: "string" } } }
);

export default mongoose.model("VerificationJob", verificationJobSchema);
