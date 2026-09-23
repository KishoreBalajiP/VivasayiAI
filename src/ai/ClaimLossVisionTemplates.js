// E9-S4 (ADR-019 / 09_AI_Architecture §6.1): claim-loss evidence assessment prompt templates.
//
// Static prompt text ONLY — this module never concatenates user data (single-source prompt
// construction convention from 12_Technical_Guidelines §2; claim prompts live SEPARATELY from
// the chat `ImageDiagnosisTemplates.js`/`PromptBuilder.js` prompts so chat context never leaks
// into claim decisions — 09 §6.1 `Prompt isolation`). The only injected values at call time are
// the image bytes and the normalized media type, both server-owned (services/claimVision.service.js).
//
// The AI observation contract is FROZEN (ADR-019 `Frozen boundaries`): the model may output
// exactly the `CLAIM_LOSS_OBSERVATION_FIELDS` below and nothing else. Prohibited fields
// (acreage/polygon/boundary/area/compensation/remaining/approval/status) are stripped by the
// normalizer and never persisted. See PHASE_4_FINAL_REPORT.md and 07_Database_Design §8.

// Assessment configuration/version boundary (§13). Bump this when the prompt or the frozen
// schema changes so assessments produced under different versions are distinguishable. No
// model registry — this is the single version identifier, documented in 07 §8.
export const CLAIM_LOSS_ASSESSMENT_VERSION = "1";

// The exact set of semantic fields the AI may produce (ADR-019 frozen boundary).
export const CLAIM_LOSS_OBSERVATION_FIELDS = Object.freeze([
  "cropDetected",
  "damageDetected",
  "damageType",
  "severity",
  "visibleAffectedPortion",
  "confidence",
  "uncertain",
  "inconsistencies",
  "observations",
  "imageQuality",
]);

// Controlled vocabularies (documented in 07 §8). `null` is always allowed = "cannot be
// determined from this evidence". damageType mirrors CLAIM_EVENT_TYPES so the visual
// classification stays on the same vocabulary the claim already uses.
export const CLAIM_LOSS_DAMAGE_TYPES = Object.freeze([
  "flood",
  "storm",
  "drought",
  "fire",
  "pest",
  "disease",
  "other",
]);

export const CLAIM_LOSS_SEVERITIES = Object.freeze([
  "minor",
  "moderate",
  "severe",
]);

export const CLAIM_LOSS_CONFIDENCE_LEVELS = Object.freeze([
  "high",
  "medium",
  "low",
  "unclear",
]);

export const CLAIM_LOSS_IMAGE_QUALITY_LEVELS = Object.freeze([
  "good",
  "fair",
  "poor",
  "unclear",
]);

// Key-name markers that indicate the model tried to output an authoritative/business field.
// Used by the normalizer (not the prompt) as a tripwire: any such field is removed and never
// persisted, the observation is marked uncertain, and an inconsistency note is recorded.
export const CLAIM_LOSS_PROHIBITED_MARKERS = Object.freeze([
  "acre",
  "polygon",
  "boundary",
  "compens",
  "amount",
  "payout",
  "approved",
  "rejected",
  "approval",
  "eligible",
  "remaining",
  "final",
  "decision",
  "status",
]);

export const CLAIM_LOSS_VISION_INSTRUCTIONS = `
You are the visual-evidence assessment step of an agricultural loss / affected-area claim
verification system. You analyze ONE farmer-submitted evidence image of cropland after a
reported damaging event (flood, storm, drought, fire, pest, or disease).

Your ONLY job is to record structured observations about what is actually VISIBLE in this
single image. You never decide the outcome of the claim. Record ONLY evidence-supported
observations. Never guess, never invent symptoms, and never fabricate detail that is not in
the photo.

Respond with a single JSON object (no commentary, no markdown fences, no code block) matching
EXACTLY this shape and nothing else:

{
  "cropDetected": "crop/plant type if clearly identifiable, otherwise null",
  "damageDetected": true,
  "damageType": "flood | storm | drought | fire | pest | disease | other",
  "severity": "minor | moderate | severe",
  "visibleAffectedPortion": "a qualitative description of the visibly affected area within the
                             image, e.g. 'lower portion of the field shows standing water'",
  "confidence": "high | medium | low | unclear",
  "uncertain": true,
  "inconsistencies": ["specific contradictions or reasons this image alone cannot support a
                       classification; empty when nothing conflicts"],
  "observations": ["short factual statements about what is visible, e.g. 'yellowing of lower
                    leaves', 'standing water in the furrows'"],
  "imageQuality": "good | fair | poor | unclear"
}

Rules:
- Use null for any field that cannot be determined from THIS image. Never force a guess.
- When the damage is not visible or is not identifiable, set damageDetected false and any
  unclassifiable fields (damageType, severity) to null.
- severity is QUALITATIVE and based only on the visible evidence. It is NOT an area or acreage
  measurement.
- "visibleAffectedPortion" describes what fraction of THIS IMAGE's field appears affected, in
  everyday qualitative words. It is NOT an acreage measurement and NOT the claimed area; one
  image does not represent the entire claimed field.
- Explicitly report any uncertainty: blurry or poorly lit image, unidentifiable crop, damage not
  visible, insufficient evidence, or an image that appears unrelated to agriculture.
- List at most 5 observations and at most 3 inconsistencies, strongest first. Every observation
  must describe something actually visible; otherwise omit it.
- If the image cannot be reliably analyzed, set confidence to "unclear", uncertain to true, and
  leave unclassifiable fields null. Do not pretend you saw something.
- DO NOT estimate acreage, affected acres, or any area quantity.
- DO NOT infer the parcel boundary or polygon.
- DO NOT estimate compensation or monetary loss.
- DO NOT state a final claim outcome (approved, rejected, out of limit, duplicate, etc.).
- Respond with pure JSON only.
`;