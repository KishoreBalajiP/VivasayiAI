// Acceptance report generator (plan Part F; design-testing section 1 "Machine-readable results").
//
//   npm run acceptance:report
//   npm run acceptance:report -- --rerun-failures=3 --triage=test-results/acceptance/triage.json
//
// Reads what runAll.js left under test-results/raw/ (backend-vitest.json, frontend-vitest.json,
// e2e-playwright.json, run-manifest.json), maps every test to the S01-S24 scenarios in matrix.json, merges
// human triage, and writes test-results/acceptance/results-<runId>.json (validated against
// results.schema.json) plus REPORT-<runId>.md. Run on its own, without a manifest, any suite with no raw
// report is "not_run" and the git and environment record is collected now (read-only).
//
// Flags: --raw-dir=<dir> --manifest=<file> --backend-json=<file> --frontend-json=<file> --playwright-json=<file>
//        --matrix=<file> --items=<file> --triage=<file> --out-dir=<dir> --run-id=<id> --rerun-failures=<n>
//        --no-git --strict (exit 1 when the automated verdict is NOT READY)
//
// Nothing here calls a provider. --rerun-failures re-runs only the failing tests' own hermetic commands.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BACKEND_ROOT, checkFrozenHashes, collectEnvironment, collectGitState, makeRunId, nodeCheckSweep, relativeToRoot, repoSummary,
  resolveFrontendRoot, sha1, sha256,
} from "./collect.js";
import { validateAgainstSchema } from "./schemaValidate.js";

export const ID_PATTERN = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+[a-z]?):/;
export const UNTRIAGED = "UNTRIAGED";
export const NOT_EXTRACTED = "(not extracted; see the failure message)";
const SEVERITY_ORDER = ["S1", "S2", "S3", "S4"];
const TRIAGE_CATEGORIES = new Set(["code_defect", "test_defect", "external_blocker", "environment"]);
const REPORT_SUITES = new Set(["backend-vitest", "frontend-vitest", "e2e-playwright"]);
const UNAVAILABLE = new Set(["not_available", "not_run", "n/a"]);

// --- Small text helpers ------------------------------------------------------------------------------------

