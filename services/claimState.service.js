import ApiError from "../utils/ApiError.js";
import { CLAIM_STATES } from "../models/LossClaim.js";

// F-49 (ADR-019) — centralized claim state machine (07_Database_Design §6, P6).
//
// Single source of truth for legal transitions across all 10 states. Controllers and services
// must never set `claim.state` directly — they call applyTransition and persist afterwards.
// Deterministic, importable, and unit-testable in isolation (tests/claimState.test.js).
//
//   draft → submitted → processing → verified
//   processing → partially_verified
//   processing → more_evidence_required → (resubmitted →) processing
//   processing → rejected | out_of_limit | duplicate_area
//   draft/submitted → withdrawn
//
// verified / partially_verified / rejected / out_of_limit / duplicate_area / withdrawn are
// TERMINAL: no outgoing transitions. Resubmission is only ever from more_evidence_required (P6);
// a terminal claim is never silently resubmitted.

const ALLOWED = {
  draft: ["submitted", "withdrawn"],
  submitted: ["processing", "withdrawn"], // processing added E9-S5 (Phase 5): the diagram below
  // already documents `draft → submitted → processing → verified` and
  // `more_evidence_required → (resubmitted →) processing`; without this inbound edge the
  // verification engine could never legally reach any decision state. Minimal completion.
  processing: [
    "verified",
    "partially_verified",
    "more_evidence_required",
    "rejected",
    "out_of_limit",
    "duplicate_area",
  ],
  more_evidence_required: ["submitted"],
  verified: [],
  partially_verified: [],
  rejected: [],
  out_of_limit: [],
  duplicate_area: [],
  withdrawn: [],
};

export const TERMINAL_STATES = new Set([
  "verified",
  "partially_verified",
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "withdrawn",
]);

export const claimStates = () => [...CLAIM_STATES];

export const allowedTransitions = (state) => {
  const allowed = ALLOWED[state];
  if (!allowed) return [];
  return [...allowed];
};

export const canTransition = (fromState, toState) =>
  (ALLOWED[fromState]?.includes(toState) ?? false);

// Validates and applies a transition in-memory; the caller persists (with its audit entry).
// Throws a 409 conflict on invalid transitions — deterministic and rejectable.
export const applyTransition = ({ claim, toState }) => {
  if (!CLAIM_STATES.includes(toState)) {
    throw ApiError.badRequest("Unknown claim state");
  }
  const fromState = claim.state;
  if (fromState === toState) {
    return { claim, fromState, toState, applied: false };
  }
  if (!canTransition(fromState, toState)) {
    throw ApiError.conflict(`Invalid state transition: ${fromState} → ${toState}`);
  }
  claim.state = toState;
  return { claim, fromState, toState, applied: true };
};

export default {
  TERMINAL_STATES,
  claimStates,
  allowedTransitions,
  canTransition,
  applyTransition,
};