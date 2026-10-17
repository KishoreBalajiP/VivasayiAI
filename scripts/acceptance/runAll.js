// Acceptance runner (plan Part F):  npm run acceptance   then   npm run acceptance:report
//
// Runs every check in order and records each one as a suite in test-results/raw/run-manifest.json:
//   1. backend vitest with the JSON reporter            -> test-results/raw/backend-vitest.json
//   2. backend lint and build: N/A (the backend has neither), plus a `node --check` sweep of every .js file
//   3. frontend typecheck, lint and build              (exit code and stderr tail)
//   4. frontend vitest with the JSON reporter           -> test-results/raw/frontend-vitest.json
//   5. Playwright with the JSON reporter                -> test-results/raw/e2e-playwright.json
//   6. node scripts/eval/checkManuscriptNumbers.js
//   7. the frozen-hash check (docs/research/evaluation/live/FROZEN_HASHES.json)
// plus an environment fingerprint and a read-only git record of both repos at the start and end of the run.
// A step whose tool or script does not exist yet is recorded as "not_available", never as a pass.
//
// Flags: --only=<name,...> / --skip=<name,...>  run a subset; the rest are recorded as "not_run".
//        --strict  exit 1 when any suite failed. By default the run exits 0 once every step was attempted,
//                  so `npm run acceptance && npm run acceptance:report` always produces a report.
// The frontend is VIVASAYI_FRONTEND_DIR, default ../VivasayiAI-Frontend.
//
// SAFETY: child processes get VIVASAYI_SKIP_DOTENV=1 and blank live credentials, so no step loads the
// backend .env or reaches Atlas, S3, Copernicus or Cognito. npx runs with --no, so nothing is downloaded.
// Git commands are read-only (see collect.js). No secret is printed.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BACKEND_ROOT, checkFrozenHashes, collectEnvironment, collectGitState, makeRunId, nodeCheckSweep, relativeToRoot, repoSummary,
  resolveFrontendRoot,
} from "./collect.js";

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const RAW_DIR = "test-results/raw";
const TAIL_BYTES = 8 * 1024;
const MINUTE = 60_000;

// Credentials a child must never inherit. Every value is blanked, never read or printed.
const BLANKED_CREDENTIALS = [
  "MONGO_URI", "MY_AWS_ACCESS_KEY_ID", "MY_AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET", "SENTINEL_HUB_CLIENT_ID", "SENTINEL_HUB_CLIENT_SECRET",
  "LAND_RECORD_PROVIDER_URL", "LAND_RECORD_API_KEY", "COGNITO_CLIENT_SECRET",
];

export const childEnv = (base = process.env, extra = {}) => ({
  ...base,
  ...Object.fromEntries(BLANKED_CREDENTIALS.map((key) => [key, ""])),
  VIVASAYI_SKIP_DOTENV: "1",
  FORCE_COLOR: "0",
  ...extra,
});

