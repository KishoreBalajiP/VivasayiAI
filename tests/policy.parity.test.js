import { describe, expect, it } from "vitest";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { evaluateClaimVerification } from "../services/claimVerificationEngine.service.js";
import { resolveComponents } from "../services/verificationComponents.js";
import {
  GOLDEN_FORMAT,
  GOLDEN_POLICIES,
  buildScenarioInputs,
  canonicalize,
  evaluateGoldenScenario,
  loadGoldenFixture,
  shortHash,
  splitResult,
} from "../scripts/eval/captureEngineGolden.js";

// Policy parity (plan A0/A2, PV-1..PV-7). The golden fixture was captured from the engine at HEAD
// 6dbe6b8 BEFORE any engine or policy edit (scripts/eval/captureEngineGolden.js). The frozen policies
// must replay it exactly; v1.1-safe-ai may differ ONLY where the plan says it does.

const golden = loadGoldenFixture();
const engine = { evaluateClaimVerification, resolveComponents };
const V1 = resolvePolicy("v1-legacy");
const V2 = resolvePolicy("v2-components");
const V11 = resolvePolicy("v1.1-safe-ai");

const goldenResult = (row, policyId) => ({
  ...golden.decisions[row.results[policyId].d],
  components: golden.components[row.results[policyId].c],
});
const byId = new Map(golden.scenarios.map((row) => [row.id, row]));
const scenario = (id) => {
  const row = byId.get(id);
  if (!row) throw new Error(`golden scenario ${id} is missing`);
  return row;
};
const run = (row, policy) => evaluateGoldenScenario({ scenario: row, policy, ...engine });

// Rules evaluated before the AI rule, in the engine's precedence order.
const EARLIER_RULES = ["timelinessCheck", "eventTypeCheck", "areaCheck", "spatialCheck", "overlapCheck", "remainingCheck"];
const earlierRulesPass = (result) => EARLIER_RULES.every((name) => result.rules[name].passed === true);
const isAiOnlyRejection = (result) => result.outcome === "rejected" && result.rules.aiCheck.passed === false && earlierRulesPass(result);
const AI_UNAVAILABLE_REASON = "AI assessment is not available for the submitted evidence";
const isTechnicalAiFailure = (result) =>
  result.outcome === "more_evidence_required" && earlierRulesPass(result) && result.rules.aiCheck.reason === AI_UNAVAILABLE_REASON;

// The decision part of a result, without the fields that name the policy itself.
const DECISION_FIELDS = [
  "outcome", "disposition", "reason", "reasons", "rules", "approvedGeometry", "approvedAreaAcres", "overlapUnchecked",
  "verifiedAreaAcres", "remainingEligible", "remainingEligibleAcres", "previouslyVerifiedAcres", "inFlightAreaAcres",
  "overlapWarnings", "spatialEvaluated", "engineVersion",
];
const decisionOf = (result) => Object.fromEntries(DECISION_FIELDS.map((field) => [field, result[field]]));
const componentsWithoutPhotos = (result) => {
  const { photos, ...rest } = result.components || {};
  return rest;
};

