import { createHash } from "node:crypto";
import { env } from "./env.js";

// Verification policy (ADR-020). A policy is the versioned, frozen description of WHICH evidence
// components a claim needs before the deterministic engine may approve it, and how unresolved or
// failed components are handled. It contains no logic: the pure engine and resolver read it.
//
// Every decision records `{id, hash}` so a later reader can tell exactly which rules applied, even
// after an environment knob (window days, overage fraction) changes: the hash covers the merged
// rule values, not just the id.
//
// Component outcome vocabulary (shared with services/verificationComponents.js):
//   verified | failed | unverified | unavailable | inconclusive | pending | requires_review
// A provider failure is `unavailable`, never `failed`. A lack of evidence is `unverified`, never
// `failed`. `failed` is reserved for a positive finding that contradicts the claim.

export const COMPONENTS = Object.freeze([
  "parcel_identity",
  "claimant_rights",
  "land_documents",
  "geometry",
  "crop",
  "satellite",
  "photos",
  "weather",
  "overlap",
  "manual_review",
]);

export const COMPONENT_OUTCOMES = Object.freeze([
  "verified",
  "failed",
  "unverified",
  "unavailable",
  "inconclusive",
  "pending",
  "requires_review",
]);

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

// `required`: true | false | "when_open" (required only while a review case is open).
// `onFailed`: engine outcome when a REQUIRED component has `failed`. Rejection is deliberately not an
// option here: a failed component asks for more evidence; hard rejections stay with the engine's
// frozen rules and the admin override.
const component = (required, onFailed = "more_evidence_required") => ({ required, onFailed });

const allOptional = Object.fromEntries(COMPONENTS.map((name) => [name, component(false)]));

const SHARED_TUNING = {
  // Pre/post windows around the reported event, in days (see Phase C). Provisional, uncalibrated.
  satellite: {
    preWindowDays: [40, 5],
    postWindowDays: [1, 20],
    minValidPixelFraction: 0.6,
    ndviDropSupport: 0.15,
    maxCloudFraction: 0.3,
  },
  weather: { daysBefore: 3, daysAfter: 1 },
  // Cross-farmer overlap is a REVIEW signal, never an automatic duplicate/fraud label.
  crossFarmer: { minOverlapAcres: 0.05, minShare: 0.1 },
};

const POLICY_DEFINITIONS = {
  // Reproduces the historical engine decisions exactly: the gate is a no-op, components are only
  // recorded. It was the default until 2026-10-16; the default is now v1.1-safe-ai (ADR-022), and
  // this definition stays unchanged so stored decisions replay byte for byte.
  "v1-legacy": {
    id: "v1-legacy",
    description: "Historical behaviour. Component statuses are recorded; none can block a decision.",
    gateEnabled: false,
    aiNoDamage: "reject",
    maxHoldHours: null,
    components: allOptional,
    ...SHARED_TUNING,
  },
  // Requires parcel identity, geometry, photos, overlap and claimant rights before approval.
  // A confident AI "no damage" goes to human review instead of an automatic rejection, because the
  // language model must never be the sole basis of an adverse decision.
  "v2-components": {
    id: "v2-components",
    description: "Required-component gate. Unresolved required components hold the claim for review.",
    gateEnabled: true,
    aiNoDamage: "review",
    maxHoldHours: 72,
    components: {
      ...allOptional,
      parcel_identity: component(true),
      geometry: component(true),
      photos: component(true),
      overlap: component(true),
      claimant_rights: component(true),
      manual_review: component("when_open"),
    },
    ...SHARED_TUNING,
  },
  // ADR-022 (owner decisions D1, D2). The v1-legacy rules with every component optional, except
  // that a technical failure or a language model alone can never cause an adverse decision:
  //   - a confident AI "no damage" reading, when nothing else would reject the claim, holds it for a
  //     reviewer (one review case) instead of rejecting it;
  //   - a provider failure or an unreadable model answer makes the photo check `unavailable`: the
  //     queue retries it, and the engine holds instead of asking the farmer for more evidence;
  //   - the claim window is measured at the claim's FIRST submission, so waiting for checks, a
  //     resubmission or a later review can never turn into a late-claim rejection;
  //   - the engine waits only for the listed steps; satellite is supporting evidence and never
  //     delays a decision.
  // The keys below exist only in this definition. The v1-legacy and v2 blocks above are frozen
  // (their hash covers every key); code reads POLICY_KEY_DEFAULTS when a key is absent.
  "v1.1-safe-ai": {
    id: "v1.1-safe-ai",
    description:
      "v1-legacy rules, except: an AI-only 'no damage' reading and technical failures hold for human review (never reject or ask for more evidence); the claim window is measured at first submission; satellite is never waited for.",
    gateEnabled: false,
    aiNoDamage: "review",
    aiNoDamageScope: "ai_only",
    technicalFailure: "hold",
    aiMalformedOutput: "unavailable",
    claimWindowReference: "firstSubmittedAt",
    engineWaitsFor: ["ai_assessment", "land_documents", "official_land_record", "weather"],
    reviewCaseOnHold: true,
    maxHoldHours: null,
    components: allOptional,
    ...SHARED_TUNING,
  },
};

