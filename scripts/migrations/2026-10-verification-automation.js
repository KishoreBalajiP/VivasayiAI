import mongoose from "mongoose";
import { isLocalMongoUri } from "../worker.js";
import LossClaim from "../../models/LossClaim.js";
import ClaimAudit from "../../models/ClaimAudit.js";
import ClaimAssessment from "../../models/ClaimAssessment.js";
import VerificationEvidence from "../../models/VerificationEvidence.js";
import VerificationJob from "../../models/VerificationJob.js";
import { cancelJobsForClaim } from "../../services/verificationJobs.service.js";
import { releaseStuckProcessingClaims, STUCK_PROCESSING_AFTER_MS } from "../../services/verificationWorker.service.js";

// ADR-022 data migration for automated verification. DRY-RUN BY DEFAULT: without --apply it only
// reads and reports. Every change is additive and idempotent: a second --apply reports no changes.
//
//   node scripts/migrations/2026-10-verification-automation.js            # dry run (read-only)
//   node scripts/migrations/2026-10-verification-automation.js --apply    # write the changes
//
// --apply against any database not on this machine (Atlas or a remote mongodb:// host) is refused unless MIGRATION_ALLOW_REMOTE_APPLY=true.
// The dry run connects with autoIndex/autoCreate off, so it builds no index and creates no collection.
//
// Changes (with --apply):
//   1. LossClaim.firstSubmittedAt from the earliest `submitted` audit row, and LossClaim.submissionRound
//      from the number of `submitted` + `resubmitted` audit rows (only where the field is unset);
//   2. the unique partial VerificationJob index { claimId, step, planKey } (no existing row has a
//      planKey, so it cannot conflict);
//   3. queued jobs of withdrawn or deleted claims are cancelled;
//   4. claims stuck in `processing` (no decision written) are returned to `submitted` and their
//      engine is queued (the worker does the same on every run).
// Reported only (history is never rewritten):
//   dead jobs by step and error code; assessments stuck in `processing`; `submitted` claims with no
//   job and no decision (the worker's reconcile sweep will plan them); dead-job review cases labelled
//   OWNERSHIP for a step that is not a document step (written before the labels existed).

export const PLAN_INDEX_NAME = "claimId_1_step_1_planKey_1";
const ASSESSMENT_STUCK_AFTER_MS = 10 * 60 * 1000;
const DOCUMENT_STEPS = ["land_documents", "official_land_record"];

// Any database not on this machine counts as remote: a mongodb+srv (Atlas) URI, or a plain
// mongodb:// URI naming a non-loopback host. Same rule as the worker (scripts/worker.js).
export const isRemoteUri = (uri) => !isLocalMongoUri(uri);

// Writing to a remote database needs an explicit, separate opt-in.
export const assertApplyAllowed = ({ apply, mongoUri, environment = process.env }) => {
  if (apply && isRemoteUri(mongoUri) && environment.MIGRATION_ALLOW_REMOTE_APPLY !== "true") {
    throw new Error("Refusing --apply against a database that is not on this machine. Run the dry run, review it, and set MIGRATION_ALLOW_REMOTE_APPLY=true to write.");
  }
};

const log = (lines, message) => lines.push(message);
const verb = (dryRun, would, did) => (dryRun ? would : did);