export const stripAnsi = (text) => String(text ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");

export const extractId = (title) => {
  const match = ID_PATTERN.exec(String(title ?? ""));
  return match ? match[1] : null;
};

export const firstFailureLine = (message) =>
  stripAnsi(message).split("\n").map((line) => line.trim()).find(Boolean) ?? "";

// Volatile tokens (ObjectIds, UUIDs, ISO timestamps) are masked so one defect keeps one signature across runs.
export const normaliseSignatureLine = (line) => String(line)
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
  .replace(/\b[0-9a-f]{24}\b/gi, "<objectid>")
  .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<time>")
  .trim();

export const failureSignature = (message) => sha1(normaliseSignatureLine(firstFailureLine(message)));

const truncate = (text, max = 500) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const EQUALITY_VERBS = new Set(["deeply equal", "strictly equal", "equal", "be"]);
const CHAI_EXPECT = /\bexpected (.+?) to (not )?(deeply equal|strictly equal|equal|be close to|be greater than or equal to|be greater than|be less than or equal to|be less than|be an instance of|be|include|contain|match|have length|have property|have been called with|have been called times|have been called|throw)\b ?(.*?)(?: \/\/ Object\.is equality)?$/i;

// Expected/actual from the failure text: Jest/Playwright "Expected:/Received:" lines first, then the chai
// wording vitest uses ("expected 3 to be 2"). Anything else is reported as not extracted, never guessed.
export const extractExpectedActual = (message) => {
  const text = stripAnsi(message);
  const expected = /^\s*Expected(?: [a-z]+)*:\s*(.*)$/m.exec(text);
  const received = /^\s*Received(?: [a-z]+)*:\s*(.*)$/m.exec(text);
  if (expected || received) {
    return { expected: truncate(expected ? expected[1].trim() : NOT_EXTRACTED), actual: truncate(received ? received[1].trim() : NOT_EXTRACTED) };
  }
  const first = firstFailureLine(text);
  const chai = CHAI_EXPECT.exec(first);
  if (chai) {
    const [, actual, negated = "", verb, rest] = chai;
    const wanted = EQUALITY_VERBS.has(verb.toLowerCase()) && rest ? `${negated}${rest}` : `${negated}${verb} ${rest}`.trim();
    return { expected: truncate(wanted), actual: truncate(actual) };
  }
  return { expected: NOT_EXTRACTED, actual: truncate(first || NOT_EXTRACTED) };
};

const STACK_FRAME = /^\s*at (?:(.*?) \()?(?:file:\/\/)?((?:\/|[A-Za-z]:[\\/])[^()]*?):(\d+):(\d+)\)?\s*$/;

const insideRoot = (root, path) => {
  if (!root) return false;
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
};

// File and function of the nearest stack frame inside the repo (node_modules excluded), else the reported
// error location, else the test file.
export const locateFailure = (message, repoRoot, fallback = {}) => {
  for (const line of stripAnsi(message).split("\n")) {
    const frame = STACK_FRAME.exec(line);
    if (!frame) continue;
    const [, fn, path, lineNo, column] = frame;
    if (path.includes("/node_modules/") || path.includes("\\node_modules\\") || !insideRoot(repoRoot, path)) continue;
    return { file: `${relativeToRoot(repoRoot, path)}:${lineNo}:${column}`, function: fn ? fn.replace(/^async /, "") : "<anonymous>" };
  }
  if (fallback.location?.file) {
    const rel = relativeToRoot(repoRoot, fallback.location.file);
    return { file: `${rel}:${fallback.location.line ?? "?"}:${fallback.location.column ?? "?"}`, function: null };
  }
  return { file: fallback.file ?? null, function: null };
};

const shellQuote = (value) => `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The command a person runs to reproduce one failure (design-testing section 1).
export const rerunCommand = (test) => {
  const pattern = test.baseId ? `${test.baseId}:` : escapeRegExp(test.title);
  if (test.suite === "e2e-playwright") {
    const project = test.project ? ` --project=${test.project}` : "";
    return `npx playwright test ${test.file}${project} -g ${shellQuote(pattern)}`;
  }
  return `npx vitest run ${test.file} -t ${shellQuote(pattern)}`;
};

// --- Matrix helpers ----------------------------------------------------------------------------------------

const globToRegExp = (glob) => new RegExp(`^${glob
  .replace(/[.+^${}()|[\]\\]/g, "\\$&")
  .replace(/\*\*\//g, "\u0000")
  .replace(/\*\*/g, "\u0001")
  .replace(/\*/g, "[^/]*")
  .replace(/\u0000/g, "(?:.*/)?")
  .replace(/\u0001/g, ".*")}$`);

const SUITE_LEVEL = { "backend-vitest": "I/API", "frontend-vitest": "FE-U", "e2e-playwright": "E2E" };

export const levelForFile = (matrix, repo, file, suite) => {
  const exact = matrix?.fileLevels?.files?.[repo]?.[file];
  if (exact) return exact;
  for (const pattern of matrix?.fileLevels?.patterns || []) {
    if (pattern.repo === repo && globToRegExp(pattern.glob).test(file)) return pattern.level;
  }
  return SUITE_LEVEL[suite] ?? "I/API";
};

export const selectorLabel = (selector) => (typeof selector === "string"
  ? selector
  : `file:${selector.repo || "backend"}/${selector.file}${selector.title ? ` ~/${selector.title}/i` : ""}`);

const registryPrefixes = (matrix) => [...(matrix?.registry || [])].sort((a, b) => b.prefix.length - a.prefix.length);

export const suiteForSelector = (matrix, selector, column) => {
  if (typeof selector === "object") {
    if (selector.suite) return selector.suite;
    if ((selector.repo || "backend") === "backend") return "backend-vitest";
    return selector.file.startsWith("e2e/") ? "e2e-playwright" : "frontend-vitest";
  }
  const id = selector.endsWith("-*") ? selector.slice(0, -1) : selector;
  const entry = registryPrefixes(matrix).find((item) => id.startsWith(`${item.prefix}-`));
  if (entry?.suite) return entry.suite;
  return matrix?.levelSuites?.[column] ?? "backend-vitest";
};

export const matchSelector = (selector, tests) => {
  if (typeof selector === "string") {
    if (selector.endsWith("-*")) {
      const prefix = selector.slice(0, -1);
      return tests.filter((test) => test.baseId && test.baseId.startsWith(prefix));
    }
    return tests.filter((test) => test.baseId === selector);
  }
  const repo = selector.repo || "backend";
  const title = selector.title ? new RegExp(selector.title, "i") : null;
  return tests.filter((test) => test.repo === repo && test.file === selector.file && (!title || title.test(test.fullName)));
};

// One selector's outcome: passed | failed | incomplete | missing | blocked.
export const evaluateSelector = (matrix, selector, column, tests, suitesByName) => {
  const matched = matchSelector(selector, tests);
  const suiteName = suiteForSelector(matrix, selector, column);
  const suite = suitesByName.get(suiteName);
  if (matched.length === 0) {
    if (!suite || UNAVAILABLE.has(suite.status)) return { outcome: "blocked", suite: suiteName, reason: `${suiteName} ${suite?.status ?? "not_run"}`, matched };
    if (suite.status === "error") return { outcome: "failed", suite: suiteName, reason: `${suiteName} errored before reporting`, matched };
    return { outcome: "missing", suite: suiteName, matched };
  }
  if (matched.some((test) => test.status === "failed")) return { outcome: "failed", suite: suiteName, matched };
  if (matched.every((test) => test.status === "passed")) return { outcome: "passed", suite: suiteName, matched };
  return { outcome: "incomplete", suite: suiteName, matched };
};

const statusFromOutcomes = (outcomes) => {
  if (outcomes.some((o) => o.outcome === "failed")) return "fail";
  if (outcomes.some((o) => o.outcome === "missing")) return "missing";
  if (outcomes.some((o) => o.outcome === "blocked")) return "blocked";
  if (outcomes.some((o) => o.outcome === "incomplete")) return "partial";
  return "pass";
};

const labelsWith = (outcomes, outcome) => outcomes.filter((o) => o.outcome === outcome).map((o) => o.label);

// Scenario status: fail > missing > blocked > partial > pass. A required test that is absent while its suite
// produced a report is "missing"; absent because the suite never ran or is not installed is "blocked".
export const evaluateScenarios = (matrix, tests, suites) => {
  const suitesByName = new Map(suites.map((suite) => [suite.name, suite]));
  return (matrix.scenarios || []).map((scenario) => {
    const outcomes = Object.entries(scenario.tests || {}).flatMap(([column, selectors]) =>
      selectors.map((selector) => ({ label: selectorLabel(selector), ...evaluateSelector(matrix, selector, column, tests, suitesByName) })));
    for (const outcome of outcomes) {
      for (const test of outcome.matched) if (!test.scenarios.includes(scenario.id)) test.scenarios.push(scenario.id);
    }
    return {
      id: scenario.id,
      name: scenario.name,
      requiredTests: outcomes.map((o) => o.label),
      status: statusFromOutcomes(outcomes),
      missingTests: labelsWith(outcomes, "missing"),
      failedTests: labelsWith(outcomes, "failed"),
      blockedTests: labelsWith(outcomes, "blocked"),
      incompleteTests: labelsWith(outcomes, "incomplete"),
      passedTests: labelsWith(outcomes, "passed"),
      releaseBlocking: Boolean(scenario.releaseBlocking),
      severity: scenario.severity,
      mocks: scenario.mocks || [],
      decisionRefs: scenario.decisionRefs || [],
    };
  });
};

export const evaluateAcceptanceItems = (matrix, itemsDoc, tests, suites, scenarios) => {
  const suitesByName = new Map(suites.map((suite) => [suite.name, suite]));
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  return (itemsDoc?.items || []).map((item) => {
    let testStatus = "no_tests";
    let missing = [];
    let failed = [];
    if (item.scenario && scenarioById.has(item.scenario)) {
      const scenario = scenarioById.get(item.scenario);
      ({ status: testStatus, missingTests: missing, failedTests: failed } = scenario);
    } else if ((item.tests || []).length) {
      const outcomes = item.tests.map((selector) => ({ label: selectorLabel(selector), ...evaluateSelector(matrix, selector, undefined, tests, suitesByName) }));
      testStatus = statusFromOutcomes(outcomes);
      missing = labelsWith(outcomes, "missing");
      failed = labelsWith(outcomes, "failed");
    }
    return {
      id: item.id,
      title: item.title,
      decisionRef: item.decisionRef ?? null,
      releaseBlocking: Boolean(item.releaseBlocking),
      testStatus,
      liveValidation: item.liveValidation?.label ?? "N/A",
      tests: (item.tests || []).map(selectorLabel),
      missingTests: missing,
      failedTests: failed,
      evidenceRequired: item.evidenceRequired || [],
    };
  });
};

// --- Raw report parsers ------------------------------------------------------------------------------------

const VITEST_STATUS = { passed: "passed", failed: "failed", skipped: "skipped", pending: "skipped", disabled: "skipped", todo: "todo" };

const roundMs = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

// Vitest JSON reporter: testResults[].assertionResults[] { title, fullName, status, duration, failureMessages }.
export const parseVitestReport = (json, { suite, repo, repoRoot, matrix, rawReport = null }) => {
  const tests = [];
  const fileErrors = [];
  for (const fileResult of json?.testResults || []) {
    const file = relativeToRoot(repoRoot, fileResult.name);
    const assertions = fileResult.assertionResults || [];
    if (fileResult.status === "failed" && !assertions.some((a) => a.status === "failed")) {
      fileErrors.push({ suite, repo, repoRoot, rawReport, file, message: stripAnsi(fileResult.message) || "The test file failed without a failing test (load or hook error)." });
    }
    for (const assertion of assertions) {
      const baseId = extractId(assertion.title);
      const fullName = assertion.fullName || [...(assertion.ancestorTitles || []), assertion.title].join(" ");
      tests.push({
        id: baseId ?? `UNLABELLED::${file}::${fullName}`,
        baseId,
        labelled: Boolean(baseId),
        title: assertion.title,
        fullName,
        file,
        repo,
        suite,
        project: null,
        level: levelForFile(matrix, repo, file, suite),
        status: VITEST_STATUS[assertion.status] ?? "skipped",
        durationMs: roundMs(assertion.duration),
        scenarios: [],
        attachments: [],
        _failureMessages: (assertion.failureMessages || []).map(stripAnsi),
        _location: assertion.location ? { file: fileResult.name, line: assertion.location.line, column: assertion.location.column } : null,
        _repoRoot: repoRoot,
        _rawReport: rawReport,
      });
    }
  }
  return { tests, fileErrors, globalErrors: [] };
};

const playwrightStatus = (test, last) => {
  if (test.status === "flaky") return "flaky";
  if (test.status === "skipped") return "skipped";
  if (test.status === "unexpected") return "failed";
  if (test.status === "expected") return last?.status === "skipped" ? "skipped" : "passed";
  if (last?.status === "passed") return "passed";
  if (last?.status === "skipped") return "skipped";
  return "failed";
};

// Playwright JSON reporter: suites[] (nested) -> specs[] -> tests[] (one per project) -> results[] (one per retry).
export const parsePlaywrightReport = (json, { suite, repo, repoRoot, matrix, rawReport = null }) => {
  const tests = [];
  const rootDir = json?.config?.rootDir || repoRoot;
  const walk = (node, ancestors) => {
    for (const spec of node.specs || []) {
      const file = relativeToRoot(repoRoot, resolve(rootDir, spec.file || node.file || ""));
      for (const test of spec.tests || []) {
        const project = test.projectName || test.projectId || null;
        const results = test.results || [];
        const last = results[results.length - 1];
        const baseId = extractId(spec.title);
        const fullName = [...ancestors, spec.title].join(" ");
        const suffix = project ? `@${project}` : "";
        const id = baseId ? `${baseId}${suffix}` : `UNLABELLED::${file}::${fullName}${suffix}`;
        const errors = last ? (last.errors?.length ? last.errors : last.error ? [last.error] : []) : [];
        tests.push({
          id,
          baseId,
          labelled: Boolean(baseId),
          title: spec.title,
          fullName,
          file,
          repo,
          suite,
          project,
          level: levelForFile(matrix, repo, file, suite),
          status: playwrightStatus(test, last),
          durationMs: roundMs(last?.duration),
          scenarios: [],
          attachments: results.flatMap((result) => (result.attachments || []).map((attachment) => ({
            testId: id,
            project,
            name: attachment.name,
            contentType: attachment.contentType ?? null,
            path: attachment.path ? relativeToRoot(repoRoot, attachment.path) : null,
            _body: attachment.body ?? null,
            _absolutePath: attachment.path ?? null,
          }))),
          _failureMessages: errors.map((error) => stripAnsi([error.message, error.stack].filter(Boolean).join("\n"))),
          _location: errors.find((error) => error.location)?.location ?? null,
          _repoRoot: repoRoot,
          _rawReport: rawReport,
        });
      }
    }
    for (const child of node.suites || []) walk(child, child.title ? [...ancestors, child.title] : ancestors);
  };
  for (const top of json?.suites || []) walk(top, []);
  const globalErrors = (json?.errors || []).map((error) => stripAnsi(error.message || error.stack || String(error)));
  return { tests, fileErrors: [], globalErrors };
};

// --- Aggregation -------------------------------------------------------------------------------------------

// Same base ID in two different files (or suites) is a collision. The same spec in two Playwright projects,
// or one parameterised test, is not. Colliding tests are namespaced by file: "<ID>::<file>".
export const detectCollisions = (tests, matrix) => {
  const byId = new Map();
  for (const test of tests) {
    if (!test.baseId) continue;
    const place = `${test.suite}::${test.file}`;
    if (!byId.has(test.baseId)) byId.set(test.baseId, new Map());
    const places = byId.get(test.baseId);
    if (!places.has(place)) places.set(place, { suite: test.suite, file: test.file, titles: new Set() });
    places.get(place).titles.add(test.title);
  }
  const known = new Set((matrix?.knownCollisions || []).map((entry) => entry.id));
  const collisions = [];
  for (const [id, places] of byId) {
    if (places.size < 2) continue;
    collisions.push({ id, known: known.has(id), occurrences: [...places.values()].map((place) => ({ suite: place.suite, file: place.file, titles: [...place.titles] })) });
  }
  const colliding = new Set(collisions.map((collision) => collision.id));
  for (const test of tests) {
    if (test.baseId && colliding.has(test.baseId)) test.id = `${test.baseId}::${test.file}${test.project ? `@${test.project}` : ""}`;
  }
  return collisions.sort((a, b) => a.id.localeCompare(b.id));
};

const severityRank = (severity) => {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
};

const defaultsForTest = (matrix, test, scenarioById) => {
  const linked = test.scenarios.map((id) => scenarioById.get(id)).filter(Boolean);
  if (linked.length) {
    const worst = linked.reduce((best, scenario) => (severityRank(scenario.severity) < severityRank(best.severity) ? scenario : best));
    return { severity: worst.severity, releaseBlocking: linked.some((scenario) => scenario.releaseBlocking), severitySource: `matrix:${linked.map((s) => s.id).join(",")}` };
  }
  const fallback = matrix?.defaults?.unmappedFailure || { severity: "S2", releaseBlocking: true };
  return { severity: fallback.severity, releaseBlocking: fallback.releaseBlocking, severitySource: "matrix:defaults.unmappedFailure" };
};

const suiteDefaults = (matrix, name) => {
  const entry = matrix?.suiteDefaults?.[name] || matrix?.defaults?.unmappedFailure || { severity: "S2", releaseBlocking: true };
  return { severity: entry.severity, releaseBlocking: entry.releaseBlocking, severitySource: matrix?.suiteDefaults?.[name] ? `matrix:suiteDefaults.${name}` : "matrix:defaults.unmappedFailure" };
};

const untriagedFields = { rootCause: UNTRIAGED, impact: UNTRIAGED, fix: UNTRIAGED, category: "untriaged", untriaged: true };

export const buildFailures = ({ matrix, tests, fileErrors, globalErrors, suites, scenarios }) => {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const failures = [];
  for (const test of tests.filter((item) => item.status === "failed")) {
    const message = test._failureMessages.join("\n\n") || "The test failed without a message.";
    const { expected, actual } = extractExpectedActual(message);
    const where = locateFailure(message, test._repoRoot, { location: test._location, file: test.file });
    failures.push({
      id: test.id,
      kind: "test",
      title: test.fullName,
      suite: test.suite,
      repo: test.repo,
      cwd: test._repoRoot ?? null,
      command: rerunCommand(test),
      expected,
      actual,
      ...untriagedFields,
      ...defaultsForTest(matrix, test, scenarioById),
      file: where.file,
      function: where.function,
      reproducible: "not rerun",
      signature: failureSignature(message),
      scenarios: [...test.scenarios],
      firstLine: truncate(firstFailureLine(message), 300),
      evidence: [
        `${test._rawReport ?? test.suite} :: ${test.file} > ${test.fullName}${test.project ? ` [${test.project}]` : ""}`,
        ...test.attachments.filter((attachment) => attachment.path).map((attachment) => `${attachment.name}: ${attachment.path}`),
      ],
      _test: test,
    });
  }
  for (const error of fileErrors) {
    failures.push({
      id: `FILE::${error.file}`,
      kind: "file",
      title: error.file,
      suite: error.suite,
      repo: error.repo,
      cwd: error.repoRoot ?? null,
      command: error.suite === "e2e-playwright" ? `npx playwright test ${error.file}` : `npx vitest run ${error.file}`,
      expected: "the test file loads and its tests run",
      actual: truncate(firstFailureLine(error.message)),
      ...untriagedFields,
      ...suiteDefaults(matrix, error.suite),
      file: locateFailure(error.message, error.repoRoot, { file: error.file }).file,
      function: null,
      reproducible: "not rerun",
      signature: failureSignature(error.message),
      scenarios: [],
      firstLine: truncate(firstFailureLine(error.message), 300),
      evidence: [`${error.rawReport ?? error.suite} :: ${error.file}`],
      _fileError: error,
    });
  }
  const failedBySuite = new Set(failures.map((failure) => failure.suite));
  for (const suite of suites) {
    if (!["failed", "error"].includes(suite.status)) continue;
    const parsedSuite = REPORT_SUITES.has(suite.name);
    const globals = suite.name === "e2e-playwright" ? globalErrors : [];
    if (parsedSuite && failedBySuite.has(suite.name) && globals.length === 0) continue;
    const message = globals[0] || suite.reason || suite.stderrTail || `exit code ${suite.exitCode}`;
    const nodeCheckFile = suite.details?.failed?.[0]?.file ?? null;
    failures.push({
      id: `SUITE::${suite.name}`,
      kind: "suite",
      title: suite.name,
      suite: suite.name,
      repo: suite.repo ?? "backend",
      cwd: suite.cwd ?? null,
      command: suite.command || `(${suite.name})`,
      expected: suite.name === "frozen-hashes" ? "every frozen artifact matches FROZEN_HASHES.json" : "exit code 0",
      actual: truncate(`${suite.exitCode === null || suite.exitCode === undefined ? suite.status : `exit code ${suite.exitCode}`}: ${firstFailureLine(message)}`),
      ...untriagedFields,
      ...suiteDefaults(matrix, suite.name),
      file: nodeCheckFile,
      function: null,
      reproducible: "not rerun",
      signature: failureSignature(message),
      scenarios: [],
      firstLine: truncate(firstFailureLine(message), 300),
      evidence: [suite.rawReport, suite.log].filter(Boolean),
      _suite: suite,
    });
  }
  return failures;
};

// Merges test-results/acceptance/triage.json, keyed by id + signature. A failure without a complete entry
// (category, rootCause, impact and fix) stays flagged as untriaged.
export const mergeTriage = (failures, triage) => {
  const entries = Array.isArray(triage?.entries) ? triage.entries : [];
  const index = new Map(entries.map((entry) => [`${entry.id}|${entry.signature}`, entry]));
  const used = new Set();
  const merged = failures.map((failure) => {
    const key = `${failure.id}|${failure.signature}`;
    const entry = index.get(key);
    if (!entry) return failure;
    used.add(key);
    const complete = TRIAGE_CATEGORIES.has(entry.category) && [entry.rootCause, entry.impact, entry.fix].every((field) => typeof field === "string" && field.trim());
    return {
      ...failure,
      rootCause: entry.rootCause?.trim() || UNTRIAGED,
      impact: entry.impact?.trim() || UNTRIAGED,
      fix: entry.fix?.trim() || UNTRIAGED,
      category: complete ? entry.category : "untriaged",
      untriaged: !complete,
      severity: SEVERITY_ORDER.includes(entry.severity) ? entry.severity : failure.severity,
      severitySource: SEVERITY_ORDER.includes(entry.severity) ? "triage" : failure.severitySource,
      releaseBlocking: typeof entry.releaseBlocking === "boolean" ? entry.releaseBlocking : failure.releaseBlocking,
    };
  });
  const unmatched = entries.filter((entry) => !used.has(`${entry.id}|${entry.signature}`)).map((entry) => `${entry.id}|${entry.signature}`);
  return { failures: merged, unmatched };
};

export const reproducibilityLabel = (failedRuns, foundRuns, times) => {
  if (foundRuns < times) return `inconclusive (${foundRuns}/${times} found)`;
  if (failedRuns === times) return `yes (${failedRuns}/${times})`;
  if (failedRuns === 0) return `no (0/${times})`;
  return `flaky (${failedRuns}/${times})`;
};

// Re-runs each failing command `times` times. `runner(failure, attempt)` returns "failed" | "passed" | "not_found".
export const rerunFailures = (failures, times, runner) => failures.map((failure) => {
  let failedRuns = 0;
  let foundRuns = 0;
  for (let attempt = 1; attempt <= times; attempt += 1) {
    const outcome = runner(failure, attempt);
    if (outcome !== "not_found") foundRuns += 1;
    if (outcome === "failed") failedRuns += 1;
  }
  return { ...failure, reproducible: reproducibilityLabel(failedRuns, foundRuns, times) };
});

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Default rerun: the failing test's own command with a JSON reporter into test-results/acceptance/reruns/.
// Suite-level reruns never pass the original --outputFile/E2E_JSON_OUT, so the raw evidence is not overwritten.
export const makeProcessRunner = ({ backendRoot = BACKEND_ROOT, matrix } = {}) => {
  const rerunDir = join(backendRoot, "test-results", "acceptance", "reruns");
  mkdirSync(rerunDir, { recursive: true });
  const env = { ...process.env, VIVASAYI_SKIP_DOTENV: "1" };
  const options = (cwd, extraEnv = {}) => ({ cwd, env: { ...env, ...extraEnv }, stdio: "ignore", timeout: 30 * 60_000 });
  const exitOutcome = (result) => (result.status === 0 ? "passed" : "failed");
  return (failure, attempt) => {
    const cwd = failure.cwd || backendRoot;
    if (failure.kind === "suite") {
      const suite = failure._suite || {};
      if (suite.name === "frozen-hashes") return checkFrozenHashes(backendRoot).status === "passed" ? "passed" : "failed";
      if (suite.name === "backend-node-check") return nodeCheckSweep(backendRoot).status === "passed" ? "passed" : "failed";
      if (suite.name === "backend-vitest" || suite.name === "frontend-vitest") return exitOutcome(spawnSync(npx, ["--no", "vitest", "run"], options(suite.cwd || cwd)));
      if (suite.name === "e2e-playwright") return exitOutcome(spawnSync(npx, ["--no", "playwright", "test", "--reporter=list"], options(suite.cwd || cwd)));
      if (!Array.isArray(suite.argv) || suite.argv.length === 0) return "not_found";
      return exitOutcome(spawnSync(suite.argv[0], suite.argv.slice(1), options(suite.cwd || cwd)));
    }
    if (failure.kind === "file") {
      const error = failure._fileError || {};
      const args = error.suite === "e2e-playwright" ? ["--no", "playwright", "test", error.file, "--reporter=list"] : ["--no", "vitest", "run", error.file];
      return exitOutcome(spawnSync(npx, args, options(cwd)));
    }
    const test = failure._test;
    const out = join(rerunDir, `${sha1(`${failure.id}|${attempt}`).slice(0, 12)}.json`);
    rmSync(out, { force: true });
    const pattern = test.baseId ? `${test.baseId}:` : escapeRegExp(test.title);
    const playwright = test.suite === "e2e-playwright";
    const args = playwright
      ? ["--no", "playwright", "test", test.file, ...(test.project ? [`--project=${test.project}`] : []), "-g", pattern, "--reporter=json"]
      : ["--no", "vitest", "run", test.file, "-t", pattern, "--reporter=json", `--outputFile.json=${out}`];
    spawnSync(npx, args, options(cwd, playwright ? { PLAYWRIGHT_JSON_OUTPUT_NAME: out, E2E_JSON_OUT: out } : {}));
    if (!existsSync(out)) return "not_found";
    const json = JSON.parse(readFileSync(out, "utf8"));
    const context = { suite: test.suite, repo: test.repo, repoRoot: test._repoRoot, matrix };
    const parsed = playwright ? parsePlaywrightReport(json, context) : parseVitestReport(json, context);
    const again = parsed.tests.find((item) => item.file === test.file && item.fullName === test.fullName && item.project === test.project);
    if (!again) return "not_found";
    return again.status === "failed" ? "failed" : "passed";
  };
};

const readJsonAttachment = (attachment) => {
  try {
    if (attachment._body) return JSON.parse(Buffer.from(attachment._body, "base64").toString("utf8"));
    if (attachment._absolutePath && existsSync(attachment._absolutePath)) return JSON.parse(readFileSync(attachment._absolutePath, "utf8"));
  } catch { /* not JSON: reported as unreadable below */ }
  return undefined;
};

// Network violations come from Playwright attachments named like "network-violations" (the e2e afterEach)
// and from an optional harness dump at test-results/raw/network-violations.json.
export const collectNetworkViolations = (tests, extraFiles = []) => {
  const violations = [];
  for (const test of tests) {
    for (const attachment of test.attachments) {
      if (!/network[-_ ]?violation/i.test(attachment.name || "")) continue;
      const value = readJsonAttachment(attachment);
      const list = Array.isArray(value) ? value : Array.isArray(value?.violations) ? value.violations : value === undefined ? ["(unreadable attachment)"] : [value];
      for (const item of list) violations.push({ source: `playwright:${test.id}`, testId: test.id, detail: truncate(typeof item === "string" ? item : JSON.stringify(item), 500) });
    }
  }
  for (const file of extraFiles) {
    if (!existsSync(file)) continue;
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      const list = Array.isArray(value) ? value : value?.violations || [];
      for (const item of list) violations.push({ source: file, testId: null, detail: truncate(typeof item === "string" ? item : JSON.stringify(item), 500) });
    } catch {
      violations.push({ source: file, testId: null, detail: "(unreadable network-violations file)" });
    }
  }
  return violations;
};

const countTests = (tests) => {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, flaky: 0 };
  for (const test of tests) counts[test.status] += 1;
  return counts;
};

const stripInternal = (value) => {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")).map(([key, child]) => [key, stripInternal(child)]));
  }
  return value;
};

// Builds the full results document from already-parsed inputs. Pure apart from the optional rerun runner.
export const buildResults = ({
  runId, generatedAt, matrix, itemsDoc = null, suites, parsed, repos, environment, triage = null,
  rerunTimes = 0, runner = null, networkViolationFiles = [], inputs = {},
}) => {
  const tests = parsed.flatMap((entry) => entry.tests);
  const fileErrors = parsed.flatMap((entry) => entry.fileErrors);
  const globalErrors = parsed.flatMap((entry) => entry.globalErrors);

  const suiteList = suites.map((suite) => {
    const own = tests.filter((test) => test.suite === suite.name);
    const counts = REPORT_SUITES.has(suite.name) && own.length ? countTests(own) : (suite.counts || { passed: 0, failed: 0, skipped: 0, todo: 0 });
    return { ...suite, counts: { passed: counts.passed ?? 0, failed: counts.failed ?? 0, skipped: counts.skipped ?? 0, todo: counts.todo ?? 0, flaky: counts.flaky ?? 0 } };
  });

  const idCollisions = detectCollisions(tests, matrix);
  const scenarios = evaluateScenarios(matrix, tests, suiteList);
  const acceptanceItems = evaluateAcceptanceItems(matrix, itemsDoc, tests, suiteList, scenarios);

  let failures = buildFailures({ matrix, tests, fileErrors, globalErrors, suites: suiteList, scenarios });
  const triaged = mergeTriage(failures, triage);
  failures = triaged.failures;
  if (rerunTimes > 0 && runner) failures = rerunFailures(failures, rerunTimes, runner);

  const flaky = [
    ...tests.filter((test) => test.status === "flaky").map((test) => ({ id: test.id, source: "playwright_retry", detail: "failed, then passed on a Playwright retry" })),
    ...failures.filter((failure) => /^(flaky|no) /.test(failure.reproducible)).map((failure) => ({ id: failure.id, source: "rerun", detail: `reproducible: ${failure.reproducible}` })),
  ];

  const blocked = [
    ...suiteList.filter((suite) => UNAVAILABLE.has(suite.status) && suite.status !== "n/a").map((suite) => ({
      id: `SUITE::${suite.name}`, kind: "suite", reason: `${suite.status}: ${suite.reason || "no reason recorded"}`, decisionRef: null,
      releaseBlocking: suiteDefaults(matrix, suite.name).releaseBlocking, evidence: [suite.command].filter(Boolean),
    })),
    // A live status that is blocked or not deployed by an owner decision (D6, D7) does not block release by itself;
    // an item opts in with liveValidation.releaseBlocking. The item's own tests still count through its scenarios.
    ...(itemsDoc?.items || []).filter((item) => item.liveValidation && item.liveValidation.status !== "N/A").map((item) => ({
      id: item.id, kind: "live_item", reason: `${item.liveValidation.label}: ${item.liveValidation.reason || item.title}`, decisionRef: item.decisionRef ?? null,
      releaseBlocking: Boolean(item.liveValidation.releaseBlocking), evidence: item.evidenceRequired || [],
    })),
    ...failures.filter((failure) => failure.category === "external_blocker").map((failure) => ({
      id: failure.id, kind: "external_failure", reason: failure.rootCause, decisionRef: null, releaseBlocking: failure.releaseBlocking, evidence: failure.evidence,
    })),
    ...scenarios.filter((scenario) => scenario.status === "blocked").map((scenario) => ({
      id: scenario.id, kind: "scenario", reason: `required tests cannot run: ${scenario.blockedTests.join(", ")}`, decisionRef: null,
      releaseBlocking: scenario.releaseBlocking, evidence: [],
    })),
  ];

  const allAttachments = tests.flatMap((test) => test.attachments);
  const screenshots = allAttachments.filter((attachment) => String(attachment.contentType || "").startsWith("image/"));
  const networkViolations = collectNetworkViolations(tests, networkViolationFiles);

  const testCounts = countTests(tests);
  const scenarioCounts = { pass: 0, fail: 0, partial: 0, blocked: 0, missing: 0 };
  for (const scenario of scenarios) scenarioCounts[scenario.status] += 1;

  const verdictReasons = [];
  const blockingFailures = failures.filter((failure) => failure.releaseBlocking);
  if (blockingFailures.length) verdictReasons.push(`${blockingFailures.length} release-blocking failure(s)`);
  const blockingScenarios = scenarios.filter((scenario) => scenario.releaseBlocking && scenario.status !== "pass");
  if (blockingScenarios.length) verdictReasons.push(`release-blocking scenarios not passing: ${blockingScenarios.map((s) => `${s.id}=${s.status}`).join(", ")}`);
  if (networkViolations.length) verdictReasons.push(`${networkViolations.length} network violation(s)`);
  for (const [name, repo] of Object.entries(repos)) {
    const baseline = repo?.git?.baseline;
    if (!baseline) continue;
    if (baseline.headUnchanged === false) verdictReasons.push(`${name} HEAD moved from the baseline`);
    if (baseline.newRefs?.length) verdictReasons.push(`${name} has new refs: ${baseline.newRefs.join(", ")}`);
    if (repo.git.stash?.count) verdictReasons.push(`${name} has ${repo.git.stash.count} stash entr(ies)`);
  }

  const results = {
    schema: "vivasayi-test-results/v1",
    runId,
    generatedAt,
    generator: { script: "scripts/acceptance/report.js", rerunFailures: rerunTimes },
    inputs: { ...inputs, triage: { ...(inputs.triage || {}), unmatchedEntries: triaged.unmatched } },
    repos,
    environment,
    suites: suiteList,
    tests,
    scenarios,
    failures,
    blocked,
    flaky,
    idCollisions,
    unlabelledCount: tests.filter((test) => !test.labelled).length,
    networkViolations,
    screenshots,
    acceptanceItems,
    summary: {
      tests: { total: tests.length, ...testCounts },
      scenarios: scenarioCounts,
      failures: {
        total: failures.length,
        untriaged: failures.filter((failure) => failure.untriaged).length,
        codeDefects: failures.filter((failure) => ["code_defect", "test_defect"].includes(failure.category)).length,
        externalBlockers: failures.filter((failure) => failure.category === "external_blocker").length,
        environment: failures.filter((failure) => failure.category === "environment").length,
        releaseBlocking: blockingFailures.length,
      },
      verdict: verdictReasons.length ? "NOT READY" : "READY",
      verdictReasons,
    },
  };
  return stripInternal(results);
};

// --- Markdown ----------------------------------------------------------------------------------------------

const cell = (value, max = 300) => {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return "–";
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return truncate(text, max).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
};

const table = (headers, rows) => {
  if (!rows.length) return "_None._\n";
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map((value) => cell(value)).join(" | ")} |`)].join("\n") + "\n";
};

