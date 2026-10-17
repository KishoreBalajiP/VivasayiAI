#!/usr/bin/env node
// Hermetic e2e backend (ADR-024, design-testing §2.1): `npm run e2e:backend`.
//
// Runs the REAL API (app.js) and the REAL verification worker against a throw-away local MongoDB, with
// every external provider replaced by an in-process stand-in, so the Playwright suite (frontend repo)
// can drive the product end to end with ZERO network traffic beyond this machine:
//   storage      IMAGE_STORAGE_MODE=mock, file-backed (IMAGE_STORAGE_MOCK_DIR), and the signed dev upload
//                receiver /__dev/storage that the browser PUTs photos to
//   AI           IMAGE_AI_MODE=live with a fake Gemini on chat.service's model.generate (lib/fakeGemini.js)
//   land record, weather, satellite   their mock modes (outcomes switchable per test)
//   network      a guard that blocks and records any non-loopback connection or DNS query (lib/networkGuard.js)
//
//   node scripts/e2e/hermeticBackend.js [--port 18080] [--control-port 18081] [--mongo=memory|local]
//                                       [--worker=inline|process|off] [--out test-results/e2e/harness.json]
//
// Steps (design-testing §2.1): 1 load scripts/e2e/e2e.env before ANY application import (and never .env);
// 2 refuse production, Lambda, live credentials, a real AI key or a remote database; 3 install the network
// guard; 4 start MongoDB; 5 load the app and run the boot guards; 6 install the fake Gemini; 7 listen and
// start the worker; 8 start the control server (127.0.0.1, bearer token, never mounted on the app); 9 write
// the out file (mode 0600) and shut down cleanly on SIGINT/SIGTERM.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installNetworkGuard, networkViolations } from "./lib/networkGuard.js";
import { BACKEND_ROOT, applyE2eEnv, checkHermeticEnv, checkLocalMongoUri, preflightRefusal, readE2eEnvFile } from "./lib/hermeticEnv.js";
import { defaultParcelGeometry, overLimitGeometry, squareAt, utcEventDate } from "./lib/seedHelpers.js";

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, REFUSED: 2, USAGE: 64 });
export const DEFAULTS = Object.freeze({ port: 18080, controlPort: 18081, mongo: "memory", worker: "inline", host: "127.0.0.1" });
export const DEFAULT_OUT = path.join(BACKEND_ROOT, "test-results", "e2e", "harness.json");
const MONGOD_CANDIDATES = ["/opt/homebrew/bin/mongod", "/usr/local/bin/mongod", "C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe", "C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe"];

// `--name value` and `--name=value` forms. Port 0 asks the OS for a free port (tests).
export const parseHarnessArgs = (argv = []) => {
  const options = { ...DEFAULTS, out: DEFAULT_OUT, errors: [] };
  const valueOf = (index, arg, name) => (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const name = arg.replace(/^--/, "").split("=")[0];
    const takesValue = ["port", "control-port", "mongo", "worker", "out"].includes(name);
    if (!arg.startsWith("--") || !takesValue) {
      options.errors.push(`unknown option ${arg}`);
      continue;
    }
    const value = valueOf(i, arg, name);
    if (!arg.includes("=")) i += 1;
    if (value === undefined) {
      options.errors.push(`--${name} needs a value`);
      continue;
    }
    if (name === "port" || name === "control-port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) options.errors.push(`--${name} must be a port number`);
      else options[name === "port" ? "port" : "controlPort"] = port;
    } else if (name === "mongo") {
      if (!["memory", "local"].includes(value)) options.errors.push("--mongo must be memory or local");
      else options.mongo = value;
    } else if (name === "worker") {
      if (!["inline", "process", "off"].includes(value)) options.errors.push("--worker must be inline, process or off");
      else options.worker = value;
    } else if (name === "out") {
      options.out = path.resolve(process.cwd(), value);
    }
  }
  if (options.port !== 0 && options.port === options.controlPort) options.errors.push("--port and --control-port must differ");
  return options;
};

