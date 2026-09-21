import { describe, expect, it } from "vitest";
import {
  applyTransition,
  allowedTransitions,
  canTransition,
  claimStates,
  TERMINAL_STATES,
} from "../services/claimState.service.js";
import ApiError from "../utils/ApiError.js";

// F-49 (ADR-019): the centralized claim state machine must be importable/testable in isolation,
// expose all 10 states + allowed transitions, and reject invalid transitions deterministically.

describe("claimState.service — centralized claim state machine", () => {
  it("exposes exactly the 10 documented claim states", () => {
    expect(claimStates()).toEqual([
      "draft",
      "submitted",
      "processing",
      "verified",
      "partially_verified",
      "more_evidence_required",
      "rejected",
      "out_of_limit",
      "duplicate_area",
      "withdrawn",
    ]);
  });

  it("exposes the allowed outgoing transitions for every state", () => {
    expect(allowedTransitions("draft")).toEqual(["submitted", "withdrawn"]);
    expect(allowedTransitions("submitted")).toEqual(["withdrawn"]);
    expect(allowedTransitions("processing")).toEqual([
      "verified",
      "partially_verified",
      "more_evidence_required",
      "rejected",
      "out_of_limit",
      "duplicate_area",
    ]);
    expect(allowedTransitions("more_evidence_required")).toEqual(["submitted"]);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const state of TERMINAL_STATES) {
      expect(allowedTransitions(state)).toEqual([]);
      expect(canTransition(state, "withdrawn")).toBe(false);
      expect(canTransition(state, "submitted")).toBe(false);
    }
  });

  it("resubmission is only ever legal from more_evidence_required (P6)", () => {
    expect(canTransition("more_evidence_required", "submitted")).toBe(true);
    expect(canTransition("submitted", "submitted")).toBe(false);
    expect(canTransition("verified", "submitted")).toBe(false);
    expect(canTransition("withdrawn", "submitted")).toBe(false);
  });

  it("marks the six documented states as terminal", () => {
    expect([...TERMINAL_STATES].sort()).toEqual([
      "duplicate_area",
      "out_of_limit",
      "partially_verified",
      "rejected",
      "verified",
      "withdrawn",
    ]);
  });

  it("applies only legal transitions and reports fromState/toState", () => {
    const claim = { state: "draft" };
    const result = applyTransition({ claim, toState: "submitted" });
    expect(result.applied).toBe(true);
    expect(result.fromState).toBe("draft");
    expect(result.toState).toBe("submitted");
    expect(claim.state).toBe("submitted");
  });

  it("rejects an invalid transition with a deterministic 409 ApiError", () => {
    const claim = { state: "draft" };
    try {
      applyTransition({ claim, toState: "processing" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(409);
      expect(error.message).toContain("Invalid state transition: draft");
    }
    expect(claim.state).toBe("draft");
  });

  it("treats a same-state transition as a no-op (idempotent), not an error", () => {
    const claim = { state: "submitted" };
    const result = applyTransition({ claim, toState: "submitted" });
    expect(result.applied).toBe(false);
    expect(claim.state).toBe("submitted");
  });

  it("rejects an unknown target state with a 400", () => {
    try {
      applyTransition({ claim: { state: "draft" }, toState: "not-a-state" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.statusCode).toBe(400);
    }
  });
});