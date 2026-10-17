import mongoose from "mongoose";
import { isLocalMongoUri } from "../worker.js";
import LossClaim from "../../models/LossClaim.js";
import ClaimAssessment from "../../models/ClaimAssessment.js";
import AdminAction from "../../models/AdminAction.js";
import User from "../../models/User.js";
import VerificationEvidence from "../../models/VerificationEvidence.js";
import VerificationJob from "../../models/VerificationJob.js";
import { geometryBbox } from "../../utils/geometryBbox.js";
import { releaseProcessingSlot } from "../../services/claimVerification.service.js";
import { enqueue } from "../../services/verificationJobs.service.js";

// ADR-020 / ADR-021 data migration. Idempotent: running it twice changes nothing the second time.
// `--dry-run` reports what would change and writes nothing.
//
//   node scripts/migrations/2026-10-verification-components.js [--dry-run] [--enqueue]
//
// Writing (no --dry-run) to a database that is not on this machine is refused unless
// MIGRATION_ALLOW_REMOTE_APPLY=true (2026-10-17 safety fix; the dry run is always allowed).
//
// What it does:
//   1. backfills `component` and `kind` on existing VerificationEvidence rows;
//   2. backfills LossClaim.bbox (used by the cross-farmer overlap lookup);
//   3. rebuilds two indexes whose definition changed (Mongoose never alters an existing index):
//        adminactions  claimId_1_idempotencyKey_1  sparse  -> partial on string keys
//        users         email_1                      unique  -> unique + sparse
//   4. returns claims stuck in `processing` (no completed verification) to `submitted`;
//   5. with --enqueue, queues an engine job for submitted claims that have no decision yet.

const STUCK_AFTER_MS = 15 * 60 * 1000;

const COMPONENT_RULES = [
  // Review cases first: they share source OWNERSHIP with documents.
  { name: "review cases", filter: { source: "OWNERSHIP", $or: [{ "metadata.reviewRequired": true }, { idempotencyKey: { $regex: "^(rv_|review_)" } }] }, set: { component: "manual_review", kind: "review_case" } },
  { name: "official land record rows", filter: { source: "OWNERSHIP", idempotencyKey: { $regex: "^officialland_" } }, set: { component: "claimant_rights" } },
  { name: "ownership documents", filter: { source: "OWNERSHIP" }, set: { component: "claimant_rights" } },
  { name: "satellite rows", filter: { source: "SATELLITE" }, set: { component: "satellite" } },
  { name: "weather rows", filter: { source: "WEATHER" }, set: { component: "weather" } },
  { name: "ai image rows", filter: { source: "AI_IMAGE" }, set: { component: "photos" } },
  // The old pipeline wrote an AVAILABLE geometry row without running any check. Mark it so nothing
  // mistakes it for a real verification; the resolver derives geometry from spatial facts anyway.
  { name: "legacy geometry rows", filter: { source: "GEOMETRY" }, set: { component: "geometry", "metadata.legacyUnverified": true } },
];

const log = (lines, message) => {
  lines.push(message);
};

const rebuildIndex = async ({ model, name, wantedOptions, dryRun, lines }) => {
  const indexes = await model.collection.indexes().catch(() => []);
  const current = indexes.find((index) => index.name === name);
  const matches = current && wantedOptions(current);
  if (matches) {
    log(lines, `index ${model.collection.collectionName}.${name}: already up to date`);
    return false;
  }
  log(lines, `index ${model.collection.collectionName}.${name}: ${dryRun ? "would be rebuilt" : "rebuilt"}`);
  if (dryRun) return true;
  if (current) await model.collection.dropIndex(name);
  await model.createIndexes();
  return true;
};