const log = (message, extra = null) => process.stderr.write(`[e2e-harness] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}\n`);

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

const closeServer = (server) =>
  new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  });

export const runHarness = async ({ argv = process.argv.slice(2) } = {}) => {
  const options = parseHarnessArgs(argv);
  if (options.errors.length) {
    log(`usage error: ${options.errors.join("; ")}`);
    return { code: EXIT.USAGE };
  }

  // 2a. Refuse before anything is loaded (HX-1).
  const refusal = preflightRefusal(process.env);
  if (refusal) {
    log(`refusing to start: ${refusal}`);
    return { code: EXIT.REFUSED };
  }

  // 1. The committed environment, over the shell's, before any application import.
  applyE2eEnv(readE2eEnvFile());
  process.env.SESSION_JWT_SECRET = process.env.E2E_SESSION_JWT_SECRET && process.env.E2E_SESSION_JWT_SECRET.length >= 32 ? process.env.E2E_SESSION_JWT_SECRET : randomBytes(32).toString("hex");
  const controlToken = process.env.E2E_CONTROL_TOKEN && process.env.E2E_CONTROL_TOKEN.length >= 16 ? process.env.E2E_CONTROL_TOKEN : randomBytes(24).toString("hex");
  delete process.env.E2E_CONTROL_TOKEN; // the worker child never needs it
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "vivasayi-e2e-"));
  const storageDir = path.join(runDir, "storage");
  fs.mkdirSync(storageDir, { recursive: true });
  const scenarioFile = path.join(runDir, "scenario.json");
  const violationsFile = path.join(runDir, "network-violations.jsonl");
  process.env.IMAGE_STORAGE_MOCK_DIR = storageDir;
  process.env.E2E_SCENARIO_FILE = scenarioFile;
  process.env.E2E_NETWORK_VIOLATIONS_FILE = violationsFile;

  // 3. The network guard. With a local mongod binary it goes in before MongoDB starts; without one,
  // mongodb-memory-server may download its binary first (that download is not guarded; logged).
  if (!process.env.MONGOMS_SYSTEM_BINARY) {
    const found = MONGOD_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (found) process.env.MONGOMS_SYSTEM_BINARY = found;
  }
  const guardFirst = options.mongo === "local" || Boolean(process.env.MONGOMS_SYSTEM_BINARY);
  const onViolation = (violation) => log("BLOCKED external network attempt", { kind: violation.kind, host: violation.host, port: violation.port });
  if (guardFirst) installNetworkGuard({ label: "E2E", onViolation });
  else log("no local mongod binary found (set MONGOMS_SYSTEM_BINARY): mongodb-memory-server may download one before the network guard is installed");

  const cleanup = [];
  const runCleanup = async () => {
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (error) {
        log(`cleanup step failed: ${error?.message}`);
      }
    }
    cleanup.length = 0;
  };
  cleanup.push(() => fs.rmSync(runDir, { recursive: true, force: true }));

  try {
    // 4. MongoDB.
    let mongoInfo;
    let memoryServer = null;
    if (options.mongo === "local") {
      const problem = checkLocalMongoUri(process.env.E2E_MONGO_URI);
      if (problem) {
        log(`refusing to start: ${problem}`);
        await runCleanup();
        return { code: EXIT.REFUSED };
      }
      process.env.MONGO_URI = process.env.E2E_MONGO_URI.trim();
      mongoInfo = { mode: "local", uri: process.env.MONGO_URI };
    } else {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      memoryServer = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
      cleanup.push(() => memoryServer.stop());
      process.env.MONGO_URI = `${memoryServer.getUri().replace(/\/?$/, "/")}vivasayi_e2e`;
      mongoInfo = { mode: "memory", uri: process.env.MONGO_URI };
    }
    if (!guardFirst) installNetworkGuard({ label: "E2E", onViolation });

    // 7a. Bind the API port first (the dev receiver's public URL needs the real port).
    let handler = (req, res) => {
      res.statusCode = 503;
      res.end("starting");
    };
    const apiServer = http.createServer((req, res) => handler(req, res));
    const apiPort = await listen(apiServer, options.port, options.host);
    cleanup.push(() => closeServer(apiServer));
    const apiUrl = `http://${options.host}:${apiPort}`;
    process.env.DEV_STORAGE_PUBLIC_BASE_URL = apiUrl;

    // 2b. What the application loaded (HX-2).
    const envModule = await import("../../config/env.js");
    const problems = checkHermeticEnv({ source: process.env, appEnv: envModule.env });
    if (problems.length) {
      log(`refusing to start: ${problems.join("; ")}`);
      await runCleanup();
      return { code: EXIT.REFUSED };
    }

    // 5. Database, models, app, boot guards.
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(process.env.MONGO_URI);
    cleanup.push(() => mongoose.disconnect());
    if (options.mongo === "local") await mongoose.connection.db.dropDatabase();
    const app = (await import("../../app.js")).default;
    await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
    const { assertPolicyConfigured, resolvePolicy } = await import("../../config/verificationPolicy.js");
    assertPolicyConfigured();
    envModule.assertProductionSafety();
    const policy = resolvePolicy();

    // 6. The fake Gemini (shared state with a process worker through the scenario file).
    const { model } = await import("../../services/chat.service.js");
    const { createFakeGemini, installFakeGemini, loadPromptConstants, DEFAULT_FARMER_NAME } = await import("./lib/fakeGemini.js");
    const fake = createFakeGemini({ prompts: await loadPromptConstants() });
    installFakeGemini(model, fake);

    const { createHarnessServices } = await import("./lib/harnessServices.js");
    const services = await createHarnessServices({
      apiUrl,
      fake,
      policy,
      scenarioFile,
      violationsFile,
      defaultFarmerName: DEFAULT_FARMER_NAME,
      workerMode: options.worker,
      backendRoot: BACKEND_ROOT,
      log,
    });
    cleanup.push(() => services.stopWorker());

    handler = app;
    // 7b. The worker.
    if (options.worker !== "off") await services.startWorker();

    // 8. The control server.
    const { createControlApp } = await import("./lib/controlServer.js");
    const controlServer = http.createServer(createControlApp({ token: controlToken, deps: services.controlDeps({ controlUrl: () => controlUrl }) }));
    const controlPort = await listen(controlServer, options.controlPort, options.host);
    cleanup.push(() => closeServer(controlServer));
    const controlUrl = `http://${options.host}:${controlPort}`;

    // 9. The out file (0600: it holds the control token).
    const out = {
      apiUrl,
      controlUrl,
      controlToken,
      policy: { id: policy.id, hash: policy.hash },
      mongo: mongoInfo,
      worker: options.worker,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(options.out, 0o600);
    cleanup.push(() => fs.rmSync(options.out, { force: true }));
    log("ready", { apiUrl, controlUrl, policy: policy.id, worker: options.worker, out: options.out });

    return {
      code: null,
      apiUrl,
      controlUrl,
      shutdown: async () => {
        await runCleanup();
      },
      violations: () => networkViolations(),
    };
  } catch (error) {
    log(`failed to start: ${error?.message || error}`);
    await runCleanup();
    return { code: EXIT.FAILED };
  }
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const started = await runHarness();
  if (started.code !== null) process.exit(started.code);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`stopping (${signal})`);
    const timer = setTimeout(() => {
      log("shutdown timed out");
      process.exit(EXIT.FAILED);
    }, 30_000);
    timer.unref();
    await started.shutdown();
    log("stopped");
    process.exit(EXIT.OK);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

export default { runHarness, parseHarnessArgs, utcEventDate, defaultParcelGeometry, overLimitGeometry, squareAt, EXIT, DEFAULTS };
export { utcEventDate, defaultParcelGeometry, overLimitGeometry, squareAt };
