// Preload for the hermetic harness's PROCESS worker (ADR-024, critique B3):
//
//   node --import scripts/e2e/fakeGeminiPreload.js scripts/worker.js
//
// started by scripts/e2e/hermeticBackend.js --worker=process with the harness's environment (e2e.env,
// the memory MongoDB, the shared IMAGE_STORAGE_MOCK_DIR). Before the worker runs it:
//   1. installs the loopback-only network guard, appending any blocked attempt to
//      E2E_NETWORK_VIOLATIONS_FILE (the control server reports both processes' violations);
//   2. replaces chat.service's model.generate with the fake Gemini;
//   3. follows the control server's scenario (E2E_SCENARIO_FILE): the fake's modes and the satellite,
//      weather and land-record mock outcomes, re-read whenever the file's version changes.
// Refuses to do anything outside the harness (no E2E_SCENARIO_FILE, or a production environment).

import fs from "node:fs";
import { installNetworkGuard } from "./lib/networkGuard.js";

if (!process.env.E2E_SCENARIO_FILE || process.env.NODE_ENV === "production" || process.env.AWS_LAMBDA_FUNCTION_NAME) {
  process.stderr.write("fakeGeminiPreload: refusing to run outside the hermetic e2e harness\n");
  process.exit(2);
}

const violationsFile = process.env.E2E_NETWORK_VIOLATIONS_FILE || null;
installNetworkGuard({
  label: "E2E",
  onViolation: (violation) => {
    if (!violationsFile) return;
    try {
      fs.appendFileSync(violationsFile, `${JSON.stringify({ ...violation, process: "worker" })}\n`);
    } catch {
      // the block itself still happens
    }
  },
});

const { model } = await import("../../services/chat.service.js");
const { createFakeGemini, installFakeGemini, loadPromptConstants } = await import("./lib/fakeGemini.js");
const fake = createFakeGemini({ prompts: await loadPromptConstants() });
installFakeGemini(model, fake);

let version = null;
const follow = () => {
  let scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(process.env.E2E_SCENARIO_FILE, "utf8"));
  } catch {
    return;
  }
  if (!scenario || scenario.version === version) return;
  version = scenario.version;
  try {
    fake.configure({ ai: scenario.ai, landDocument: scenario.landDocument, holderNames: scenario.holderNames });
  } catch (error) {
    process.stderr.write(`fakeGeminiPreload: ignoring scenario (${error.message})\n`);
  }
  if (scenario.satellite) process.env.SATELLITE_MOCK_OUTCOME = scenario.satellite;
  if (scenario.weather) process.env.WEATHER_MOCK_OUTCOME = scenario.weather;
  if (scenario.landRecord) process.env.LAND_RECORD_MOCK_OUTCOME = scenario.landRecord;
};
follow();
const timer = setInterval(follow, 200);
timer.unref();