// 1. First-submission time and submission round for claims submitted before the fields existed.
const backfillSubmissions = async ({ dryRun, summary, lines }) => {
  const candidates = LossClaim.find({
    state: { $ne: "draft" },
    $or: [{ firstSubmittedAt: null }, { submissionRound: { $in: [0, null] } }, { submissionRound: { $exists: false } }],
  })
    .select("_id state submittedAt firstSubmittedAt submissionRound")
    .lean()
    .cursor();

  for await (const claim of candidates) {
    const audits = await ClaimAudit.find({ claimId: claim._id, action: { $in: ["submitted", "resubmitted"] } })
      .sort({ createdAt: 1, _id: 1 })
      .select("action createdAt")
      .lean();
    // A claim withdrawn from draft was never submitted: nothing to backfill.
    if (audits.length === 0 && !claim.submittedAt) continue;

    const set = {};
    if (!claim.firstSubmittedAt) {
      const first = audits.find((row) => row.action === "submitted") || audits[0] || null;
      const value = (first && first.createdAt) || claim.submittedAt || null;
      if (value) set.firstSubmittedAt = value;
    }
    if (!claim.submissionRound) {
      set.submissionRound = Math.max(audits.length, 1);
    }
    if (Object.keys(set).length === 0) continue;

    if (set.firstSubmittedAt) summary.changes.firstSubmittedAtBackfilled += 1;
    if (set.submissionRound) summary.changes.submissionRoundBackfilled += 1;
    if (!dryRun) {
      // Only fields that are still unset are written, so a concurrent submit is never overwritten.
      if (set.firstSubmittedAt) await LossClaim.updateOne({ _id: claim._id, firstSubmittedAt: null }, { $set: { firstSubmittedAt: set.firstSubmittedAt } });
      if (set.submissionRound) {
        await LossClaim.updateOne(
          { _id: claim._id, $or: [{ submissionRound: { $in: [0, null] } }, { submissionRound: { $exists: false } }] },
          { $set: { submissionRound: set.submissionRound } }
        );
      }
    }
  }
  log(lines, `claims firstSubmittedAt: ${summary.changes.firstSubmittedAtBackfilled} ${verb(dryRun, "would be backfilled", "backfilled")}`);
  log(lines, `claims submissionRound: ${summary.changes.submissionRoundBackfilled} ${verb(dryRun, "would be backfilled", "backfilled")}`);
};

// 2. The plan index.
const ensurePlanIndex = async ({ dryRun, summary, lines }) => {
  const indexes = await VerificationJob.collection.indexes().catch(() => []);
  const current = indexes.find((index) => index.name === PLAN_INDEX_NAME);
  const upToDate = Boolean(current && current.unique && current.partialFilterExpression);
  if (upToDate) {
    log(lines, `index verificationjobs.${PLAN_INDEX_NAME}: already up to date`);
    return;
  }
  summary.changes.indexesCreated += 1;
  log(lines, `index verificationjobs.${PLAN_INDEX_NAME}: ${verb(dryRun, "would be created", "created")}`);
  if (dryRun) return;
  if (current) await VerificationJob.collection.dropIndex(PLAN_INDEX_NAME);
  await VerificationJob.createIndexes();
};

// 3. Queued jobs that can never be useful.
const cancelOrphanJobs = async ({ dryRun, summary, lines }) => {
  const claimIds = await VerificationJob.distinct("claimId", { status: "queued" });
  for (const claimId of claimIds) {
    const claim = await LossClaim.findById(claimId).select("state").lean();
    if (claim && claim.state !== "withdrawn") continue;
    const queued = await VerificationJob.countDocuments({ claimId, status: "queued" });
    summary.changes.jobsCancelled += queued;
    if (!dryRun) await cancelJobsForClaim({ claimId, reason: claim ? "claim_withdrawn" : "claim_missing" });
  }
  log(lines, `queued jobs of withdrawn or deleted claims: ${summary.changes.jobsCancelled} ${verb(dryRun, "would be cancelled", "cancelled")}`);
};

// 4. Claims stuck in processing (shared with the worker sweep).
const releaseStuckClaims = async ({ dryRun, now, summary, lines }) => {
  let released = 0;
  // The worker sweep handles 50 at a time; a migration takes them all.
  for (;;) {
    const batch = await releaseStuckProcessingClaims({ now, stuckAfterMs: STUCK_PROCESSING_AFTER_MS, limit: 200, dryRun });
    released += batch.released;
    if (dryRun || batch.released === 0 || batch.checked < 200) break;
  }
  summary.changes.stuckClaimsReleased = released;
  log(lines, `claims stuck in processing: ${released} ${verb(dryRun, "would be released", "released")}`);
};

