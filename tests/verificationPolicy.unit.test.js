import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPONENTS, POLICY_IDS, POLICY_KEY_DEFAULTS, policySetting, resolvePolicy } from "../config/verificationPolicy.js";
import { DEFAULT_CLAIM_VERIFICATION_POLICY, env } from "../config/env.js";

// Policy hashes captured at HEAD 6dbe6b8, before v1.1-safe-ai existed (scripts/eval/captureEngineGolden.js).
const goldenPolicies = () => JSON.parse(readFileSync(new URL("./fixtures/engine-golden-2026-10.json", import.meta.url), "utf8")).policies;
const V11_KEYS = ["aiNoDamageScope", "technicalFailure", "aiMalformedOutput", "claimWindowReference", "engineWaitsFor", "reviewCaseOnHold"];

describe("verification policy", () => {
  it("VP-1: both policies resolve, cover every component, and are deeply frozen", () => {
    for (const id of POLICY_IDS) {
      const policy = resolvePolicy(id);
      expect(Object.keys(policy.components).sort()).toEqual([...COMPONENTS].sort());
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.components.geometry)).toBe(true);
      expect(() => {
        "use strict";
        policy.components.geometry.required = false;
      }).toThrow();
    }
  });

  it("VP-2: the hash is stable and differs between policies", () => {
    expect(resolvePolicy("v1-legacy").hash).toBe(resolvePolicy("v1-legacy").hash);
    expect(resolvePolicy("v1-legacy").hash).not.toBe(resolvePolicy("v2-components").hash);
    expect(resolvePolicy("v2-components").hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("VP-3: env rule knobs are part of the policy and of its hash", () => {
    const policy = resolvePolicy("v1-legacy");
    expect(policy.rules.claimWindowDays).toBe(30);
    expect(policy.rules.claimAreaOverageFraction).toBeGreaterThan(0);
  });

  it("VP-4: v1-legacy is a no-op gate; v2-components requires claimant rights", () => {
    const v1 = resolvePolicy("v1-legacy");
    expect(v1.gateEnabled).toBe(false);
    expect(Object.values(v1.components).every((entry) => entry.required === false)).toBe(true);
    expect(v1.aiNoDamage).toBe("reject");

    const v2 = resolvePolicy("v2-components");
    expect(v2.gateEnabled).toBe(true);
    expect(v2.components.claimant_rights.required).toBe(true);
    expect(v2.components.manual_review.required).toBe("when_open");
    expect(v2.components.satellite.required).toBe(false);
    expect(v2.aiNoDamage).toBe("review");
  });

  it("VP-5: an unknown policy id fails loudly", () => {
    expect(() => resolvePolicy("v9-made-up")).toThrow(/Unknown verification policy/);
  });

  it("VP-6: a failed required component never maps to a rejection", () => {
    for (const id of POLICY_IDS) {
      for (const entry of Object.values(resolvePolicy(id).components)) {
        expect(entry.onFailed).toBe("more_evidence_required");
      }
    }
  });

  it("VP-7: the v1-legacy and v2-components hashes are unchanged from the pre-change golden capture", () => {
    const pinned = goldenPolicies();
    expect(resolvePolicy("v1-legacy").hash).toBe(pinned["v1-legacy"].hash);
    expect(resolvePolicy("v2-components").hash).toBe(pinned["v2-components"].hash);
  });

  it("VP-8: v1.1-safe-ai resolves, is deeply frozen, has its own hash, every component optional, and the new keys", () => {
    const policy = resolvePolicy("v1.1-safe-ai");
    expect(POLICY_IDS).toContain("v1.1-safe-ai");
    expect(policy.id).toBe("v1.1-safe-ai");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.engineWaitsFor)).toBe(true);
    expect(Object.isFrozen(policy.components.photos)).toBe(true);
    expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(policy.hash).not.toBe(resolvePolicy("v1-legacy").hash);
    expect(policy.hash).not.toBe(resolvePolicy("v2-components").hash);
    expect(Object.keys(policy.components).sort()).toEqual([...COMPONENTS].sort());
    expect(Object.values(policy.components).every((entry) => entry.required === false)).toBe(true);
    expect(policy.gateEnabled).toBe(false);
    expect(policy).toMatchObject({
      aiNoDamage: "review",
      aiNoDamageScope: "ai_only",
      technicalFailure: "hold",
      aiMalformedOutput: "unavailable",
      claimWindowReference: "firstSubmittedAt",
      engineWaitsFor: ["ai_assessment", "land_documents", "official_land_record", "weather"],
      reviewCaseOnHold: true,
    });
    // Satellite is never waited for (owner decision D1).
    expect(policy.engineWaitsFor).not.toContain("satellite");
    // Same thresholds as the frozen policies: only the safety behaviour differs.
    expect(policy.satellite).toEqual(resolvePolicy("v1-legacy").satellite);
    expect(policy.rules).toEqual(resolvePolicy("v1-legacy").rules);
  });

  it("VP-9: v1-legacy and v2-components define none of the v1.1 keys; code reads the legacy defaults for them", () => {
    for (const id of ["v1-legacy", "v2-components"]) {
      const policy = resolvePolicy(id);
      for (const key of V11_KEYS) {
        expect(Object.prototype.hasOwnProperty.call(policy, key), `${id}.${key}`).toBe(false);
        expect(policySetting(policy, key)).toEqual(POLICY_KEY_DEFAULTS[key]);
      }
    }
    expect(policySetting(resolvePolicy("v1.1-safe-ai"), "technicalFailure")).toBe("hold");
    expect(policySetting(null, "claimWindowReference")).toBe("decisionTime");
    // The suite pins v1-legacy (vitest.config.js) whatever the code default is (VP-10).
    expect(env.claimVerificationPolicy).toBe("v1-legacy");
  });

  it("VP-10: the code default is v1.1-safe-ai (plan A12, ADR-022) and it resolves", () => {
    expect(DEFAULT_CLAIM_VERIFICATION_POLICY).toBe("v1.1-safe-ai");
    expect(resolvePolicy(DEFAULT_CLAIM_VERIFICATION_POLICY).id).toBe("v1.1-safe-ai");
  });
});
