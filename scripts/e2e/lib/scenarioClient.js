// A small client for a running hermetic harness (ADR-024). Used by scripts/e2e/checkScenarios.js and
// the harness smoke test (MK-3); the Playwright fixtures in the frontend repo do the same over HTTP.
// Talks only to the harness's loopback URLs from the out file.

import fs from "node:fs";

export const readHarnessOut = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createScenarioClient = ({ apiUrl, controlUrl, controlToken }) => {
  const control = async (method, route, body) => {
    const response = await fetch(`${controlUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`control ${method} ${route} -> ${response.status} ${json && json.error ? json.error : ""}`.trim());
    return json;
  };
  const apiCall = async (method, route, token) => {
    const response = await fetch(`${apiUrl}${route}`, { method, headers: { Authorization: `Bearer ${token}` } });
    const json = await response.json().catch(() => null);
    return { status: response.status, data: json && json.data };
  };

  // Settled per scenarios.json settleRules (decided / held / held_after_recovery).
  const isSettled = (inspection, scenario) => {
    const settle = scenario.settle || "decided";
    if (settle === "decided") return inspection.settled.decided;
    if (settle === "held") return inspection.settled.held;
    if (settle === "held_after_recovery") {
      return inspection.settled.held && inspection.settled.maxRecoveryRound >= (scenario.expected.recoveryRound ?? 0) && inspection.jobs.every((job) => job.step !== "ai_assessment" || job.status !== "queued");
    }
    return false;
  };

  const waitFor = async (claimId, scenario, { timeoutMs = 150_000, intervalMs = 500 } = {}) => {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
      last = await control("GET", `/__e2e/claims/${claimId}/inspect`);
      if (isSettled(last, scenario)) return { settled: true, inspection: last };
      await sleep(intervalMs);
    }
    return { settled: false, inspection: last };
  };

  // Compare the settled API view with scenario.expected. Returns a list of mismatches ([] = pass).
  const compare = ({ scenario, inspection, progress }) => {
    const expected = scenario.expected || {};
    const problems = [];
    const check = (label, actual, wanted) => {
      if (wanted === undefined) return;
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) problems.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    };
    const decisionStates = ["verified", "partially_verified", "rejected", "duplicate_area", "out_of_limit", "more_evidence_required"];
    check("outcome", decisionStates.includes(inspection.state) ? inspection.state : null, expected.outcome);
    check("decision", progress && progress.decision, expected.decision);
    check("overallStatus", progress && progress.overallStatus, expected.overallStatus);
    if (expected.held !== undefined) check("held", Boolean(inspection.assessment && inspection.assessment.held), expected.held);
    check("satelliteStatus", progress && progress.satellite && progress.satellite.status, expected.satelliteStatus);
    check("satelliteReasonCode", progress && progress.satellite && progress.satellite.reasonCode, expected.satelliteReasonCode);
    if (expected.satelliteNextCheckAt) check("satellite.nextCheckAt set", Boolean(progress && progress.satellite && progress.satellite.nextCheckAt), true);
    if (expected.supportingOnly !== undefined) check("satellite.supportingOnly", progress && progress.satellite && progress.satellite.supportingOnly, expected.supportingOnly);
    if (expected.recoveryRound !== undefined) check("recoveryRound", inspection.settled.maxRecoveryRound, expected.recoveryRound);
    if (expected.reviewCases !== undefined) check("reviewCases", inspection.reviewCases, expected.reviewCases);
    const decisionStage = progress && progress.stages && progress.stages.find((stage) => stage.id === "decision");
    check("decision.explanationKey", decisionStage && decisionStage.explanationKey, expected.decisionExplanationKey);
    const weatherStage = progress && progress.stages && progress.stages.find((stage) => stage.id === "weather");
    check("weather.explanationKey", weatherStage && weatherStage.explanationKey, expected.weatherExplanationKey);
    for (const [stageId, status] of Object.entries(expected.stages || {})) {
      const stage = progress && progress.stages && progress.stages.find((entry) => entry.id === stageId);
      check(`stages.${stageId}`, stage && stage.status, status);
    }
    for (const [action, count] of Object.entries(expected.audits || {})) check(`audits.${action}`, inspection.audits[action] || 0, count);
    if (inspection.assessment) check("assessment.policy.id", inspection.assessment.policy && inspection.assessment.policy.id, "v1.1-safe-ai");
    return problems;
  };

  // Run one scenario end to end through the API: a fresh farmer, the scenario's setup, the claim, the
  // worker, then the comparison.
  const runScenario = async (scenario, { timeoutMs } = {}) => {
    const started = Date.now();
    await control("POST", "/__e2e/scenario", { id: scenario.id });
    const before = (await control("GET", "/__e2e/scenario")).calls;
    const session = await control("POST", "/__e2e/session", { role: "farmer", language: "en" });
    const seeded = await control("POST", "/__e2e/seed-claim", { accessToken: session.accessToken, scenario: scenario.id });
    const waited = await waitFor(seeded.claimId, scenario, { timeoutMs });
    const progress = (await apiCall("GET", `/claims/${seeded.claimId}/progress`, session.accessToken)).data;
    const after = (await control("GET", "/__e2e/scenario")).calls;
    const problems = waited.settled ? compare({ scenario, inspection: waited.inspection, progress: progress && progress.progress }) : ["did not settle in time"];
    if (scenario.expected && scenario.expected.modelCalls !== undefined) {
      const calls = after.claim_vision - before.claim_vision;
      if (calls !== scenario.expected.modelCalls) problems.push(`modelCalls: expected ${scenario.expected.modelCalls}, got ${calls}`);
    }
    return {
      id: scenario.id,
      pass: problems.length === 0,
      problems,
      claimId: seeded.claimId,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      state: waited.inspection && waited.inspection.state,
      overallStatus: progress && progress.progress && progress.progress.overallStatus,
      satellite: progress && progress.progress && progress.progress.satellite && `${progress.progress.satellite.status}/${progress.progress.satellite.reasonCode}`,
    };
  };

  return { control, apiCall, waitFor, compare, runScenario, isSettled };
};

export default { createScenarioClient, readHarnessOut };
