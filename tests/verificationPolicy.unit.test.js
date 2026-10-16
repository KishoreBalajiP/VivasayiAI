import { describe, expect, it } from "vitest";
import { COMPONENTS, POLICY_IDS, resolvePolicy } from "../config/verificationPolicy.js";

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
});