// Reports only.
const reportFindings = async ({ now, summary, lines }) => {
  const dead = await VerificationJob.aggregate([
    { $match: { status: "dead" } },
    { $group: { _id: { step: "$step", code: "$lastError.code" }, count: { $sum: 1 } } },
    { $sort: { "_id.step": 1, "_id.code": 1 } },
  ]);
  summary.findings.deadJobs = dead.map((row) => ({ step: row._id.step, code: row._id.code ?? null, count: row.count }));
  log(lines, `dead jobs: ${dead.reduce((total, row) => total + row.count, 0)}${dead.length ? ` (${summary.findings.deadJobs.map((row) => `${row.step}/${row.code}: ${row.count}`).join(", ")})` : ""}`);

  const staleBefore = new Date(now.getTime() - ASSESSMENT_STUCK_AFTER_MS);
  summary.findings.assessmentsStuckProcessing = await ClaimAssessment.countDocuments({
    status: "processing",
    $or: [
      { slotLeaseUntil: { $lte: now } },
      { slotLeaseUntil: null, startedAt: { $lte: staleBefore } },
      { slotLeaseUntil: null, startedAt: null },
    ],
  });
  log(lines, `assessments stuck in processing: ${summary.findings.assessmentsStuckProcessing} (the next photo check takes them over)`);

  let orphans = 0;
  const submitted = LossClaim.find({ state: "submitted" }).select("_id").lean().cursor();
  for await (const claim of submitted) {
    const [hasJob, decided] = await Promise.all([
      VerificationJob.exists({ claimId: claim._id }),
      ClaimAssessment.exists({ claimId: claim._id, state: { $ne: null } }),
    ]);
    if (!hasJob && !decided) orphans += 1;
  }
  summary.findings.submittedWithoutJobs = orphans;
  log(lines, `submitted claims with no job and no decision: ${orphans} (the worker's reconcile sweep plans them)`);

  summary.findings.mislabelledReviewCases = await VerificationEvidence.countDocuments({
    source: "OWNERSHIP",
    "metadata.kind": "review_case",
    "metadata.failedStep": { $exists: true, $nin: DOCUMENT_STEPS },
  });
  log(lines, `dead-job review cases labelled OWNERSHIP for another step: ${summary.findings.mislabelledReviewCases} (reported only)`);
};

export const migrate = async ({ apply = false, now = new Date() } = {}) => {
  const dryRun = !apply;
  const lines = [];
  const summary = {
    dryRun,
    changes: {
      firstSubmittedAtBackfilled: 0,
      submissionRoundBackfilled: 0,
      indexesCreated: 0,
      jobsCancelled: 0,
      stuckClaimsReleased: 0,
    },
    findings: {},
  };
  await backfillSubmissions({ dryRun, summary, lines });
  await ensurePlanIndex({ dryRun, summary, lines });
  await cancelOrphanJobs({ dryRun, summary, lines });
  await releaseStuckClaims({ dryRun, now, summary, lines });
  await reportFindings({ now, summary, lines });
  return { summary, lines };
};

// Command-line entry point. The guard runs BEFORE any connection is opened. Importing the services
// can open long-lived clients, so the process exits explicitly.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let exitCode = 0;
  try {
    const apply = process.argv.includes("--apply");
    const { env, validateEnv } = await import("../../config/env.js");
    validateEnv(["MONGO_URI"]);
    assertApplyAllowed({ apply, mongoUri: env.mongoUri });
    // A dry run must not write anything, including the indexes Mongoose would otherwise build.
    await mongoose.connect(env.mongoUri, apply ? {} : { autoIndex: false, autoCreate: false });
    const result = await migrate({ apply });
    console.log(result.lines.join("\n"));
    console.log(JSON.stringify(result.summary));
    await mongoose.disconnect();
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
