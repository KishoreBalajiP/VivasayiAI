// Phase 10 (E9-S10) — Admin override rules (pure, unit-testable in isolation).
//
// The automated verification engine remains the PRIMARY decision-maker (ADR-019). An admin
// override is the deliberate, immutable, audited EXCEPTION path: a human may redirect a claim
// from an eligible source state to a decision state. Because the override is a human decision,
// it deliberately bypasses the farmer state machine (which has no outgoing transitions from
// terminal states) — but only under these rules, and every apply is recorded in AdminAction +
// ClaimAudit (never silent).
//
// Decision states are the states the engine (or, in exception, an admin) may leave a claim in.
// The single source of truth here keeps validation.schemas, admin.service and the admin UI in
// lock-step.

export const DECISION_STATES = [
  "verified",
  "partially_verified",
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "more_evidence_required",
];

export const DECISION_STATE_SET = new Set(DECISION_STATES);

// Source states from which an admin MAY override. `processing` covers AI-failed / never-decided
// claims (E9-S5 leaves the claim in processing when a gate fails); the decision/rejected family
// covers engine decisions. Excluded: draft/submitted (not yet decided), withdrawn (closed —
// the farmer must file a fresh claim).
export const OVERRIDEABLE_STATES = [
  "processing",
  "more_evidence_required",
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "verified",
  "partially_verified",
];

export const OVERRIDEABLE_STATE_SET = new Set(OVERRIDEABLE_STATES);

export const isOverrideableFrom = (fromState) => OVERRIDEABLE_STATE_SET.has(fromState);

export const isDecisionState = (state) => DECISION_STATE_SET.has(state);

// Pure transition validation for an override (returns { ok: true } or { ok: false, reason }).
// Mirrors applyTransition's determinism but is the ADMIN path: same to-state checks plus the
// source-must-be-overrideable rule and the no-op guard (an override must change the state).
export const evaluateOverrideTransition = ({ fromState, toState }) => {
  if (!DECISION_STATES.includes(toState)) {
    return { ok: false, reason: "Override must target a decision state" };
  }
  if (!OVERRIDEABLE_STATES.includes(fromState)) {
    return { ok: false, reason: `Claim in ${fromState} state cannot be overridden` };
  }
  if (fromState === toState) {
    return { ok: false, reason: "Override must change the claim state" };
  }
  return { ok: true, reason: null };
};

// Second-admin approval gate (15_Security §5): when a zero-acreage / high-value override exceeds
// the configured threshold, a SECOND distinct admin identity must be recorded as approver.
// threshold <= 0 disables the requirement.
export const overridesRequireApprover = ({ overriddenAcres = null, threshold = 0 }) => {
  const t = Number(threshold);
  if (!(t > 0)) return false;
  const acres = Number(overriddenAcres);
  return Number.isFinite(acres) && acres > t;
};

// Approval validity: the approver must be a non-empty distinct identity from the actor.
export const approverIsValid = ({ actorSub, approverSub }) =>
  typeof approverSub === "string" && approverSub.trim().length > 0 && approverSub !== actorSub;

export const ADMIN_ACTION_LABELS = {
  override: "Admin override",
  appeal_resolution: "Appeal resolution",
};

export default {
  DECISION_STATES,
  DECISION_STATE_SET,
  OVERRIDEABLE_STATES,
  OVERRIDEABLE_STATE_SET,
  isOverrideableFrom,
  isDecisionState,
  evaluateOverrideTransition,
  overridesRequireApprover,
  approverIsValid,
  ADMIN_ACTION_LABELS,
};