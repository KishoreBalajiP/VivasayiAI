#!/usr/bin/env node
// ADR-022 (owner decision D7) — local verification worker: `npm run worker`.
//
// Runs the durable verification queue (services/verificationJobs.service.js) outside any HTTP
// request, the way the scheduled Lambda `worker` handler does in production (index.js). Nothing is
// deployed by this script.
//
//   npm run worker                                   loop until SIGINT/SIGTERM
//   npm run worker -- --once                         one batch (due jobs + sweeps), then exit
//   npm run worker -- --requeue-dead [--dry-run] [--step=ai_assessment] [--kind=auth_config] [--claim=<id>]
//                                                    re-queue dead jobs once their cause is fixed
//
// Safety:
//   - it refuses any database that is not on this machine (Atlas `mongodb+srv://`, or a remote host)
//     unless WORKER_ALLOW_REMOTE_DB=true. A developer's .env usually points at production; a worker
//     started by accident must not spend its jobs' provider calls or change its claims.
//   - the connection string is never printed (it carries the database password).
//   - stopping is graceful: the first SIGINT/SIGTERM lets the job in flight finish, then the process
//     disconnects and exits 0; a second signal exits 1 at once (the job's lease then expires and
//     another worker takes it over).
//
// Settings (all optional): WORKER_POLL_INTERVAL_MS (5000), WORKER_BATCH_BUDGET_MS (240000),
// WORKER_MAX_JOBS (25), WORKER_SWEEP_INTERVAL_MS (60000), plus the queue's own VERIFICATION_* keys.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, USAGE: 64 });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host);

// The hosts a MongoDB connection string names (without user, password, database or options).
export const mongoHosts = (uri) => {
  const match = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?]*)/i.exec(String(uri || "").trim());
  if (!match) return null;
  return {
    srv: Boolean(match[1]),
    hosts: match[2]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry.startsWith("[") ? entry.slice(0, entry.indexOf("]") + 1) : entry.replace(/:\d+$/, "")).toLowerCase()),
  };
};

// Is this connection string a database on this machine? SRV records are never local.
export const isLocalMongoUri = (uri) => {
  const parsed = mongoHosts(uri);
  return Boolean(parsed) && !parsed.srv && parsed.hosts.length > 0 && parsed.hosts.every(isLoopbackHost);
};

export const checkWorkerDatabase = ({ uri, allowRemote = false }) => {
  if (!uri || !mongoHosts(uri)) return { ok: false, reason: "MONGO_URI is missing or is not a MongoDB connection string" };
  if (isLocalMongoUri(uri) || allowRemote) return { ok: true };
  return {
    ok: false,
    reason:
      "Refusing to run against a database that is not on this machine (the connection string is not printed). " +
      "Point MONGO_URI at a local mongod, or set WORKER_ALLOW_REMOTE_DB=true if this really is intended.",
  };
};

export const parseWorkerArgs = (argv = []) => {
  const options = { once: false, requeueDead: false, dryRun: false, steps: [], kinds: [], claimId: null, limit: 50, unknown: [] };
  for (const arg of argv) {
    if (arg === "--once") options.once = true;
    else if (arg === "--requeue-dead") options.requeueDead = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--step=")) options.steps.push(...arg.slice(7).split(",").filter(Boolean));
    else if (arg.startsWith("--kind=")) options.kinds.push(...arg.slice(7).split(",").filter(Boolean));
    else if (arg.startsWith("--claim=")) options.claimId = arg.slice(8) || null;
    else if (arg.startsWith("--limit=")) options.limit = Math.max(1, Number(arg.slice(8)) || 50);
    else options.unknown.push(arg);
  }
  return options;
};