export const migrate = async ({ dryRun = false, enqueueEngine = false, now = new Date() } = {}) => {
  const lines = [];
  const summary = { dryRun, evidenceUpdated: 0, bboxBackfilled: 0, indexesRebuilt: 0, claimsReleased: 0, jobsEnqueued: 0 };

  // 1. evidence component + kind
  for (const rule of COMPONENT_RULES) {
    const filter = { ...rule.filter, component: null };
    const count = await VerificationEvidence.countDocuments(filter);
    if (count > 0 && !dryRun) await VerificationEvidence.updateMany(filter, { $set: rule.set });
    if (count > 0) log(lines, `evidence ${rule.name}: ${count} ${dryRun ? "would be updated" : "updated"}`);
    summary.evidenceUpdated += count;
  }

  // 2. claim bounding boxes
  const missing = LossClaim.find({ "bbox.minLon": { $exists: false } }).select("claimedGeometry").cursor();
  for await (const claim of missing) {
    const box = geometryBbox(claim.claimedGeometry);
    if (!box) continue;
    summary.bboxBackfilled += 1;
    if (!dryRun) await LossClaim.updateOne({ _id: claim._id }, { $set: { bbox: box } });
  }
  log(lines, `claims bbox: ${summary.bboxBackfilled} ${dryRun ? "would be backfilled" : "backfilled"}`);

  // 3. indexes
  if (await rebuildIndex({
    model: AdminAction,
    name: "claimId_1_idempotencyKey_1",
    wantedOptions: (index) => Boolean(index.partialFilterExpression) && !index.sparse,
    dryRun,
    lines,
  })) summary.indexesRebuilt += 1;
  if (await rebuildIndex({
    model: User,
    name: "email_1",
    wantedOptions: (index) => index.sparse === true,
    dryRun,
    lines,
  })) summary.indexesRebuilt += 1;
  if (!dryRun) {
    await Promise.all([LossClaim.createIndexes(), VerificationEvidence.createIndexes(), VerificationJob.createIndexes()]);
  }

  // 4. claims stuck in processing
  const stuckBefore = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = await LossClaim.find({ state: "processing", processedAt: { $lte: stuckBefore } }).select("_id").lean();
  for (const claim of stuck) {
    const assessment = await ClaimAssessment.findOne({ claimId: claim._id }).select("verification state").lean();
    if (assessment && assessment.state && assessment.verification && assessment.verification.status === "completed") continue;
    summary.claimsReleased += 1;
    if (!dryRun) await releaseProcessingSlot({ claimId: claim._id, reason: "Released by migration: verification was interrupted" });
  }
  log(lines, `stuck claims: ${summary.claimsReleased} ${dryRun ? "would be released" : "released"}`);

  // 5. optional engine jobs for undecided submitted claims
  if (enqueueEngine) {
    const waiting = await LossClaim.find({ state: "submitted" }).select("_id cognitoSub").lean();
    for (const claim of waiting) {
      const decided = await ClaimAssessment.exists({ claimId: claim._id, state: { $ne: null } });
      if (decided) continue;
      summary.jobsEnqueued += 1;
      if (!dryRun) await enqueue({ claimId: claim._id, cognitoSub: claim.cognitoSub, step: "engine" });
    }
    log(lines, `engine jobs: ${summary.jobsEnqueued} ${dryRun ? "would be queued" : "queued"}`);
  }

  return { summary, lines };
};

// Command-line entry point. Importing the services opens long-lived clients (AI, vector store), so
// the process exits explicitly instead of waiting for the event loop to drain.
// A write run against a database that is not on this machine needs an explicit opt-in.
export const assertWriteAllowed = ({ dryRun, mongoUri, environment = process.env }) => {
  if (!dryRun && !isLocalMongoUri(mongoUri) && environment.MIGRATION_ALLOW_REMOTE_APPLY !== "true") {
    throw new Error("Refusing to write to a database that is not on this machine. Run with --dry-run first, review it, and set MIGRATION_ALLOW_REMOTE_APPLY=true to write.");
  }
};

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let exitCode = 0;
  try {
    const { env, validateEnv, SERVER_REQUIRED } = await import("../../config/env.js");
    validateEnv(SERVER_REQUIRED);
    const dryRun = process.argv.includes("--dry-run");
    assertWriteAllowed({ dryRun, mongoUri: env.mongoUri });
    await mongoose.connect(env.mongoUri, dryRun ? { autoIndex: false, autoCreate: false } : {});
    const result = await migrate({ dryRun, enqueueEngine: process.argv.includes("--enqueue") });
    console.log(result.lines.join("\n"));
    console.log(JSON.stringify(result.summary));
    await mongoose.disconnect();
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