export const FAILURE_COLUMNS = ["ID", "Command", "Expected", "Actual", "Root cause", "Impact", "Severity", "File", "Function", "Fix", "Reproducible", "Release-blocking", "Signature", "Evidence"];

const failureRow = (failure) => [
  failure.untriaged ? `${failure.id} (UNTRIAGED)` : failure.id, failure.command, failure.expected, failure.actual, failure.rootCause, failure.impact,
  failure.severity, failure.file, failure.function, failure.fix, failure.reproducible, failure.releaseBlocking ? "yes" : "no", failure.signature, failure.evidence,
];

export const renderMarkdown = (results, { validation = { valid: true, errors: [] } } = {}) => {
  const lines = [];
  const push = (...items) => lines.push(...items);
  const { summary } = results;
  push(`# Acceptance test report ${results.runId}`, "");
  push(`Generated ${results.generatedAt} by \`scripts/acceptance/report.js\`. Schema \`${results.schema}\`: ${validation.valid ? "valid" : `**INVALID** (${validation.errors.length} error(s))`}.`);
  push("This is the automated test verdict only. The independent acceptance audit (plan Part F) decides release; missing evidence there is NOT VERIFIED, never PASS.", "");
  push(`**Automated verdict: ${summary.verdict}**`, "");
  for (const reason of summary.verdictReasons) push(`- ${reason}`);
  push("", `Tests: ${summary.tests.total} total, ${summary.tests.passed} passed, ${summary.tests.failed} failed, ${summary.tests.skipped} skipped, ${summary.tests.todo} todo, ${summary.tests.flaky} flaky. Unlabelled: ${results.unlabelledCount}.`);
  push(`Scenarios: ${Object.entries(summary.scenarios).map(([key, value]) => `${value} ${key}`).join(", ")}.`);
  push(`Failures: ${summary.failures.total} (${summary.failures.untriaged} untriaged, ${summary.failures.codeDefects} code/test defects, ${summary.failures.externalBlockers} external blockers, ${summary.failures.releaseBlocking} release-blocking).`, "");

  push("## Repositories", "");
  push(table(
    ["Repo", "Path", "Branch", "HEAD", "Baseline HEAD", "HEAD unchanged", "Dirty", "git diff HEAD sha256", "Untracked", "Untracked content sha256", "Stashes", "New refs"],
    Object.entries(results.repos).map(([name, repo]) => {
      const git = repo.git || {};
      return [name, repo.path, repo.branch, repo.commit, git.baseline?.expectedHead, git.baseline ? String(git.baseline.headUnchanged) : null,
        repo.dirty === null ? null : String(repo.dirty), git.diffHeadSha256, git.untracked ? String(git.untracked.length) : null, git.untrackedContentSha256,
        git.stash ? String(git.stash.count) : null, git.baseline ? (git.baseline.newRefs.length ? git.baseline.newRefs : "none") : null];
    }),
  ));

  const env = results.environment || {};
  push("## Environment", "");
  push(`- node ${env.node ?? "?"}, npm ${env.npm ?? "?"}, ${env.platform ?? "?"} (${env.os ?? "?"}), TZ ${env.timeZone ?? "?"}`);
  push(`- mongod: ${env.mongod?.version ?? "not found"}${env.mongod?.path ? ` (${env.mongod.path})` : ""}${env.mongod?.note ? `; ${env.mongod.note}` : ""}`);
  push(`- vitest: backend ${env.vitest?.backend ?? "–"}, frontend ${env.vitest?.frontend ?? "–"}; Playwright: ${env.playwright?.version ?? "not installed"}; browsers: ${(env.playwright?.browsers || []).join(", ") || "none"}`, "");

  push("## Suites", "");
  push(table(["Suite", "Command", "Status", "Exit", "Duration (s)", "Passed", "Failed", "Skipped", "Todo", "Raw report / reason"],
    results.suites.map((suite) => [suite.name, suite.command, suite.status, suite.exitCode === null ? null : String(suite.exitCode),
      suite.durationMs === null ? null : (suite.durationMs / 1000).toFixed(1), String(suite.counts.passed), String(suite.counts.failed),
      String(suite.counts.skipped), String(suite.counts.todo), suite.rawReport || suite.reason])));
  for (const suite of results.suites.filter((item) => ["failed", "error"].includes(item.status) && item.stderrTail)) {
    push(`<details><summary>${suite.name}: stderr tail</summary>`, "", "```", suite.stderrTail.slice(-4000), "```", "", "</details>", "");
  }

  push("## Scenarios (S01–S24)", "");
  push(table(["ID", "Scenario", "Status", "Severity", "Release-blocking", "Required", "Passed", "Failed", "Missing", "Blocked", "Incomplete", "Mocks"],
    results.scenarios.map((scenario) => [scenario.id, scenario.name, scenario.status.toUpperCase(), scenario.severity, scenario.releaseBlocking ? "yes" : "no",
      String(scenario.requiredTests.length), String(scenario.passedTests.length), scenario.failedTests, scenario.missingTests, scenario.blockedTests,
      scenario.incompleteTests, scenario.mocks])));

  const codeFailures = results.failures.filter((failure) => !["external_blocker", "environment"].includes(failure.category));
  const externalFailures = results.failures.filter((failure) => ["external_blocker", "environment"].includes(failure.category));
  push("## Failures: code and test defects (including untriaged)", "");
  push(table(FAILURE_COLUMNS, codeFailures.map(failureRow)));
  push("## External blockers (quota, credentials, owner action, environment)", "");
  push(table(FAILURE_COLUMNS, externalFailures.map(failureRow)));

  push("## Blocked", "");
  push(table(["ID", "Kind", "Reason", "Decision", "Release-blocking"],
    results.blocked.map((item) => [item.id, item.kind, item.reason, item.decisionRef, item.releaseBlocking ? "yes" : "no"])));

  push("## Flaky", "");
  push(table(["ID", "Source", "Detail"], results.flaky.map((item) => [item.id, item.source, item.detail])));

  push("## ID collisions", "");
  push(table(["ID", "Known", "Occurrences"], results.idCollisions.map((collision) => [collision.id, collision.known ? "yes" : "no",
    collision.occurrences.map((occurrence) => `${occurrence.suite}:${occurrence.file}`)])));

  push("## Missing tests", "");
  push(table(["Scenario", "Missing test"], results.scenarios.flatMap((scenario) => scenario.missingTests.map((test) => [scenario.id, test]))));

  push(`## Unlabelled tests: ${results.unlabelledCount}`, "");
  const unlabelled = results.tests.filter((test) => !test.labelled);
  if (unlabelled.length) {
    push(`Tests without an \`<ID>:\` title prefix are reported as \`UNLABELLED::<file>::<full name>\`. First ${Math.min(unlabelled.length, 50)}:`, "");
    for (const test of unlabelled.slice(0, 50)) push(`- \`${test.id.replace(/`/g, "'")}\``);
    push("");
  }

  push("## Screenshot index", "");
  push(table(["Test", "Project", "Name", "Path"], (results.screenshots || []).map((shot) => [shot.testId, shot.project, shot.name, shot.path])));

  push("## Network violations", "");
  push(table(["Source", "Test", "Detail"], results.networkViolations.map((item) => [item.source, item.testId, item.detail])));

  push("## Acceptance items", "");
  push(table(["ID", "Item", "Decision", "Test status", "Live validation", "Release-blocking", "Missing", "Failed"],
    (results.acceptanceItems || []).map((item) => [item.id, item.title, item.decisionRef, item.testStatus, item.liveValidation, item.releaseBlocking ? "yes" : "no", item.missingTests, item.failedTests])));

  if (!validation.valid) {
    push("## Schema validation errors", "");
    for (const error of validation.errors.slice(0, 100)) push(`- ${error}`);
    push("");
  }
  push("## Inputs", "", "```json", JSON.stringify(results.inputs, null, 2), "```", "");
  return lines.join("\n");
};

