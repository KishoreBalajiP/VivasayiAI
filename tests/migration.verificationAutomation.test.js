import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import LossClaim from "../models/LossClaim.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { PLAN_INDEX_NAME, assertApplyAllowed, isRemoteUri, migrate } from "../scripts/migrations/2026-10-verification-automation.js";
import { clearTestDatabase, squareGeometry, startTestDatabase, stopTestDatabase } from "./helpers.js";

// ADR-022 migration (plan A3). Dry run by default and read-only; --apply is idempotent and refused
// against a remote (mongodb+srv) database without an explicit override. Runs against the in-memory
// database only.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "migrations", "2026-10-verification-automation.js");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date();
const ago = (ms) => new Date(NOW.getTime() - ms);

let seq = 0;
const claimBase = (overrides = {}) => ({
  idempotencyKey: `idem-mga-${(seq += 1)}`,
  cognitoSub: "mga-user",
  profileId: new mongoose.Types.ObjectId(),
  parcelId: "par_mga",
  parcelSnapshot: { parcelId: "par_mga", crop: "Paddy", parcelAreaAcres: 1 },
  eventType: "flood",
  eventDate: ago(10 * 24 * HOUR),
  claimedGeometry: squareGeometry(0.009, [78, 10]),
  claimedAreaAcres: 0.5,
  state: "submitted",
  ...overrides,
});

// A claim as an earlier release stored it: neither firstSubmittedAt nor submissionRound.
const legacyClaim = async (overrides = {}) => {
  const claim = await LossClaim.create(claimBase(overrides));
  await LossClaim.collection.updateOne({ _id: claim._id }, { $unset: { firstSubmittedAt: "", submissionRound: "" } });
  return claim;
};
const audit = (claimId, action, createdAt) =>
  ClaimAudit.collection.insertOne({ claimId, actor: "farmer", action, fromState: null, toState: "submitted", reason: null, metadata: {}, requestId: null, createdAt });

const COLLECTIONS = [LossClaim, ClaimAudit, ClaimAssessment, VerificationEvidence, VerificationJob];
// Everything the migration could touch: every document and every index of every collection.
const snapshot = async () => {
  const hash = createHash("sha256");
  for (const model of COLLECTIONS) {
    const docs = await model.collection.find({}).sort({ _id: 1 }).toArray();
    const indexes = await model.collection.indexes().catch(() => []);
    hash.update(model.collection.collectionName).update(JSON.stringify(docs)).update(JSON.stringify(indexes));
  }
  return hash.digest("hex");
};

// A database with one of everything the migration looks at.
const seedWorld = async () => {
  const resubmitted = await legacyClaim();
  await audit(resubmitted._id, "submitted", ago(9 * 24 * HOUR));
  await audit(resubmitted._id, "resubmitted", ago(5 * 24 * HOUR));

  const draft = await legacyClaim({ state: "draft" });

  const withdrawn = await legacyClaim({ state: "withdrawn" });
  await audit(withdrawn._id, "submitted", ago(3 * 24 * HOUR));
  await VerificationJob.create({ claimId: withdrawn._id, cognitoSub: "mga-user", step: "satellite", activeKey: `${withdrawn._id}:satellite` });

  const stuck = await legacyClaim({ state: "processing", processedAt: ago(40 * MINUTE) });
  await audit(stuck._id, "submitted", ago(2 * HOUR));

  const orphan = await LossClaim.create(claimBase({ firstSubmittedAt: ago(HOUR), submissionRound: 1 }));

  const withDeadJob = await LossClaim.create(claimBase({ firstSubmittedAt: ago(HOUR), submissionRound: 1 }));
  await VerificationJob.create({ claimId: withDeadJob._id, cognitoSub: "mga-user", step: "ai_assessment", status: "dead", lastError: { code: "PROVIDER_QUOTA", message: "x" } });
  await VerificationEvidence.create({
    claimId: withDeadJob._id, source: "OWNERSHIP", status: "PENDING", idempotencyKey: "rv_mga_OWNERSHIP_1",
    metadata: { kind: "review_case", reviewRequired: true, failedStep: "ai_assessment" },
  });
  await ClaimAssessment.create({ claimId: withDeadJob._id, status: "processing", startedAt: ago(HOUR) });

  return { resubmitted, draft, withdrawn, stuck, orphan, withDeadJob };
};

