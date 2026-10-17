#!/usr/bin/env node
// Run scripts/e2e/scenarios.json against a RUNNING hermetic harness (ADR-024) through the API and the
// control server only, and report whether each settles where `expected` says. A pre-flight for the
// Playwright suite, and the way scenarios.json itself is checked.
//
//   npm run e2e:backend                          (in another terminal)
//   npm run e2e:scenarios -- [--out=test-results/e2e/harness.json] [--only=S01,S06b] [--json]
//
// Talks only to the loopback URLs in the harness out file. Exit 0 when every selected scenario passes.

import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { createScenarioClient, readHarnessOut } from "./lib/scenarioClient.js";
import { BACKEND_ROOT } from "./lib/hermeticEnv.js";

const arg = (name) => {
  const found = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

export const main = async () => {
  const outFile = path.resolve(process.cwd(), arg("out") || path.join(BACKEND_ROOT, "test-results", "e2e", "harness.json"));
  if (!fs.existsSync(outFile)) {
    console.error(`No harness out file at ${outFile}. Start the harness first: npm run e2e:backend`);
    return 2;
  }
  const harness = readHarnessOut(outFile);
  const client = createScenarioClient(harness);
  const document = await client.control("GET", "/__e2e/scenarios");
  const only = arg("only") ? new Set(arg("only").split(",")) : null;
  const selected = document.scenarios.filter((scenario) => !only || only.has(scenario.id));
  const results = [];
  for (const scenario of selected) {
    const result = await client.runScenario(scenario);
    results.push(result);
    if (!process.argv.includes("--json")) {
      console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id.padEnd(5)} ${String(result.seconds).padStart(5)}s  ${result.state} / ${result.overallStatus} / satellite ${result.satellite}${result.problems.length ? `\n      ${result.problems.join("\n      ")}` : ""}`);
    }
  }
  await client.control("POST", "/__e2e/scenario", { reset: true });
  const violations = await client.control("GET", "/__e2e/network-violations");
  if (process.argv.includes("--json")) console.log(JSON.stringify({ results, networkViolations: violations }, null, 2));
  else console.log(`${results.filter((r) => r.pass).length}/${results.length} passed; network violations: ${violations.length}`);
  return results.every((r) => r.pass) && violations.length === 0 ? 0 : 1;
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then((code) => process.exit(code), (error) => {
  console.error(error?.message || error);
  process.exit(1);
});
