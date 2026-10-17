import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildResults, detectCollisions, extractExpectedActual, extractId, failureSignature, locateFailure, parsePlaywrightReport,
  parseVitestReport, renderMarkdown, rerunCommand, rerunFailures, suiteForSelector, FAILURE_COLUMNS, UNTRIAGED,
} from "../scripts/acceptance/report.js";
import { validateAgainstSchema } from "../scripts/acceptance/schemaValidate.js";
import { checkFrozenHashes, makeRunId, repoSummary, sha256 } from "../scripts/acceptance/collect.js";
import { buildSteps, childEnv, runStep } from "../scripts/acceptance/runAll.js";

// The acceptance report is the evidence the final audit reads, so its parsing, scenario logic and schema are
// tested on fixed fixture reports (tests/fixtures/acceptance/). Nothing here spawns a test run or calls a provider.

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/acceptance/${name}`, import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../scripts/acceptance/results.schema.json", import.meta.url), "utf8"));
const shippedMatrix = JSON.parse(readFileSync(new URL("../scripts/acceptance/matrix.json", import.meta.url), "utf8"));
const shippedItems = JSON.parse(readFileSync(new URL("../scripts/acceptance/acceptanceItems.json", import.meta.url), "utf8"));

const BE = "/repo/backend";
const FE = "/repo/frontend";
const matrix = fixture("matrix.mini.json");
const itemsDoc = fixture("acceptanceItems.mini.json");

const parseAll = () => [
  parseVitestReport(fixture("backend-vitest.json"), { suite: "backend-vitest", repo: "backend", repoRoot: BE, matrix, rawReport: "test-results/raw/backend-vitest.json" }),
  parseVitestReport(fixture("frontend-vitest.json"), { suite: "frontend-vitest", repo: "frontend", repoRoot: FE, matrix, rawReport: "test-results/raw/frontend-vitest.json" }),
  parsePlaywrightReport(fixture("e2e-playwright.json"), { suite: "e2e-playwright", repo: "frontend", repoRoot: FE, matrix, rawReport: "test-results/raw/e2e-playwright.json" }),
];

const suite = (name, status, extra = {}) => ({
  name, kind: "tests", command: `run ${name}`, status, exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
  durationMs: status === "not_available" ? null : 1000, rawReport: status === "not_available" ? null : `test-results/raw/${name}.json`,
  counts: { passed: 0, failed: 0, skipped: 0, todo: 0 }, reason: status === "not_available" ? "@playwright/test is not installed in the frontend yet" : null, ...extra,
});

const FULL_SUITES = [suite("backend-vitest", "failed"), suite("frontend-vitest", "passed"), suite("e2e-playwright", "failed")];
const NO_PLAYWRIGHT_SUITES = [suite("backend-vitest", "failed"), suite("frontend-vitest", "passed"), suite("e2e-playwright", "not_available")];

const build = (overrides = {}) => {
  const parsed = overrides.parsed ?? parseAll();
  return buildResults({
    runId: "20261016T120000Z-6dbe6b8",
    generatedAt: "2026-10-16T12:00:00.000Z",
    matrix,
    itemsDoc,
    suites: FULL_SUITES,
    parsed,
    repos: { backend: repoSummary(BE, null), frontend: repoSummary(FE, null) },
    environment: { node: "v26.7.0" },
    ...overrides,
  });
};

const byId = (list, id) => list.find((item) => item.id === id);

describe("acceptance report generator", () => {
  it("AR-1: parses vitest and Playwright JSON into tests with status, level, file, project suffix and attachments", () => {
    const [backend, frontend, playwright] = parseAll();

    expect(backend.tests).toHaveLength(16);
    expect(backend.tests.filter((test) => test.status === "passed")).toHaveLength(12);
    expect(byId(backend.tests, "VJ-14")).toMatchObject({ file: "tests/verificationJobs.test.js", suite: "backend-vitest", repo: "backend", status: "failed", level: "I/API", durationMs: 40.25 });
    expect(byId(backend.tests, "EQ-9").status).toBe("todo");
    expect(byId(backend.tests, "PRG-7").status).toBe("skipped");
    expect(byId(backend.tests, "VC-26").level).toBe("U");
    expect(backend.fileErrors).toEqual([expect.objectContaining({ file: "tests/broken.test.js", suite: "backend-vitest" })]);

    expect(frontend.tests).toHaveLength(6);
    expect(byId(frontend.tests, "TRK-6")).toMatchObject({ file: "src/components/claims/ClaimTracker.test.tsx", level: "FE-U", repo: "frontend", status: "passed" });

    expect(playwright.tests.map((test) => test.id)).toEqual([
      "E2E-01@desktop-chromium", "E2E-01@mobile-chromium", "E2E-02@desktop-chromium", "E2E-02@mobile-chromium",
      "E2E-24@desktop-chromium", "UNLABELLED::e2e/network.spec.ts::loads the app shell@desktop-chromium",
    ]);
    const mobileFailure = byId(playwright.tests, "E2E-02@mobile-chromium");
    expect(mobileFailure).toMatchObject({ baseId: "E2E-02", project: "mobile-chromium", file: "e2e/claim-submit-auto.spec.ts", level: "E2E", status: "failed", durationMs: 31000 });
    expect(mobileFailure.attachments.map((attachment) => attachment.path)).toEqual([
      "test-results/e2e/claim-submit-auto-E2E-02-mobile-chromium/test-failed-1.png",
      "test-results/e2e/claim-submit-auto-E2E-02-mobile-chromium/trace.zip",
    ]);
    const flaky = byId(playwright.tests, "E2E-24@desktop-chromium");
    expect(flaky.status).toBe("flaky");
    expect(flaky.fullName).toBe("no fake progress E2E-24: every DOM status equals the latest /progress response");
    expect(playwright.globalErrors).toEqual([]);
  });

  it("AR-2: extracts IDs with the registry regex, unlabelled keys, expected/actual, file/function, rerun command and a stable signature", () => {
    for (const [title, id] of [
      ["VJ-2: x", "VJ-2"], ["P6-22b: x", "P6-22b"], ["AI-503-A1: x", "AI-503-A1"], ["I18N-P1: x", "I18N-P1"], ["E2E-08a: x", "E2E-08a"],
      ["OW-U01: x", "OW-U01"], ["PRG-10: x", "PRG-10"], ["MGA-4: x", "MGA-4"], ["LD-15: x", "LD-15"],
      ["VJ-2 without a colon", null], ["vj-2: lower case", null], ["renders the page", null], ["E9-S9 — claimSpatial", null], [" VJ-2: leading space", null],
    ]) expect(extractId(title)).toBe(id);

    const [backend, , playwright] = parseAll();
    expect(backend.tests.filter((test) => !test.labelled).map((test) => test.id)).toEqual([
      "UNLABELLED::tests/geometry.unit.test.js::computeOverlapAcres returns positive acres for overlapping polygons",
      "UNLABELLED::tests/geometry.unit.test.js::computeOverlapAcres VJ-2 mentioned without a colon is not an ID",
    ]);

    const vj14 = byId(backend.tests, "VJ-14");
    const message = vj14._failureMessages[0];
    expect(extractExpectedActual(message)).toEqual({ expected: "'lease_lost'", actual: "'succeeded'" });
    expect(locateFailure(message, BE)).toEqual({ file: "services/verificationJobs.service.js:212:9", function: "finishJob" });
    expect(rerunCommand(vj14)).toBe('npx vitest run tests/verificationJobs.test.js -t "VJ-14:"');

    const eq4 = byId(backend.tests, "EQ-4");
    expect(extractExpectedActual(eq4._failureMessages[0])).toEqual({ expected: "200", actual: "503" });
    expect(locateFailure(eq4._failureMessages[0], BE)).toEqual({ file: "tests/verificationEnqueue.test.js:88:31", function: "<anonymous>" });

    const pw = byId(playwright.tests, "E2E-02@mobile-chromium");
    expect(extractExpectedActual(pw._failureMessages[0])).toEqual({ expected: "0", actual: "1" });
    expect(locateFailure(pw._failureMessages[0], FE, { location: pw._location })).toEqual({ file: "e2e/claim-submit-auto.spec.ts:44:7", function: "<anonymous>" });
    expect(rerunCommand(pw)).toBe('npx playwright test e2e/claim-submit-auto.spec.ts --project=mobile-chromium -g "E2E-02:"');
    expect(rerunCommand({ suite: "backend-vitest", file: "tests/a.test.js", baseId: null, title: 'quotes "and" $vars (x)' }))
      .toBe(String.raw`npx vitest run tests/a.test.js -t "quotes \"and\" \\\$vars \\(x\\)"`);

    expect(extractExpectedActual("TypeError: boom")).toEqual({ expected: "(not extracted; see the failure message)", actual: "TypeError: boom" });
    // One defect keeps one signature even when ids and timestamps in the message change between runs.
    expect(failureSignature("Error: claim 64f1a2b3c4d5e6f708192a3b failed at 2026-10-16T10:00:00.000Z\n at x"))
      .toBe(failureSignature("Error: claim 650000000000000000000000 failed at 2026-10-17T11:22:33Z\n at y"));
    expect(failureSignature("Error: one")).not.toBe(failureSignature("Error: two"));
    expect(failureSignature(message)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("AR-3: detects ID collisions across files and suites, not across Playwright projects, and namespaces them by file", () => {
    const tests = parseAll().flatMap((entry) => entry.tests);
    const collisions = detectCollisions(tests, matrix);
    expect(collisions.map((collision) => collision.id)).toEqual(["CR-1", "DC-1"]);
    expect(byId(collisions, "CR-1").known).toBe(true);
    expect(byId(collisions, "DC-1")).toMatchObject({
      known: false,
      occurrences: [
        { suite: "backend-vitest", file: "tests/decisionConsistency.test.js", titles: ["DC-1: happy path through the worker equals the pure engine"] },
        { suite: "frontend-vitest", file: "src/utils/claimFlow.test.ts", titles: ["DC-1: an ID that collides with a backend test"] },
      ],
    });
    expect(tests.filter((test) => test.baseId === "DC-1").map((test) => test.id)).toEqual(["DC-1::tests/decisionConsistency.test.js", "DC-1::src/utils/claimFlow.test.ts"]);
    expect(tests.filter((test) => test.baseId === "E2E-01").map((test) => test.id)).toEqual(["E2E-01@desktop-chromium", "E2E-01@mobile-chromium"]);

    const results = build();
    expect(results.idCollisions.map((collision) => collision.id)).toEqual(["CR-1", "DC-1"]);
    expect(results.unlabelledCount).toBe(4);
  });

  it("AR-4: scenario status is pass/fail/partial/missing, and a mapped test that is absent from a suite that ran makes the scenario missing", () => {
    const results = build();
    const status = Object.fromEntries(results.scenarios.map((scenario) => [scenario.id, scenario.status]));
    expect(status).toEqual({ S01: "pass", S02: "fail", S03: "missing", S04: "partial", S05: "missing", S06: "pass", S07: "missing", S08: "fail", S09: "partial" });
    expect(byId(results.scenarios, "S03")).toMatchObject({ missingTests: ["EQ-2"], passedTests: ["EQ-1"], releaseBlocking: true, severity: "S1" });
    expect(byId(results.scenarios, "S05").missingTests).toEqual(["E2E-25"]);
    expect(byId(results.scenarios, "S07").missingTests).toEqual(["SD-*"]);
    expect(byId(results.scenarios, "S06").requiredTests).toEqual(["PRG-1", "PRG-2", "VC-*", "file:backend/tests/claims.api.test.js ~/p6-22b/i"]);
    expect(byId(results.scenarios, "S08").failedTests).toEqual(["E2E-02"]);
    expect(byId(results.tests, "VJ-2").scenarios).toEqual(["S01"]);
    expect(byId(results.tests, "E2E-01@mobile-chromium").scenarios).toEqual(["S01"]);
    expect(results.summary.scenarios).toEqual({ pass: 2, fail: 2, partial: 2, blocked: 0, missing: 3 });

    // Failures take severity and release-blocking from the scenarios that map them, or the unmapped default.
    expect(results.failures.map((failure) => failure.id)).toEqual(["VJ-14", "EQ-4", "E2E-02@mobile-chromium", "FILE::tests/broken.test.js"]);
    expect(byId(results.failures, "EQ-4")).toMatchObject({ severity: "S1", releaseBlocking: true, severitySource: "matrix:S02", scenarios: ["S02"] });
    expect(byId(results.failures, "VJ-14")).toMatchObject({ severity: "S2", releaseBlocking: true, severitySource: "matrix:defaults.unmappedFailure" });
    expect(byId(results.failures, "E2E-02@mobile-chromium")).toMatchObject({
      severity: "S3", command: 'npx playwright test e2e/claim-submit-auto.spec.ts --project=mobile-chromium -g "E2E-02:"', reproducible: "not rerun",
      evidence: expect.arrayContaining(["screenshot: test-results/e2e/claim-submit-auto-E2E-02-mobile-chromium/test-failed-1.png"]),
    });
    expect(results.summary.verdict).toBe("NOT READY");
  });

  it("AR-5: a blocked live item, a suite that is not available and the scenarios that depend on it are reported as blocked, never as pass", () => {
    const [backend, frontend] = parseAll();
    const results = build({ suites: NO_PLAYWRIGHT_SUITES, parsed: [backend, frontend] });
    const status = Object.fromEntries(results.scenarios.map((scenario) => [scenario.id, scenario.status]));
    expect(status).toMatchObject({ S01: "blocked", S05: "blocked", S08: "blocked", S09: "blocked", S02: "fail", S03: "missing" });
    expect(byId(results.scenarios, "S01").blockedTests).toEqual(["E2E-01"]);

    expect(byId(results.blocked, "ACC-01")).toMatchObject({ kind: "live_item", decisionRef: "D6", releaseBlocking: false });
    expect(byId(results.blocked, "ACC-01").reason).toMatch(/^BLOCKED \(D6\): /);
    // Not deployed by owner decision (D7): listed as blocked, but the live status alone does not block release.
    expect(byId(results.blocked, "ACC-04")).toMatchObject({ kind: "live_item", releaseBlocking: false, reason: expect.stringMatching(/^Not deployed: /) });
    expect(byId(results.blocked, "ACC-02")).toBeUndefined();
    expect(byId(results.blocked, "SUITE::e2e-playwright")).toMatchObject({ kind: "suite", releaseBlocking: true });
    expect(byId(results.blocked, "S01")).toMatchObject({ kind: "scenario", releaseBlocking: true });

    expect(Object.fromEntries(results.acceptanceItems.map((item) => [item.id, item.testStatus]))).toEqual({ "ACC-01": "no_tests", "ACC-02": "fail", "ACC-03": "blocked", "ACC-04": "missing" });
    expect(byId(results.acceptanceItems, "ACC-01").liveValidation).toBe("BLOCKED (D6)");
    expect(results.suites.find((item) => item.name === "e2e-playwright")).toMatchObject({ status: "not_available", counts: { passed: 0, failed: 0 } });
    expect(results.summary.verdict).toBe("NOT READY");
  });

  it("AR-6: the results document validates against results.schema.json, and broken documents do not", () => {
    const results = build();
    expect(validateAgainstSchema(schema, results)).toEqual({ valid: true, errors: [] });
    expect(validateAgainstSchema(schema, build({ suites: NO_PLAYWRIGHT_SUITES, parsed: parseAll().slice(0, 2) })).valid).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/"_[a-zA-Z]+":/);

    const broken = structuredClone(results);
    delete broken.runId;
    broken.scenarios[0].status = "green";
    broken.failures[0].signature = "not-a-sha";
    broken.failures[1].reproducible = "maybe";
    delete broken.failures[2].rootCause;
    broken.tests[0].level = "X";
    broken.unexpected = true;
    const { valid, errors } = validateAgainstSchema(schema, broken);
    expect(valid).toBe(false);
    expect(errors).toEqual(expect.arrayContaining([
      '$: missing required property "runId"',
      '$: unexpected property "unexpected"',
      expect.stringMatching(/^\$\.scenarios\[0\]\.status: "green" is not one of/),
      expect.stringMatching(/^\$\.failures\[0\]\.signature: does not match/),
      expect.stringMatching(/^\$\.failures\[1\]\.reproducible: does not match/),
      '$.failures[2]: missing required property "rootCause"',
      expect.stringMatching(/^\$\.tests\[0\]\.level: "X" is not one of/),
    ]));
    // The validator refuses keywords it does not implement instead of silently ignoring them.
    expect(() => validateAgainstSchema({ type: "string", maxLength: 3 }, "abcd")).toThrow(/unsupported keyword "maxLength"/);
  });

  it("AR-7: triage merges by id + signature, keeps unmatched failures UNTRIAGED, and separates external blockers from code defects", () => {
    const first = build();
    const sig = (id) => byId(first.failures, id).signature;
    const triage = {
      entries: [
        { id: "EQ-4", signature: sig("EQ-4"), category: "code_defect", rootCause: "ensurePlan error is swallowed", impact: "claim stuck", fix: "await ensurePlan", severity: "S2" },
        { id: "VJ-14", signature: sig("VJ-14"), category: "external_blocker", rootCause: "Gemini quota exhausted", impact: "cannot run live", fix: "billed key (D6)", releaseBlocking: false },
        { id: "E2E-02@mobile-chromium", signature: "0".repeat(40), category: "code_defect", rootCause: "old signature", impact: "x", fix: "y" },
        { id: "FILE::tests/broken.test.js", signature: sig("FILE::tests/broken.test.js"), category: "code_defect", rootCause: "missing import" },
      ],
    };
    const results = build({ triage });
    expect(byId(results.failures, "EQ-4")).toMatchObject({ rootCause: "ensurePlan error is swallowed", impact: "claim stuck", fix: "await ensurePlan", category: "code_defect", untriaged: false, severity: "S2", severitySource: "triage", releaseBlocking: true });
    expect(byId(results.failures, "VJ-14")).toMatchObject({ category: "external_blocker", untriaged: false, releaseBlocking: false });
    expect(byId(results.failures, "E2E-02@mobile-chromium")).toMatchObject({ rootCause: UNTRIAGED, impact: UNTRIAGED, fix: UNTRIAGED, category: "untriaged", untriaged: true });
    expect(byId(results.failures, "FILE::tests/broken.test.js")).toMatchObject({ rootCause: "missing import", impact: UNTRIAGED, fix: UNTRIAGED, untriaged: true });
    expect(results.inputs.triage.unmatchedEntries).toEqual([`E2E-02@mobile-chromium|${"0".repeat(40)}`]);
    expect(byId(results.blocked, "VJ-14")).toMatchObject({ kind: "external_failure", reason: "Gemini quota exhausted", releaseBlocking: false });
    expect(results.summary.failures).toMatchObject({ total: 4, untriaged: 2, codeDefects: 1, externalBlockers: 1, releaseBlocking: 3 });

    const markdown = renderMarkdown(results);
    const external = markdown.slice(markdown.indexOf("## External blockers"), markdown.indexOf("## Blocked"));
    const code = markdown.slice(markdown.indexOf("## Failures: code"), markdown.indexOf("## External blockers"));
    expect(external).toContain("| VJ-14 |");
    expect(code).not.toContain("| VJ-14 |");
    expect(code).toContain("| E2E-02@mobile-chromium (UNTRIAGED) |");
    expect(validateAgainstSchema(schema, results).valid).toBe(true);
  });

  it("AR-8: --rerun-failures labels each failure yes/flaky/no/inconclusive and lists non-reproducing failures as flaky", () => {
    const plan = { "VJ-14": ["failed", "failed", "failed"], "EQ-4": ["failed", "passed", "passed"], "E2E-02@mobile-chromium": ["passed", "passed", "passed"], "FILE::tests/broken.test.js": ["not_found", "failed", "failed"] };
    const calls = [];
    const runner = (failure, attempt) => { calls.push(`${failure.id}#${attempt}`); return plan[failure.id][attempt - 1]; };
    const results = build({ rerunTimes: 3, runner });
    expect(Object.fromEntries(results.failures.map((failure) => [failure.id, failure.reproducible]))).toEqual({
      "VJ-14": "yes (3/3)", "EQ-4": "flaky (1/3)", "E2E-02@mobile-chromium": "no (0/3)", "FILE::tests/broken.test.js": "inconclusive (2/3 found)",
    });
    expect(calls).toHaveLength(12);
    expect(results.flaky).toEqual([
      { id: "E2E-24@desktop-chromium", source: "playwright_retry", detail: "failed, then passed on a Playwright retry" },
      { id: "EQ-4", source: "rerun", detail: "reproducible: flaky (1/3)" },
      { id: "E2E-02@mobile-chromium", source: "rerun", detail: "reproducible: no (0/3)" },
    ]);
    expect(rerunFailures([{ id: "X", reproducible: "not rerun" }], 2, () => "failed")[0].reproducible).toBe("yes (2/2)");
    expect(validateAgainstSchema(schema, results).valid).toBe(true);
  });

  it("AR-9: the Markdown report carries every required section and failure column, and the shipped matrix and items are consistent", () => {
    const results = build();
    const markdown = renderMarkdown(results, { validation: validateAgainstSchema(schema, results) });
    expect(FAILURE_COLUMNS).toEqual(["ID", "Command", "Expected", "Actual", "Root cause", "Impact", "Severity", "File", "Function", "Fix", "Reproducible", "Release-blocking", "Signature", "Evidence"]);
    expect(markdown).toContain(`| ${FAILURE_COLUMNS.join(" | ")} |`);
    for (const heading of ["## Repositories", "## Environment", "## Suites", "## Scenarios (S01–S24)", "## Failures: code and test defects", "## External blockers", "## Blocked", "## Flaky", "## ID collisions", "## Missing tests", "## Unlabelled tests: 4", "## Screenshot index", "## Network violations", "## Acceptance items"]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("**Automated verdict: NOT READY**");
    expect(markdown).toContain("| S03 | A required test is absent | MISSING |");
    expect(markdown).toContain("test-results/e2e/claim-submit-auto-E2E-01-desktop-chromium/test-finished-1.png");
    expect(results.networkViolations).toEqual([{ source: "playwright:UNLABELLED::e2e/network.spec.ts::loads the app shell@desktop-chromium", testId: "UNLABELLED::e2e/network.spec.ts::loads the app shell@desktop-chromium", detail: "GET https://nominatim.openstreetmap.org/reverse?lat=10.79" }]);
    expect(results.screenshots).toHaveLength(3);

    // The shipped registry: S01-S24 in order, valid selectors, the X1 renames applied, and FE/E2E IDs routed to their suites.
    expect(shippedMatrix.scenarios.map((scenario) => scenario.id)).toEqual(Array.from({ length: 24 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`));
    const selectors = shippedMatrix.scenarios.flatMap((scenario) => Object.entries(scenario.tests).flatMap(([column, list]) => list.map((selector) => ({ column, selector }))));
    for (const scenario of shippedMatrix.scenarios) {
      expect(["S1", "S2", "S3", "S4"]).toContain(scenario.severity);
      expect(typeof scenario.releaseBlocking).toBe("boolean");
      expect(Object.keys(scenario.tests).every((column) => ["U", "I/API", "FE-U", "E2E"].includes(column))).toBe(true);
    }
    const strings = selectors.map(({ selector }) => selector).filter((selector) => typeof selector === "string");
    for (const selector of strings) expect(selector).toMatch(/^(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+[a-z]?|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\*)$/);
    expect(strings.filter((selector) => /^(PG|MG|TR|PL)-/.test(selector))).toEqual([]);
    expect(strings).toContain("LD-15");
    expect(strings).toContain("PRG-10");
    const e2e = [...new Set(strings.filter((selector) => selector.startsWith("E2E-")))].sort();
    expect(e2e).toEqual(["01", "02", "03", "05", "06", "07", "08a", "08b", "09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19a", "19b", "20", "21", "22", "23", "24", "25"].map((n) => `E2E-${n}`));
    for (const { column, selector } of selectors) {
      const target = suiteForSelector(shippedMatrix, selector, column);
      if (typeof selector === "string" && /^(E2E)-/.test(selector)) expect(target).toBe("e2e-playwright");
      else if (typeof selector === "string" && /^(TRK|POLL|RT|I18N|DRF|WZ|SUB|UI|LOC|CT)-/.test(selector)) expect(target).toBe("frontend-vitest");
      else if (column === "FE-U") expect(target).toBe("frontend-vitest");
      else expect(target).toBe("backend-vitest");
    }
    const ids = shippedItems.items.map((item) => item.id);
    expect(ids).toEqual(ids.map((_, i) => `ACC-${String(i + 1).padStart(2, "0")}`));
    expect(shippedItems.items.filter((item) => item.scenario).map((item) => item.scenario)).toEqual(shippedMatrix.scenarios.map((scenario) => scenario.id));
    for (const item of shippedItems.items) expect(["N/A", "BLOCKED", "NOT_DEPLOYED", "OWNER_APPROVAL", "EXTERNAL"]).toContain(item.liveValidation.status);
    expect(shippedItems.gitBaseline.backend.head.startsWith("6dbe6b8")).toBe(true);
    expect(shippedItems.gitBaseline.frontend.head.startsWith("56f26eb")).toBe(true);
  });

  describe("runner helpers", () => {
    let dir;
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

    it("AR-10: runAll records missing tools as not_available, blanks credentials for children, and the frozen-hash check detects a change", async () => {
      dir = mkdtempSync(join(tmpdir(), "vivasayi-acceptance-"));
      const backendRoot = join(dir, "backend");
      const frontendRoot = join(dir, "frontend");
      mkdirSync(join(backendRoot, "docs"), { recursive: true });
      mkdirSync(frontendRoot, { recursive: true });
      writeFileSync(join(frontendRoot, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc", lint: "eslint ." } }));

      const steps = buildSteps({ backendRoot, frontendRoot });
      expect(steps.map((step) => step.name)).toEqual([
        "backend-vitest", "backend-lint", "backend-build", "backend-node-check", "frontend-typecheck", "frontend-lint", "frontend-build",
        "frontend-vitest", "e2e-playwright", "manuscript-numbers", "frozen-hashes",
      ]);
      const step = (name) => steps.find((item) => item.name === name);
      expect(step("frontend-typecheck").available()).toBeNull();
      expect(step("frontend-build").available()).toMatch(/no "build" script/);
      expect(step("e2e-playwright").available()).toMatch(/@playwright\/test is not installed/);
      expect(step("manuscript-numbers").available()).toMatch(/checkManuscriptNumbers\.js does not exist yet/);
      expect(step("e2e-playwright").argv.slice(1)).toEqual(["--no", "playwright", "test"]);

      // A tool that is not installed is never recorded as a pass, and nothing is spawned for it.
      expect(await runStep(step("e2e-playwright"), { backendRoot })).toMatchObject({ status: "not_available", exitCode: null });
      expect(await runStep(step("backend-lint"), { backendRoot })).toMatchObject({ status: "n/a", reason: expect.stringMatching(/no lint script/) });
      expect(await runStep(step("backend-vitest"), { backendRoot, selected: false })).toMatchObject({ status: "not_run" });

      const env = childEnv({ MONGO_URI: "mongodb+srv://example.invalid/db", MY_AWS_SECRET_ACCESS_KEY: "example", KEEP: "1" });
      expect(env).toMatchObject({ MONGO_URI: "", MY_AWS_SECRET_ACCESS_KEY: "", VIVASAYI_SKIP_DOTENV: "1", KEEP: "1" });

      expect(checkFrozenHashes(backendRoot, "docs/FROZEN_HASHES.json")).toMatchObject({ status: "not_available" });
      writeFileSync(join(backendRoot, "docs", "result.json"), '{"hit":3}\n');
      writeFileSync(join(backendRoot, "docs", "FROZEN_HASHES.json"), JSON.stringify({ files: { "docs/result.json": sha256('{"hit":3}\n') } }));
      expect(checkFrozenHashes(backendRoot, "docs/FROZEN_HASHES.json")).toMatchObject({ status: "passed", checked: 1, mismatched: [], missing: [] });
      writeFileSync(join(backendRoot, "docs", "result.json"), '{"hit":4}\n');
      expect(checkFrozenHashes(backendRoot, "docs/FROZEN_HASHES.json")).toMatchObject({ status: "failed", mismatched: [{ path: "docs/result.json" }] });
      writeFileSync(join(backendRoot, "docs", "FROZEN_HASHES.json"), JSON.stringify([{ path: "docs/gone.json", sha256: "a".repeat(64) }]));
      expect(checkFrozenHashes(backendRoot, "docs/FROZEN_HASHES.json")).toMatchObject({ status: "failed", missing: ["docs/gone.json"] });

      const runId = makeRunId(new Date("2026-10-16T10:15:30.123Z"), "6dbe6b8");
      expect(runId).toBe("20261016T101530Z-6dbe6b8");
      expect(runId).toMatch(new RegExp(schema.properties.runId.pattern));
    });
  });
});
