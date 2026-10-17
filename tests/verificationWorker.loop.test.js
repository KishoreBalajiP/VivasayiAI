import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ADR-022 (plan A7, owner decision D7) — the worker: the batch loop with graceful stop, the lost-plan
// reconcile sweep, `npm run worker` (remote-database refusal, --once), the Lambda handler's request id
// in job logs, and the (not deployed) EventBridge template. Automated verification is on; every step
// executor is a fake, so nothing here reaches a provider.
vi.hoisted(() => {
  process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED = "true";
  process.env.CLAIM_VERIFICATION_DRAIN_ON_READ = "false";
  process.env.CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";
});

import LossClaim from "../models/LossClaim.js";
import VerificationJob from "../models/VerificationJob.js";
import logger from "../utils/logger.js";
import { enqueue, setExecutor } from "../services/verificationJobs.service.js";
import { RECONCILE_GRACE_MS, WORKER_STOP_MARGIN_MS, drainDueJobs, handleScheduledWorker, reconcilePlans, runWorkerLoop } from "../services/verificationWorker.service.js";
import { checkWorkerDatabase, isLocalMongoUri, parseWorkerArgs } from "../scripts/worker.js";
import { startTestDatabase, stopTestDatabase } from "./helpers.js";
import { createClaim, resetDatabase, seedFarmer, submitClaim, uploadPhoto } from "./fixtures/claimFlow.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// WK-6 reads the CloudFormation template without a YAML library (js-yaml is only a transitive
// dependency, so the suite must not rely on it). The template is written in the plain block subset
// this reads: `key: value`, `key:` with an indented block, `- scalar` and `- key: value` list items,
// quoted strings and comments. Anything else (flow style, anchors, multi-line scalars, `!Ref` tags)
// throws, so the check can never silently pass on a template it did not understand.
const parseYamlSubset = (text) => {
  const lines = text
    .split("\n")
    .map((raw, index) => ({ raw, index: index + 1 }))
    .filter(({ raw }) => raw.trim() !== "" && !raw.trim().startsWith("#"))
    .map(({ raw, index }) => {
      if (/\t/.test(raw.match(/^\s*/)[0])) throw new Error(`line ${index}: tab indentation`);
      if (/^\s*[{[]|[&*!|>]\s*$|:\s*[&*!|>]/.test(raw) || /:\s*[{[]/.test(raw)) throw new Error(`line ${index}: unsupported YAML: ${raw.trim()}`);
      return { indent: raw.match(/^ */)[0].length, text: raw.trim().replace(/\s+#.*$/, ""), index };
    });
  const scalar = (value) => {
    const trimmed = value.trim();
    if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  };
  let position = 0;
  const parseBlock = (indent) => {
    const isList = lines[position].text.startsWith("- ") || lines[position].text === "-";
    const result = isList ? [] : {};
    while (position < lines.length && lines[position].indent === indent) {
      const line = lines[position];
      if (isList) {
        if (!line.text.startsWith("- ")) throw new Error(`line ${line.index}: expected a list item`);
        const item = line.text.slice(2);
        const pair = /^([A-Za-z0-9_:.-]+?):(?:\s+(.*))?$/.exec(item);
        if (!pair) {
          result.push(scalar(item));
          position += 1;
          continue;
        }
        // "- key: value" starts a map whose other keys sit 2 columns deeper.
        lines[position] = { ...line, indent: indent + 2, text: item };
        result.push(parseBlock(indent + 2));
        continue;
      }
      const pair = /^([A-Za-z0-9_:.-]+?):(?:\s+(.*))?$/.exec(line.text);
      if (!pair) throw new Error(`line ${line.index}: expected "key: value"`);
      position += 1;
      if (pair[2] !== undefined && pair[2] !== "") {
        result[pair[1]] = scalar(pair[2]);
      } else if (position < lines.length && lines[position].indent > indent) {
        result[pair[1]] = parseBlock(lines[position].indent);
      } else {
        result[pair[1]] = null;
      }
    }
    if (position < lines.length && lines[position].indent > indent) throw new Error(`line ${lines[position].index}: unexpected indentation`);
    return result;
  };
  const document = parseBlock(0);
  if (position !== lines.length) throw new Error(`line ${lines[position].index}: could not parse`);
  return document;
};
const STEPS = ["ai_assessment", "land_documents", "official_land_record", "satellite", "weather", "engine"];
const MINUTE = 60_000;

// Run a node script as a separate process with the test environment (never the developer's .env).
export const runNode = (args, { env = {}, timeoutMs = 60_000 } = {}) =>
  new Promise((resolve, reject) => {
    const childEnv = { ...process.env, VIVASAYI_SKIP_DOTENV: "1", LOG_LEVEL: "silent", ...env };
    delete childEnv.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child timed out: ${stderr}`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });

// A submitted claim (one photo) with no job rows at all, as if its plan had been lost.
const orphanClaim = async (label, { submittedMinutesAgo = 10 } = {}) => {
  const farmer = await seedFarmer(label);
  const claimId = await createClaim(farmer);
  await uploadPhoto(farmer.user, claimId);
  await submitClaim(farmer.user, claimId);
  await VerificationJob.deleteMany({ claimId });
  const at = new Date(Date.now() - submittedMinutesAgo * MINUTE);
  await LossClaim.updateOne({ _id: claimId }, { $set: { submittedAt: at, firstSubmittedAt: at } });
  return { ...farmer, claimId };
};

describe("verification worker (WK)", () => {
  let mongo;
  const ran = [];
  beforeAll(async () => {
    mongo = await startTestDatabase();
    await VerificationJob.init();
  });
  afterAll(async () => {
    await stopTestDatabase(mongo);
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
    ran.length = 0;
    for (const step of STEPS) setExecutor(step, async (job) => { ran.push(`${step}:${String(job.claimId)}`); return { fake: step }; });
  });

  it("WK-1: the loop drains due jobs batch by batch and stops gracefully: the job in flight completes, nothing new starts", async () => {
    const claims = [];
    for (let i = 0; i < 3; i += 1) claims.push(await orphanClaim(`wk1-${i}`, { submittedMinutesAgo: 0 }));
    for (const [index, { user, claimId }] of claims.entries()) {
      await enqueue({ claimId, cognitoSub: user, step: "weather", runAt: new Date(Date.now() - (10 - index) * 1000) });
    }
    let stop = false;
    let released;
    setExecutor("weather", async (job) => {
      ran.push(`weather:${String(job.claimId)}`);
      if (ran.length === 2) {
        stop = true; // the signal arrives while this job is running
        await new Promise((resolve) => (released = setTimeout(resolve, 300)));
      }
      return { fake: "weather" };
    });
    const summary = await runWorkerLoop({ shouldStop: () => stop, pollIntervalMs: 20, sweepIntervalMs: 0 });
    clearTimeout(released);
    expect(summary).toEqual({ batches: 1, processed: 2 });
    const jobs = await VerificationJob.find({ step: "weather" }).sort({ runAt: 1 }).lean();
    expect(jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded", "queued"]);
    expect(jobs[2].attempts).toBe(0);

    // Idle batches sleep, then the loop ends when asked: here after the second batch.
    let batches = 0;
    const idle = await runWorkerLoop({ shouldStop: () => batches >= 2, pollIntervalMs: 10, onBatch: () => { batches += 1; } });
    expect(idle.batches).toBe(2);
    expect(idle.processed).toBe(1); // the queued job above, picked up by the first batch
  });

  it("WK-2: reconcile plans a submitted claim that lost its plan, once; a fresh submit, a planned claim and a legacy claim after its backfill are left alone", async () => {
    const lost = await orphanClaim("wk2-lost");
    const fresh = await orphanClaim("wk2-fresh", { submittedMinutesAgo: 1 }); // inside the grace period
    const planned = await orphanClaim("wk2-planned");
    await enqueue({ claimId: planned.claimId, cognitoSub: planned.user, step: "engine" });
    expect(RECONCILE_GRACE_MS).toBe(5 * MINUTE);

    const dry = await reconcilePlans({ dryRun: true });
    expect(dry).toMatchObject({ checked: 1, planned: 1, claimIds: [lost.claimId] });
    expect(await VerificationJob.countDocuments({ claimId: lost.claimId })).toBe(0);

    const first = await reconcilePlans({ requestId: "wk2-sweep-0001" });
    expect(first).toMatchObject({ checked: 1, planned: 1, claimIds: [lost.claimId] });
    const jobs = await VerificationJob.find({ claimId: lost.claimId }).lean();
    expect(jobs.map((job) => job.step).sort()).toEqual(["ai_assessment", "engine", "satellite", "weather"]);
    expect(jobs.every((job) => job.planKey === "r1" && job.requestId === "wk2-sweep-0001")).toBe(true);
    expect(await VerificationJob.countDocuments({ claimId: fresh.claimId })).toBe(0);
    expect(await VerificationJob.countDocuments({ claimId: planned.claimId })).toBe(1);

    // Idempotent: the next sweeps find nothing, even after every job finished.
    expect((await reconcilePlans()).planned).toBe(0);
    await VerificationJob.updateMany({ claimId: lost.claimId }, { $set: { status: "succeeded" }, $unset: { activeKey: "" } });
    expect((await reconcilePlans()).planned).toBe(0);

    // Critique D8: a legacy claim (no round) is planned once as r0, and NOT again once the migration
    // backfill gives it round 1, because an engine job already exists after its submission.
    const legacy = await orphanClaim("wk2-legacy");
    await LossClaim.updateOne({ _id: legacy.claimId }, { $set: { submissionRound: 0, firstSubmittedAt: null } });
    expect((await reconcilePlans()).claimIds).toEqual([legacy.claimId]);
    expect(new Set((await VerificationJob.find({ claimId: legacy.claimId }).lean()).map((job) => job.planKey))).toEqual(new Set(["r0"]));
    await LossClaim.updateOne({ _id: legacy.claimId }, { $set: { submissionRound: 1 } });
    expect((await reconcilePlans()).planned).toBe(0);
    expect(await VerificationJob.countDocuments({ claimId: legacy.claimId, planKey: "r1" })).toBe(0);

    // The sweep is part of every worker batch.
    const another = await orphanClaim("wk2-batch");
    const batch = await drainDueJobs({ deadline: Date.now() + 20_000, maxJobs: 0 });
    expect(batch.sweep.plansReconciled).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId: another.claimId, step: "engine" })).toBe(1);
  });

  it("WK-3: npm run worker refuses a database that is not on this machine, without printing the connection string or connecting", async () => {
    expect(isLocalMongoUri("mongodb://127.0.0.1:27017/vivasayi")).toBe(true);
    expect(isLocalMongoUri("mongodb://user:pw@localhost:27017,127.0.0.1:27018/db?replicaSet=rs")).toBe(true);
    expect(isLocalMongoUri("mongodb://[::1]:27017/db")).toBe(true);
    expect(isLocalMongoUri("mongodb+srv://user:pw@cluster0.example.mongodb.net/db")).toBe(false);
    expect(isLocalMongoUri("mongodb://user:pw@db.example.com:27017/db")).toBe(false);
    expect(isLocalMongoUri("mongodb://127.0.0.1:27017,db.example.com:27017/db")).toBe(false);
    expect(checkWorkerDatabase({ uri: "mongodb+srv://u:p@cluster0.example.mongodb.net/db", allowRemote: true })).toEqual({ ok: true });
    expect(checkWorkerDatabase({ uri: "" }).ok).toBe(false);
    expect(parseWorkerArgs(["--requeue-dead", "--dry-run", "--step=ai_assessment", "--kind=auth_config,quota", "--claim=abc"])).toMatchObject({
      requeueDead: true, dryRun: true, steps: ["ai_assessment"], kinds: ["auth_config", "quota"], claimId: "abc",
    });

    // The real entry point, behind a loopback-only network guard (a regression could otherwise try to
    // resolve or reach the host); the hosts are reserved `.invalid` names that never resolve anyway.
    const secret = "s3cr3t-pa55word";
    for (const uri of [`mongodb+srv://admin:${secret}@cluster0.vivasayi-test.invalid/prod`, `mongodb://admin:${secret}@db.vivasayi-test.invalid:27017/prod`]) {
      const result = await runNode(["--import", "./tests/fixtures/networkGuard.js", "scripts/worker.js", "--once"], { env: { MONGO_URI: uri, WORKER_ALLOW_REMOTE_DB: "" } });
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("Refusing to run against a database that is not on this machine");
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.stdout + result.stderr).not.toContain("vivasayi-test");
      expect(result.stderr).not.toContain("TEST_EXTERNAL_NETWORK_BLOCKED"); // refused before any lookup
    }
    // Usage errors never connect either.
    expect((await runNode(["--import", "./tests/fixtures/networkGuard.js", "scripts/worker.js", "--dry-run"], { env: { MONGO_URI: "mongodb://127.0.0.1:1/x" } })).code).toBe(64);
  });

  it("WK-4: --once runs exactly one batch against the local database and exits 0", async () => {
    const claims = [];
    for (let i = 0; i < 2; i += 1) claims.push(await orphanClaim(`wk4-${i}`, { submittedMinutesAgo: 0 }));
    for (const { user, claimId } of claims) await enqueue({ claimId, cognitoSub: user, step: "weather", runAt: new Date(Date.now() - 1000) });
    const later = await enqueue({ claimId: claims[0].claimId, cognitoSub: claims[0].user, step: "satellite", runAt: new Date(Date.now() + 60 * MINUTE) });

    const result = await runNode(["tests/fixtures/slowWorkerBootstrap.js", "--once"], { env: { MONGO_URI: mongo.getUri("parcel-foundation-test") } });
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout.trim().split("\n").pop());
    expect(summary).toMatchObject({ mode: "once", processed: 2, outcomes: ["weather:succeeded", "weather:succeeded"] });
    expect(summary.sweep).toMatchObject({ stuckClaimsReleased: 0, deadJobsRequeued: 0 });
    expect(await VerificationJob.countDocuments({ step: "weather", status: "succeeded" })).toBe(2);
    expect((await VerificationJob.findById(later.job._id).lean()).status).toBe("queued"); // not due: untouched
  });

  it("WK-4b: --requeue-dead [--dry-run] re-queues dead jobs once their cause is fixed, any kind, and the dry run writes nothing", async () => {
    const { user, claimId } = await orphanClaim("wk4b", { submittedMinutesAgo: 0 });
    const dead = await VerificationJob.create({
      claimId, cognitoSub: user, step: "ai_assessment", status: "dead", attempts: 7, maxAttempts: 7, deadAt: new Date(),
      lastError: { code: "PROVIDER_AUTH_CONFIG", kind: "auth_config", retryable: true, at: new Date() },
    });
    const env = { MONGO_URI: mongo.getUri("parcel-foundation-test") };
    const dry = await runNode(["tests/fixtures/slowWorkerBootstrap.js", "--requeue-dead", "--dry-run", "--kind=auth_config"], { env });
    expect(dry.code, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout.trim().split("\n").pop())).toMatchObject({ mode: "requeue-dead", dryRun: true, requeued: 1 });
    expect(await VerificationJob.countDocuments({ claimId })).toBe(1);
    expect((await VerificationJob.findById(dead._id).lean()).requeuedAt).toBeNull();

    const real = await runNode(["tests/fixtures/slowWorkerBootstrap.js", "--requeue-dead", "--step=ai_assessment"], { env });
    expect(real.code, real.stderr).toBe(0);
    expect(JSON.parse(real.stdout.trim().split("\n").pop())).toMatchObject({ mode: "requeue-dead", dryRun: false, requeued: 1, engineQueued: 1 });
    expect((await VerificationJob.findById(dead._id).lean()).requeuedAt).toBeTruthy();
    expect(await VerificationJob.countDocuments({ claimId, step: "ai_assessment", status: "queued", recoveryRound: 1 })).toBe(1);
    expect(await VerificationJob.countDocuments({ claimId, step: "engine", status: "queued" })).toBe(1);
  });

  it("WK-5: the Lambda worker handler tags every job it runs with the invocation's awsRequestId and stops 10 s before its timeout", async () => {
    const { user, claimId } = await orphanClaim("wk5", { submittedMinutesAgo: 0 });
    await enqueue({ claimId, cognitoSub: user, step: "weather" });
    const child = vi.spyOn(logger, "child");
    const context = { awsRequestId: "aws-req-wk5-0001", getRemainingTimeInMillis: () => 60_000 };
    const result = await handleScheduledWorker({ source: "aws.events" }, context);
    expect(result.processed).toBe(1);
    const jobLog = child.mock.calls.map(([fields]) => fields).find((fields) => fields && fields.step === "weather");
    expect(jobLog).toMatchObject({ claimId, step: "weather", drainRequestId: "aws-req-wk5-0001" });

    // The deadline leaves the stop margin; maxJobs comes from WORKER_MAX_JOBS.
    const run = vi.fn(async (options) => options);
    process.env.WORKER_MAX_JOBS = "7";
    try {
      const before = Date.now();
      const options = await handleScheduledWorker({}, context, { run });
      expect(options).toMatchObject({ requestId: "aws-req-wk5-0001", maxJobs: 7 });
      expect(options.deadline).toBeGreaterThanOrEqual(before + 60_000 - WORKER_STOP_MARGIN_MS);
      expect(options.deadline).toBeLessThanOrEqual(Date.now() + 60_000 - WORKER_STOP_MARGIN_MS);
      expect((await handleScheduledWorker({}, {}, { run })).requestId).toMatch(/^worker-/);
    } finally {
      delete process.env.WORKER_MAX_JOBS;
    }
    // index.js (not importable here: it connects at import) routes the `worker` export through it.
    expect(readFileSync(join(ROOT, "index.js"), "utf8")).toMatch(/export const worker = \(event, context\) => handleScheduledWorker\(event, context\);/);
  });

  it("WK-6: the EventBridge template runs index.worker from the same image, with the schedule DISABLED by default and no secret in it", () => {
    const text = readFileSync(join(ROOT, "infra", "verification-worker.yaml"), "utf8");
    const template = parseYamlSubset(text);
    expect(template.AWSTemplateFormatVersion).toBe("2010-09-09");
    expect(template.Parameters.ScheduleState).toMatchObject({ Default: "DISABLED", AllowedValues: ["ENABLED", "DISABLED"] });
    const fn = template.Resources.WorkerFunction;
    expect(fn.Type).toBe("AWS::Lambda::Function");
    expect(fn.Properties).toMatchObject({ PackageType: "Image", ImageConfig: { Command: ["index.worker"] }, Timeout: 300, ReservedConcurrentExecutions: 1 });
    expect(fn.Properties.Code.ImageUri).toEqual({ Ref: "ImageUri" });
    const rule = template.Resources.WorkerSchedule;
    expect(rule.Type).toBe("AWS::Events::Rule");
    expect(rule.Properties.State).toEqual({ Ref: "ScheduleState" });
    expect(rule.Properties.Targets[0].Arn).toEqual({ "Fn::GetAtt": ["WorkerFunction", "Arn"] });
    expect(template.Resources.WorkerInvokePermission.Properties.Principal).toBe("events.amazonaws.com");
    expect(template.Resources.WorkerErrorsAlarm.Condition).toBe("HasAlarmTopic");
    // Only non-secret variables; everything else is copied out of band (runbook).
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual(["NODE_ENV", "WORKER_MAX_JOBS"]);
    expect(text).not.toMatch(/MONGO_URI\s*:|GOOGLE_API_KEY\s*:|SECRET\s*:|mongodb(\+srv)?:\/\//);

    // `npm run worker` and the runbook exist; the runbook never echoes a secret.
    expect(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts.worker).toBe("node scripts/worker.js");
    const runbookPath = join(ROOT, "docs", "engineering", "WORKER_RUNBOOK.md");
    expect(existsSync(runbookPath)).toBe(true);
    const runbook = readFileSync(runbookPath, "utf8");
    expect(runbook).toContain("umask 077");
    expect(runbook).toMatch(/CLAIM_AUTOMATED_VERIFICATION_ENABLED/);
    expect(runbook).toMatch(/CLAIM_VERIFICATION_DRAIN_ON_READ/);
    expect(runbook).not.toMatch(/echo\s+"?\$\{?(MONGO_URI|GOOGLE_API_KEY|COHERE_API_KEY|CHROMA_API_KEY|SESSION_JWT_SECRET)/);
    // The out-of-band environment does not survive a stack deploy: the runbook and the template both
    // say to copy it again after every deploy (stage-1 review), including the one enabling the schedule.
    expect(runbook).toMatch(/Re-run step 3 \(then step 4\) after EVERY `cloudformation deploy`/);
    expect(runbook).toMatch(/## 5\. Enable the schedule[\s\S]*run step 3 and step 4 again right away/);
    expect(text).toMatch(/Re-run runbook step 3 \(then step 4\) after EVERY deploy/);
  });
});