// --- CLI ---------------------------------------------------------------------------------------------------

const parseArgs = (argv) => Object.fromEntries(argv.map((arg) => /^--([^=]+)(?:=(.*))?$/.exec(arg)).filter(Boolean).map((match) => [match[1], match[2] ?? true]));

const readJsonIfExists = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const fileSha = (path) => (path && existsSync(path) ? sha256(readFileSync(path)) : null);

export const main = (argv = process.argv.slice(2)) => {
  const args = parseArgs(argv);
  const root = BACKEND_ROOT;
  const frontendRoot = resolveFrontendRoot();
  const rawDir = resolve(root, args["raw-dir"] || "test-results/raw");
  const outDir = resolve(root, args["out-dir"] || "test-results/acceptance");
  const manifestPath = resolve(root, args.manifest || join(rawDir, "run-manifest.json"));
  const matrixPath = resolve(root, args.matrix || "scripts/acceptance/matrix.json");
  const itemsPath = resolve(root, args.items || "scripts/acceptance/acceptanceItems.json");
  const triagePath = resolve(root, args.triage || "test-results/acceptance/triage.json");
  const schemaPath = join(root, "scripts", "acceptance", "results.schema.json");
  const rerunTimes = Math.max(0, Number.parseInt(args["rerun-failures"] ?? "0", 10) || 0);

  const manifest = readJsonIfExists(manifestPath);
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  const itemsDoc = readJsonIfExists(itemsPath);
  const triage = readJsonIfExists(triagePath);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  const sources = [
    { suite: "backend-vitest", repo: "backend", repoRoot: root, path: resolve(root, args["backend-json"] || join(rawDir, "backend-vitest.json")), parse: parseVitestReport },
    { suite: "frontend-vitest", repo: "frontend", repoRoot: frontendRoot, path: resolve(root, args["frontend-json"] || join(rawDir, "frontend-vitest.json")), parse: parseVitestReport },
    { suite: "e2e-playwright", repo: "frontend", repoRoot: frontendRoot, path: resolve(root, args["playwright-json"] || join(rawDir, "e2e-playwright.json")), parse: parsePlaywrightReport },
  ];

  const manifestSuites = new Map((manifest?.suites || []).map((suite) => [suite.name, suite]));
  const parsed = [];
  const reportSuites = [];
  for (const source of sources) {
    const recorded = manifestSuites.get(source.suite);
    const present = existsSync(source.path);
    const rawReport = relativeToRoot(root, source.path);
    // A raw report counts only when this run produced it: a suite the manifest records as not run,
    // not available or N/A may have a stale file from an earlier run, which is ignored.
    const ranThisRun = !recorded || ["passed", "failed", "error"].includes(recorded.status);
    if (present && ranThisRun) {
      const json = JSON.parse(readFileSync(source.path, "utf8"));
      const result = source.parse(json, { suite: source.suite, repo: source.repo, repoRoot: source.repoRoot, matrix, rawReport });
      parsed.push(result);
      const failed = result.tests.some((test) => test.status === "failed") || result.fileErrors.length > 0 || result.globalErrors.length > 0;
      reportSuites.push(recorded ? { ...recorded, rawReport } : {
        name: source.suite, kind: "tests", repo: source.repo, command: null, cwd: source.repoRoot, status: failed ? "failed" : "passed",
        exitCode: null, durationMs: null, rawReport, reason: "parsed from the raw report; no run manifest", counts: { passed: 0, failed: 0, skipped: 0, todo: 0 },
      });
    } else {
      reportSuites.push(recorded ? { ...recorded, status: ranThisRun ? "error" : recorded.status, reason: recorded.reason || `${rawReport} was not written` } : {
        name: source.suite, kind: "tests", repo: source.repo, command: null, cwd: source.repoRoot, status: "not_run",
        exitCode: null, durationMs: null, rawReport: null, reason: `no raw report at ${rawReport} and no run manifest`, counts: { passed: 0, failed: 0, skipped: 0, todo: 0 },
      });
    }
  }
  const otherSuites = (manifest?.suites || []).filter((suite) => !REPORT_SUITES.has(suite.name));
  const order = (manifest?.suites || []).map((suite) => suite.name);
  const suites = [...reportSuites, ...otherSuites].sort((a, b) => {
    const ai = order.indexOf(a.name);
    const bi = order.indexOf(b.name);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  let repos = manifest?.repos;
  if (!repos) {
    const baseline = itemsDoc?.gitBaseline || {};
    const noGit = Boolean(args["no-git"]);
    repos = {
      backend: repoSummary(root, noGit ? null : collectGitState(root, baseline.backend)),
      frontend: repoSummary(frontendRoot, noGit ? null : collectGitState(frontendRoot, baseline.frontend)),
    };
  }
  const environment = manifest?.environment || collectEnvironment({ backendRoot: root, frontendRoot });
  const runId = args["run-id"] || manifest?.runId || makeRunId(new Date(), repos.backend?.commit?.slice(0, 7));

  const results = buildResults({
    runId,
    generatedAt: new Date().toISOString(),
    matrix,
    itemsDoc,
    suites,
    parsed,
    repos,
    environment,
    triage,
    rerunTimes,
    runner: rerunTimes > 0 ? makeProcessRunner({ backendRoot: root, matrix }) : null,
    networkViolationFiles: [join(rawDir, "network-violations.json")],
    inputs: {
      manifest: { path: relativeToRoot(root, manifestPath), present: Boolean(manifest) },
      matrix: { path: relativeToRoot(root, matrixPath), sha256: fileSha(matrixPath) },
      acceptanceItems: { path: relativeToRoot(root, itemsPath), sha256: fileSha(itemsPath) },
      triage: { path: relativeToRoot(root, triagePath), present: Boolean(triage), sha256: fileSha(triagePath) },
      rawReports: sources.map((source) => ({ suite: source.suite, path: relativeToRoot(root, source.path), present: existsSync(source.path), sha256: fileSha(source.path) })),
    },
  });

  const validation = validateAgainstSchema(schema, results);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, validation.valid ? `results-${runId}.json` : `results-${runId}.invalid.json`);
  const mdPath = join(outDir, `REPORT-${runId}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(results, { validation }));
  const untriaged = results.failures.filter((failure) => failure.untriaged);
  if (untriaged.length) {
    const todoPath = join(outDir, `triage.todo-${runId}.json`);
    writeFileSync(todoPath, `${JSON.stringify({ schema: "vivasayi-acceptance-triage/v1", entries: untriaged.map((failure) => ({
      id: failure.id, signature: failure.signature, firstLine: failure.firstLine, category: "", rootCause: "", impact: "", fix: "",
    })) }, null, 2)}\n`);
  }

  console.log(`[acceptance:report] ${relativeToRoot(root, jsonPath)}`);
  console.log(`[acceptance:report] ${relativeToRoot(root, mdPath)}`);
  console.log(`[acceptance:report] verdict ${results.summary.verdict}; tests ${results.summary.tests.passed}/${results.summary.tests.total} passed; scenarios ${JSON.stringify(results.summary.scenarios)}; failures ${results.summary.failures.total} (${results.summary.failures.untriaged} untriaged)`);
  if (!validation.valid) {
    console.error(`[acceptance:report] results failed schema validation:\n${validation.errors.slice(0, 20).join("\n")}`);
    return 2;
  }
  return args.strict && results.summary.verdict !== "READY" ? 1 : 0;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main();