const display = (argv) => argv.map((part, index) => {
  const value = index === 0 ? part.replace(/\.cmd$/, "").replace(process.execPath, "node") : part;
  return /[\s"'$`]/.test(value) ? JSON.stringify(value) : value;
}).join(" ");

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const hasScript = (packageJsonPath, script) => Boolean(readJson(packageJsonPath)?.scripts?.[script]);

const vitestCounts = (json) => (json ? {
  passed: json.numPassedTests ?? 0, failed: json.numFailedTests ?? 0, skipped: json.numPendingTests ?? 0, todo: json.numTodoTests ?? 0,
} : { passed: 0, failed: 0, skipped: 0, todo: 0 });

const playwrightCounts = (json) => (json?.stats ? {
  passed: json.stats.expected ?? 0, failed: json.stats.unexpected ?? 0, skipped: json.stats.skipped ?? 0, todo: 0, flaky: json.stats.flaky ?? 0,
} : { passed: 0, failed: 0, skipped: 0, todo: 0 });

// The ordered step list. `available()` returns null when the step can run, or the reason it cannot.
export const buildSteps = ({ backendRoot = BACKEND_ROOT, frontendRoot = resolveFrontendRoot() } = {}) => {
  const raw = (name) => join(backendRoot, RAW_DIR, name);
  const fePackage = join(frontendRoot, "package.json");
  const feMissing = () => (existsSync(fePackage) ? null : `frontend not found at ${frontendRoot} (set VIVASAYI_FRONTEND_DIR)`);
  const feScript = (script) => () => feMissing() || (hasScript(fePackage, script) ? null : `frontend package.json has no "${script}" script`);
  const feCommand = (script, timeoutMs) => ({
    name: `frontend-${script}`, kind: "command", repo: "frontend", cwd: backendRoot, timeoutMs,
    argv: [npm, "--prefix", frontendRoot, "run", script], available: feScript(script),
  });
  return [
    {
      name: "backend-vitest", kind: "tests", repo: "backend", cwd: backendRoot, timeoutMs: 60 * MINUTE,
      argv: [npx, "--no", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${RAW_DIR}/backend-vitest.json`],
      rawReport: raw("backend-vitest.json"), counts: vitestCounts,
      available: () => (existsSync(join(backendRoot, "node_modules", "vitest", "package.json")) ? null : "vitest is not installed in the backend (run npm ci)"),
    },
    { name: "backend-lint", kind: "na", repo: "backend", reason: "The backend has no lint script in package.json; recorded as N/A (critique B8). See backend-node-check." },
    { name: "backend-build", kind: "na", repo: "backend", reason: "The backend has no build step; recorded as N/A. A local docker build is optional and not part of this run." },
    { name: "backend-node-check", kind: "inline", repo: "backend", command: "node --check <every backend .js file, excluding node_modules>", run: () => nodeCheckSweep(backendRoot) },
    feCommand("typecheck", 15 * MINUTE),
    feCommand("lint", 15 * MINUTE),
    feCommand("build", 15 * MINUTE),
    {
      name: "frontend-vitest", kind: "tests", repo: "frontend", cwd: frontendRoot, timeoutMs: 30 * MINUTE,
      argv: [npx, "--no", "vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${raw("frontend-vitest.json")}`],
      rawReport: raw("frontend-vitest.json"), counts: vitestCounts,
      available: () => feMissing() || (existsSync(join(frontendRoot, "node_modules", "vitest", "package.json")) ? null : "vitest is not installed in the frontend (run npm ci)"),
    },
    {
      name: "e2e-playwright", kind: "tests", repo: "frontend", cwd: frontendRoot, timeoutMs: 90 * MINUTE,
      argv: [npx, "--no", "playwright", "test"], env: { E2E_JSON_OUT: raw("e2e-playwright.json") },
      rawReport: raw("e2e-playwright.json"), counts: playwrightCounts,
      available: () => {
        const missing = feMissing();
        if (missing) return missing;
        if (!existsSync(join(frontendRoot, "node_modules", "@playwright", "test", "package.json"))) return "@playwright/test is not installed in the frontend yet (plan Part C)";
        if (!["ts", "js", "mjs"].some((ext) => existsSync(join(frontendRoot, `playwright.config.${ext}`)))) return "the frontend has no playwright.config yet";
        return null;
      },
    },
    {
      name: "manuscript-numbers", kind: "command", repo: "backend", cwd: backendRoot, timeoutMs: 10 * MINUTE,
      argv: [process.execPath, "scripts/eval/checkManuscriptNumbers.js"],
      available: () => (existsSync(join(backendRoot, "scripts", "eval", "checkManuscriptNumbers.js")) ? null : "scripts/eval/checkManuscriptNumbers.js does not exist yet (plan Part D)"),
    },
    { name: "frozen-hashes", kind: "inline", repo: "backend", command: "sha256 of each file in docs/research/evaluation/live/FROZEN_HASHES.json", run: () => checkFrozenHashes(backendRoot) },
  ];
};

// Runs one command, streaming its output to the console and a log file, keeping a stderr tail.
const runCommand = (step, logPath) => new Promise((resolvePromise) => {
  const started = Date.now();
  const log = createWriteStream(logPath);
  let stderrTail = "";
  let timedOut = false;
  const child = spawn(step.argv[0], step.argv.slice(1), { cwd: step.cwd, env: childEnv(process.env, step.env), stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, step.timeoutMs ?? 30 * MINUTE);
  child.stdout.on("data", (chunk) => { process.stdout.write(chunk); log.write(chunk); });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
    stderrTail = (stderrTail + chunk.toString()).slice(-TAIL_BYTES);
  });
  const finish = (exitCode, error) => {
    clearTimeout(timer);
    log.end();
    resolvePromise({ exitCode, error, timedOut, durationMs: Date.now() - started, stderrTail });
  };
  child.on("error", (error) => finish(null, error));
  child.on("close", (code) => finish(code, null));
});

const baseRecord = (step) => ({
  name: step.name,
  kind: step.kind,
  repo: step.repo,
  command: step.argv ? display(step.argv) : step.command ?? null,
  argv: step.argv ?? null,
  cwd: step.cwd ?? null,
  rawReport: null,
  counts: { passed: 0, failed: 0, skipped: 0, todo: 0 },
  exitCode: null,
  durationMs: null,
  reason: null,
  stderrTail: null,
  log: null,
});