describe("policy parity (PV)", () => {
  it("PV-1: v1-legacy replays every golden scenario exactly (outcome, gates, reasons, components, policy hash)", () => {
    // The fixture is the pre-change capture it claims to be: format, commit, the 1,536-scenario
    // factorial, captured from unmodified engine/resolver/policy files, and every scenario's inputs
    // rebuild exactly as captured (so a changed scenario builder cannot fake parity).
    expect(golden.format).toBe(GOLDEN_FORMAT);
    expect(golden.commit).toMatch(/^6dbe6b8/);
    expect(golden.counts.factorial).toBe(1536);
    expect(golden.counts.scenarios).toBe(golden.scenarios.length);
    expect(Object.keys(golden.policies).sort()).toEqual([...GOLDEN_POLICIES].sort());
    for (const info of Object.values(golden.sources)) expect(info.matchesHead).toBe(true);
    for (const row of golden.scenarios) expect(shortHash(buildScenarioInputs(row)), row.id).toBe(row.inputsHash);

    expect(V1.hash).toBe(golden.policies["v1-legacy"].hash);
    let compared = 0;
    for (const row of golden.scenarios) {
      const { decision, components } = splitResult(run(row, V1));
      expect(shortHash(decision), row.id).toBe(row.results["v1-legacy"].d);
      expect(shortHash(components), row.id).toBe(row.results["v1-legacy"].c);
      compared += 1;
    }
    expect(compared).toBe(golden.scenarios.length);
    // Spot-check the stored tables themselves, not only the hashes.
    const sample = scenario("f:in:nodup:nocross:no_damage:owner_accepted:none:none");
    expect(run(sample, V1)).toEqual(canonicalize(goldenResult(sample, "v1-legacy")));
    expect(goldenResult(sample, "v1-legacy").outcome).toBe("rejected");
  });

  it("PV-2: v2-components replays every golden scenario exactly", () => {
    expect(V2.hash).toBe(golden.policies["v2-components"].hash);
    for (const row of golden.scenarios) {
      const { decision, components } = splitResult(run(row, V2));
      expect(shortHash(decision), row.id).toBe(row.results["v2-components"].d);
      expect(shortHash(components), row.id).toBe(row.results["v2-components"].c);
    }
    const sample = scenario("f:in:nodup:nocross:no_damage:owner_accepted:none:none");
    expect(run(sample, V2)).toEqual(canonicalize(goldenResult(sample, "v2-components")));
  });

  it("PV-3: v1.1 differs from v1-legacy only on AI-only rejections (held) and AI technical failures (held)", () => {
    let aiOnly = 0;
    let technical = 0;
    let identical = 0;
    for (const row of golden.scenarios) {
      // A recorded first submission moves the window reference under v1.1: that difference is PV-6's.
      if (typeof row.firstSubmittedDaysAfterEvent === "number") continue;
      const legacy = goldenResult(row, "v1-legacy");
      const safe = run(row, V11);
      expect(componentsWithoutPhotos(safe), row.id).toEqual(componentsWithoutPhotos(legacy));
      expect(safe.rules, row.id).toEqual(legacy.rules);

      if (isAiOnlyRejection(legacy)) {
        aiOnly += 1;
        expect(safe.disposition, row.id).toBe("hold");
        expect(safe.outcome, row.id).toBeNull();
        expect(safe.approvedAreaAcres, row.id).toBeNull();
        expect(safe.candidateSource, row.id).toBe("aiCheck");
        expect(safe.gate.blocking, row.id).toEqual([
          { component: "photos", outcome: "requires_review", action: "hold", reasonCode: "ai_no_damage_needs_review" },
        ]);
        expect(safe.reasons.slice(0, legacy.reasons.length), row.id).toEqual(legacy.reasons);
      } else if (isTechnicalAiFailure(legacy)) {
        technical += 1;
        expect(safe.disposition, row.id).toBe("hold");
        expect(safe.outcome, row.id).toBeNull();
        expect(safe.gate.blocking[0], row.id).toMatchObject({ component: "photos", outcome: "unavailable", action: "hold" });
      } else {
        identical += 1;
        expect(decisionOf(safe), row.id).toEqual(decisionOf(legacy));
      }
    }
    // Non-vacuous: the factorial contains both kinds of difference, and most scenarios are identical.
    expect(aiOnly).toBeGreaterThan(0);
    expect(technical).toBeGreaterThan(0);
    expect(identical).toBeGreaterThan(aiOnly + technical);
  });

  it("PV-4: v1.1 makes zero rejections on the AI reading alone (v1-legacy made them)", () => {
    let legacyAiOnly = 0;
    for (const row of golden.scenarios) {
      const safe = run(row, V11);
      if (safe.outcome === "rejected") expect(safe.candidateSource, row.id).not.toBe("aiCheck");
      if (isAiOnlyRejection(goldenResult(row, "v1-legacy"))) legacyAiOnly += 1;
    }
    expect(legacyAiOnly).toBeGreaterThan(0);
    // The evaluation's "adverse on AI alone" set (inside, not a duplicate, no cross-farmer overlap,
    // photographs say no damage, acceptable rights): every one is held, none rejected.
    const aiAlone = golden.scenarios.filter(
      (row) => row.kind === "factorial" && row.inside && !row.duplicate && !row.cross && row.photos === "no_damage" &&
        ["owner_accepted", "tenant_right_docs"].includes(row.rights)
    );
    expect(aiAlone.length).toBe(16);
    for (const row of aiAlone) {
      expect(goldenResult(row, "v1-legacy").outcome).toBe("rejected");
      const safe = run(row, V11);
      expect(safe.outcome).toBeNull();
      expect(safe.disposition).toBe("hold");
    }
  });

  it("PV-5: under v1.1 satellite and weather variants flip 0 of 1536 outcomes", () => {
    const baseline = new Map();
    let compared = 0;
    let flipped = 0;
    for (const row of golden.scenarios.filter((entry) => entry.kind === "factorial")) {
      const key = [row.inside, row.duplicate, row.cross, row.photos, row.rights].join("|");
      const result = run(row, V11);
      const signature = `${result.outcome}/${result.disposition}`;
      if (!baseline.has(key)) baseline.set(key, run({ ...row, satellite: "none", weather: "none" }, V11));
      const base = baseline.get(key);
      compared += 1;
      if (signature !== `${base.outcome}/${base.disposition}`) flipped += 1;
    }
    expect(compared).toBe(1536);
    expect(flipped).toBe(0);
  });

  it("PV-6: v1.1 measures the claim window at first submission; v1-legacy keeps measuring at decision time", () => {
    // Event 40 days before the decision, first submitted 3 days after the event: in time under v1.1.
    const inTime = scenario("e:event_40_days_first_submitted_day_3:supportive:owner_accepted");
    expect(goldenResult(inTime, "v1-legacy").outcome).toBe("rejected");
    expect(goldenResult(inTime, "v1-legacy").rules.timelinessCheck.passed).toBe(false);
    expect(run(inTime, V1)).toEqual(canonicalize(goldenResult(inTime, "v1-legacy"))); // preserved
    const safeInTime = run(inTime, V11);
    expect(safeInTime.rules.timelinessCheck.passed).toBe(true);
    expect(safeInTime.outcome).toBe("verified");

    // First submitted 31 days after the event: late under every policy.
    const late = scenario("e:event_40_days_first_submitted_day_31:supportive:owner_accepted");
    const safeLate = run(late, V11);
    expect(safeLate.rules.timelinessCheck.passed).toBe(false);
    expect(safeLate.outcome).toBe("rejected");
    expect(safeLate.candidateSource).toBe("timelinessCheck");

    // No recorded first submission: v1.1 falls back to the decision time, exactly like v1-legacy.
    for (const days of [29, 30, 31, 45]) {
      const row = scenario(`e:event_${days}_days:supportive:owner_accepted`);
      const safe = run(row, V11);
      expect(safe.rules.timelinessCheck, row.id).toEqual(goldenResult(row, "v1-legacy").rules.timelinessCheck);
      expect(safe.outcome, row.id).toBe(goldenResult(row, "v1-legacy").outcome);
    }
    expect(run(scenario("e:event_45_days:supportive:owner_accepted"), V11).outcome).toBe("rejected");
  });

  it("PV-7: under v1.1 an unavailable AI assessment holds inside the engine; it never asks for more evidence", () => {
    for (const photos of ["failed", "processing", "missing"]) {
      for (const rights of ["none", "owner_accepted", "tenant_right_docs"]) {
        const row = scenario(`e:event_29_days:${photos}:${rights}`);
        expect(goldenResult(row, "v1-legacy").outcome, row.id).toBe("more_evidence_required"); // historical
        const safe = run(row, V11);
        expect(safe.outcome, row.id).toBeNull();
        expect(safe.disposition, row.id).toBe("hold");
        expect(safe.gate.blocking, row.id).toEqual([
          { component: "photos", outcome: "unavailable", action: "hold", reasonCodes: ["ai_assessment_unavailable"] },
        ]);
      }
    }
    // The provider failure kind travels with the hold when the assessment recorded one.
    const inputs = buildScenarioInputs(scenario("e:event_29_days:failed:owner_accepted"));
    inputs.assessment.error.kind = "quota";
    const components = resolveComponents({ ...inputs, policy: V11 });
    expect(components.photos.outcome).toBe("unavailable");
    const quota = evaluateClaimVerification({ ...inputs, components, policy: V11 });
    expect(quota.gate.blocking[0].reasonCodes).toEqual(["ai_assessment_unavailable", "provider_quota"]);

    // A technical failure never hides a rejection the AI did not cause.
    const outside = scenario("e:outside_parcel:failed:owner_accepted");
    expect(run(outside, V11).outcome).toBe("rejected");
    expect(run(outside, V11).candidateSource).toBe("spatialCheck");
    // No photographs at all is the farmer's to fix: still more_evidence_required.
    expect(run(scenario("e:event_29_days:none:owner_accepted"), V11).outcome).toBe("more_evidence_required");
  });

});