describe("2026-10 verification automation migration", () => {
  let mongo;
  beforeAll(async () => { mongo = await startTestDatabase(); });
  afterAll(async () => { await stopTestDatabase(mongo); });
  beforeEach(async () => {
    await clearTestDatabase();
    for (const model of COLLECTIONS) await model.deleteMany({});
    await VerificationJob.createIndexes();
  });

  it("MGA-1: the dry run writes nothing — documents and indexes unchanged — and reports what it would do", async () => {
    const world = await seedWorld();
    await VerificationJob.collection.dropIndex(PLAN_INDEX_NAME);
    const before = await snapshot();

    const { summary, lines } = await migrate({ now: NOW });
    expect(await snapshot()).toBe(before);
    expect(summary.dryRun).toBe(true);
    expect(summary.changes).toEqual({
      firstSubmittedAtBackfilled: 3, // resubmitted, withdrawn, stuck (the draft was never submitted)
      submissionRoundBackfilled: 3,
      indexesCreated: 1,
      jobsCancelled: 1,
      stuckClaimsReleased: 1,
    });
    expect(summary.findings).toMatchObject({
      deadJobs: [{ step: "ai_assessment", code: "PROVIDER_QUOTA", count: 1 }],
      assessmentsStuckProcessing: 1,
      mislabelledReviewCases: 1,
    });
    // Submitted, no decision and no job: the orphan and the legacy resubmitted claim (the claim
    // with a dead job has a job).
    expect(summary.findings.submittedWithoutJobs).toBe(2);
    expect(lines.join("\n")).toContain("would be created");
    expect((await LossClaim.findById(world.stuck._id)).state).toBe("processing");
  });

  it("MGA-2: --apply makes the changes, and a second --apply reports no changes", async () => {
    const world = await seedWorld();
    await VerificationJob.collection.dropIndex(PLAN_INDEX_NAME);

    const first = await migrate({ apply: true, now: NOW });
    expect(first.summary.dryRun).toBe(false);
    expect(first.summary.changes).toEqual({
      firstSubmittedAtBackfilled: 3,
      submissionRoundBackfilled: 3,
      indexesCreated: 1,
      jobsCancelled: 1,
      stuckClaimsReleased: 1,
    });
    const resubmitted = await LossClaim.findById(world.resubmitted._id).lean();
    expect(resubmitted.submissionRound).toBe(2);
    const draft = await LossClaim.findById(world.draft._id).lean();
    expect(draft.firstSubmittedAt ?? null).toBeNull();
    expect((await VerificationJob.findOne({ claimId: world.withdrawn._id }).lean()).status).toBe("cancelled");
    expect((await LossClaim.findById(world.stuck._id)).state).toBe("submitted");
    expect(await VerificationJob.countDocuments({ claimId: world.stuck._id, step: "engine", status: "queued" })).toBe(1);
    const indexes = await VerificationJob.collection.indexes();
    expect(indexes.find((index) => index.name === PLAN_INDEX_NAME)).toMatchObject({ unique: true, partialFilterExpression: { planKey: { $type: "string" } } });

    const second = await migrate({ apply: true, now: NOW });
    expect(second.summary.changes).toEqual({
      firstSubmittedAtBackfilled: 0,
      submissionRoundBackfilled: 0,
      indexesCreated: 0,
      jobsCancelled: 0,
      stuckClaimsReleased: 0,
    });
    // A dry run after the apply has nothing left to do either.
    const after = await snapshot();
    expect((await migrate({ now: NOW })).summary.changes.firstSubmittedAtBackfilled).toBe(0);
    expect(await snapshot()).toBe(after);
  });

  it("MGA-3: --apply is refused for a mongodb+srv database without the override, before any connection", () => {
    const atlas = "mongodb+srv://migration-test.invalid/vivasayi";
    expect(isRemoteUri(atlas)).toBe(true);
    expect(isRemoteUri("mongodb://127.0.0.1:27017/vivasayi")).toBe(false);
    expect(() => assertApplyAllowed({ apply: true, mongoUri: atlas, environment: {} })).toThrow(/Refusing --apply/);
    expect(() => assertApplyAllowed({ apply: false, mongoUri: atlas, environment: {} })).not.toThrow();
    expect(() => assertApplyAllowed({ apply: true, mongoUri: atlas, environment: { MIGRATION_ALLOW_REMOTE_APPLY: "true" } })).not.toThrow();
    expect(() => assertApplyAllowed({ apply: true, mongoUri: "mongodb://127.0.0.1:27017/x", environment: {} })).not.toThrow();
    // B-D1: a plain mongodb:// URI naming a remote host is remote too.
    expect(isRemoteUri("mongodb://db.example.invalid:27017/vivasayi")).toBe(true);
    expect(() => assertApplyAllowed({ apply: true, mongoUri: "mongodb://db.example.invalid:27017/x", environment: {} })).toThrow(/Refusing --apply/);

    // The command line: no .env, a remote URI that does not resolve; it must stop at the guard.
    const result = spawnSync(process.execPath, [SCRIPT, "--apply"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, VIVASAYI_SKIP_DOTENV: "1", MONGO_URI: atlas, LOG_LEVEL: "silent", NODE_ENV: "test" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing --apply against a database that is not on this machine");
  });

  it("MGA-4: the backfill takes the EARLIEST submitted audit as the first submission and counts every round", async () => {
    const claim = await legacyClaim({ submittedAt: ago(HOUR) });
    const earliest = ago(20 * 24 * HOUR);
    // Inserted out of order on purpose.
    await audit(claim._id, "resubmitted", ago(2 * 24 * HOUR));
    await audit(claim._id, "submitted", ago(12 * 24 * HOUR));
    await audit(claim._id, "submitted", earliest);
    await audit(claim._id, "resubmitted", ago(6 * 24 * HOUR));

    await migrate({ apply: true, now: NOW });
    const stored = await LossClaim.findById(claim._id).lean();
    expect(stored.firstSubmittedAt.getTime()).toBe(earliest.getTime());
    expect(stored.submissionRound).toBe(4);

    // A value that is already set is never overwritten.
    const kept = await LossClaim.create(claimBase({ firstSubmittedAt: ago(HOUR), submissionRound: 1 }));
    await audit(kept._id, "submitted", ago(30 * 24 * HOUR));
    await migrate({ apply: true, now: NOW });
    const unchanged = await LossClaim.findById(kept._id).lean();
    expect(unchanged.firstSubmittedAt.getTime()).toBe(ago(HOUR).getTime());
    expect(unchanged.submissionRound).toBe(1);

    // Without any audit row the latest submittedAt is the only evidence of a submission.
    const auditless = await legacyClaim({ submittedAt: ago(3 * HOUR) });
    await migrate({ apply: true, now: NOW });
    const fallback = await LossClaim.findById(auditless._id).lean();
    expect(fallback.firstSubmittedAt.getTime()).toBe(ago(3 * HOUR).getTime());
    expect(fallback.submissionRound).toBe(1);
  });
});
