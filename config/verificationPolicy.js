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
  // recorded. This is the default so enabling the new code changes no decision.
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
};

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

export default { COMPONENTS, COMPONENT_OUTCOMES, POLICY_IDS, resolvePolicy, assertPolicyConfigured };