// What a policy that does not define one of the v1.1 keys means by it: the historical behaviour.
//   aiNoDamageScope       null: the "review" hold applies to any rejection with a no-damage reading
//                         (v2 as shipped); "ai_only": only when the AI rule produced the rejection.
//   technicalFailure      "legacy": an unavailable assessment is an internal error (service) and
//                         `more_evidence_required` (engine); "hold": hold for retry or review.
//   aiMalformedOutput     "unsure": an unreadable answer is an uncertain photo; "unavailable": a
//                         retryable provider failure.
//   claimWindowReference  "decisionTime" or "firstSubmittedAt".
//   engineWaitsFor        null: every other queued step of the claim.
//   reviewCaseOnHold      false: a hold opens no review case by itself.
export const POLICY_KEY_DEFAULTS = Object.freeze({
  aiNoDamageScope: null,
  technicalFailure: "legacy",
  aiMalformedOutput: "unsure",
  claimWindowReference: "decisionTime",
  engineWaitsFor: null,
  reviewCaseOnHold: false,
});

// A policy setting with the legacy default applied. Works on any object shaped like a policy.
export const policySetting = (policy, key) =>
  policy && Object.prototype.hasOwnProperty.call(policy, key) && policy[key] !== undefined
    ? policy[key]
    : POLICY_KEY_DEFAULTS[key];

// Stable JSON: object keys sorted recursively so the hash never depends on key order.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const POLICY_IDS = Object.freeze(Object.keys(POLICY_DEFINITIONS));

// Returns the frozen policy with the environment rule knobs merged in, plus its content hash.
export const resolvePolicy = (id = env.claimVerificationPolicy) => {
  const definition = POLICY_DEFINITIONS[id];
  if (!definition) {
    throw new Error(`Unknown verification policy "${id}". Known: ${POLICY_IDS.join(", ")}`);
  }
  const rules = {
    claimWindowDays: env.claimWindowDays,
    claimAreaOverageFraction: env.claimAreaOverageFraction,
    claimOverlapToleranceM: env.claimOverlapToleranceM,
  };
  const body = { ...definition, rules };
  const hash = createHash("sha256").update(canonical(body)).digest("hex");
  return deepFreeze({ ...JSON.parse(JSON.stringify(body)), hash });
};

// Fail at startup (not at the first claim) when the configured policy id is unknown.
export const assertPolicyConfigured = () => resolvePolicy();

export default { COMPONENTS, COMPONENT_OUTCOMES, POLICY_IDS, POLICY_KEY_DEFAULTS, resolvePolicy, policySetting, assertPolicyConfigured };