export const runStep = async (step, { backendRoot = BACKEND_ROOT, selected = true } = {}) => {
  const record = baseRecord(step);
  // N/A is a fact about the repo, not a run, so it is recorded whatever --only/--skip select.
  if (step.kind === "na") return { ...record, status: "n/a", reason: step.reason };
  if (!selected) return { ...record, status: "not_run", reason: "not selected (--only/--skip)" };
  if (step.kind === "inline") {
    const started = Date.now();
    const details = step.run();
    return { ...record, status: details.status, reason: details.reason ?? null, durationMs: Date.now() - started, details };
  }
  const unavailable = step.available ? step.available() : null;
  if (unavailable) return { ...record, status: "not_available", reason: unavailable };

  if (step.rawReport) rmSync(step.rawReport, { force: true });
  const logPath = join(backendRoot, RAW_DIR, "logs", `${step.name}.log`);
  console.log(`\n[acceptance] ${step.name}: ${record.command}`);
  const outcome = await runCommand(step, logPath);
  const result = {
    ...record,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    stderrTail: outcome.stderrTail || null,
    log: relativeToRoot(backendRoot, logPath),
  };
  if (outcome.error) return { ...result, status: "error", reason: `could not start: ${outcome.error.code || outcome.error.message}` };
  if (outcome.timedOut) return { ...result, status: "error", reason: `timed out after ${Math.round((step.timeoutMs ?? 0) / MINUTE)} min` };
  if (step.kind === "tests") {
    const json = existsSync(step.rawReport) ? readJson(step.rawReport) : null;
    const rawReport = relativeToRoot(backendRoot, step.rawReport);
    if (!json) return { ...result, status: "error", reason: `exit code ${outcome.exitCode} and no readable raw report at ${rawReport}` };
    return { ...result, rawReport, counts: step.counts(json), status: outcome.exitCode === 0 ? "passed" : "failed" };
  }
  return { ...result, status: outcome.exitCode === 0 ? "passed" : "failed" };
};

const parseList = (value) => (typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : null);

const gitSnapshot = (state) => (state?.available ? {
  head: state.head, diffHeadSha256: state.diffHeadSha256, untrackedContentSha256: state.untrackedContentSha256, statusLines: state.statusPorcelain.length,
} : null);

export const main = async (argv = process.argv.slice(2)) => {
  const args = Object.fromEntries(argv.map((arg) => /^--([^=]+)(?:=(.*))?$/.exec(arg)).filter(Boolean).map((match) => [match[1], match[2] ?? true]));
  const backendRoot = BACKEND_ROOT;
  const frontendRoot = resolveFrontendRoot();
  const only = parseList(args.only);
  const skip = parseList(args.skip) || [];
  const steps = buildSteps({ backendRoot, frontendRoot });
  const unknown = [...(only || []), ...skip].filter((name) => !steps.some((step) => step.name === name));
  if (unknown.length) {
    console.error(`[acceptance] unknown suite name(s): ${unknown.join(", ")}. Known: ${steps.map((step) => step.name).join(", ")}`);
    return 2;
  }

  mkdirSync(join(backendRoot, RAW_DIR, "logs"), { recursive: true });
  const items = readJson(join(backendRoot, "scripts", "acceptance", "acceptanceItems.json"));
  const baseline = items?.gitBaseline || {};
  const startedAt = new Date();
  const gitStart = {
    backend: collectGitState(backendRoot, baseline.backend),
    frontend: collectGitState(frontendRoot, baseline.frontend),
  };
  const runId = makeRunId(startedAt, gitStart.backend.shortHead);
  const environment = collectEnvironment({ backendRoot, frontendRoot });
  console.log(`[acceptance] run ${runId}; frontend ${frontendRoot}`);

  const suites = [];
  for (const step of steps) {
    const selected = (!only || only.includes(step.name)) && !skip.includes(step.name);
    const record = await runStep(step, { backendRoot, selected });
    suites.push(record);
    console.log(`[acceptance] ${record.name}: ${record.status}${record.reason ? ` (${record.reason})` : ""}`);
  }

  const gitEnd = {
    backend: collectGitState(backendRoot, baseline.backend),
    frontend: collectGitState(frontendRoot, baseline.frontend),
  };
  const repos = Object.fromEntries(["backend", "frontend"].map((name) => {
    const root = name === "backend" ? backendRoot : frontendRoot;
    const summary = repoSummary(root, gitStart[name]);
    const start = gitSnapshot(gitStart[name]);
    const end = gitSnapshot(gitEnd[name]);
    summary.git = gitStart[name].available
      ? { ...gitStart[name], atEnd: end, changedDuringRun: JSON.stringify(start) !== JSON.stringify(end) }
      : gitStart[name];
    return [name, summary];
  }));

  const manifest = {
    schema: "vivasayi-acceptance-run/v1",
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    argv,
    repos,
    environment,
    suites,
  };
  const manifestPath = join(backendRoot, RAW_DIR, "run-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n[acceptance] run ${runId} recorded in ${relativeToRoot(backendRoot, manifestPath)}`);
  for (const suite of suites) console.log(`  ${suite.name.padEnd(20)} ${suite.status.padEnd(14)} ${suite.exitCode ?? ""}`);
  console.log("[acceptance] next: npm run acceptance:report");
  const failed = suites.some((suite) => ["failed", "error"].includes(suite.status));
  return args.strict && failed ? 1 : 0;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[acceptance] runner error: ${error.stack || error.message}`);
    process.exitCode = 2;
  });
}