const positive = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// Run the worker. Returns the process exit code; the caller exits. `out` receives the one summary line
// (JSON, counts and ids only) a --once or --requeue-dead run prints.
export const runWorkerCli = async ({ argv = process.argv.slice(2), out = (line) => console.log(line), err = (line) => console.error(line) } = {}) => {
  const options = parseWorkerArgs(argv);
  if (options.unknown.length > 0 || (options.dryRun && !options.requeueDead)) {
    err(`Unknown or misplaced option(s): ${[...options.unknown, ...(options.dryRun && !options.requeueDead ? ["--dry-run"] : [])].join(" ")}`);
    err("Usage: node scripts/worker.js [--once] | --requeue-dead [--dry-run] [--step=<step>] [--kind=<kind>] [--claim=<id>] [--limit=<n>]");
    return EXIT.USAGE;
  }

  // Configuration first, and the database guard BEFORE anything connects.
  const envModule = await import("../config/env.js");
  const { env, validateEnv, CHAT_REQUIRED } = envModule;
  const database = checkWorkerDatabase({ uri: env.mongoUri, allowRemote: process.env.WORKER_ALLOW_REMOTE_DB === "true" });
  if (!database.ok) {
    err(database.reason);
    return EXIT.REFUSED;
  }
  try {
    // The step executors load the chat module, which needs the AI, embedding and Chroma settings at
    // import (placeholders are enough for a run whose steps make no model call).
    validateEnv(["MONGO_URI", ...CHAT_REQUIRED, "COHERE_API_KEY"]);
    const { assertPolicyConfigured } = await import("../config/verificationPolicy.js");
    assertPolicyConfigured();
    // ADR-024: never run a production worker with a mock mode or the dev upload receiver configured.
    envModule.assertProductionSafety();
  } catch (error) {
    err(`Worker configuration error: ${error.message}`);
    return EXIT.FAILED;
  }

  const mongoose = (await import("mongoose")).default;
  const { default: logger } = await import("../utils/logger.js");
  const log = logger.child({ component: "worker" });
  try {
    await mongoose.connect(env.mongoUri);
  } catch (error) {
    err(`Worker could not connect to MongoDB (${error?.name || "error"})`);
    return EXIT.FAILED;
  }

  const worker = await import("../services/verificationWorker.service.js");
  try {
    if (options.requeueDead) {
      const { requeueDeadJobs } = await import("../services/verificationJobs.service.js");
      const summary = await requeueDeadJobs({
        claimId: options.claimId,
        steps: options.steps.length ? options.steps : null,
        kinds: options.kinds.length ? options.kinds : null,
        dryRun: options.dryRun,
        limit: options.limit,
        // A person ran this after fixing the cause: the automatic two-round limit does not apply.
        maxRecoveryRounds: 10,
        requestId: `cli-${randomUUID()}`,
        actor: "cli",
      });
      out(JSON.stringify({ mode: "requeue-dead", ...summary }));
      return EXIT.OK;
    }

    if (options.once) {
      const result = await worker.drainDueJobs({
        deadline: Date.now() + positive(process.env.WORKER_BATCH_BUDGET_MS, 240_000),
        maxJobs: positive(process.env.WORKER_MAX_JOBS, 25),
        requestId: `worker-${randomUUID()}`,
      });
      out(JSON.stringify({ mode: "once", processed: result.processed, outcomes: result.results.map((entry) => `${entry.step}:${entry.outcome}`), sweep: result.sweep }));
      return EXIT.OK;
    }

    let stopping = false;
    const onSignal = (signal) => {
      if (stopping) {
        log.warn({ signal }, "worker.forced_exit");
        process.exit(EXIT.FAILED);
      }
      stopping = true;
      log.info({ signal }, "worker.stopping");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    log.info("worker.started");
    const summary = await worker.runWorkerLoop({
      shouldStop: () => stopping,
      pollIntervalMs: positive(process.env.WORKER_POLL_INTERVAL_MS, 5000),
      batchBudgetMs: positive(process.env.WORKER_BATCH_BUDGET_MS, 240_000),
      maxJobsPerBatch: positive(process.env.WORKER_MAX_JOBS, 25),
      sweepIntervalMs: positive(process.env.WORKER_SWEEP_INTERVAL_MS, 60_000),
    });
    log.info(summary, "worker.stopped");
    return EXIT.OK;
  } catch (error) {
    log.error({ err: error?.message }, "worker.failed");
    err(`Worker failed: ${error.message}`);
    return EXIT.FAILED;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // The AI and storage clients keep sockets open, so the process exits explicitly.
  runWorkerCli().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Worker failed: ${error?.message || error}`);
      process.exit(EXIT.FAILED);
    }
  );
}
