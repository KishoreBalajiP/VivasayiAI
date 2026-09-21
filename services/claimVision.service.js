import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import { model } from "./chat.service.js";
import {
  CLAIM_LOSS_VISION_INSTRUCTIONS,
  CLAIM_LOSS_OBSERVATION_FIELDS,
  CLAIM_LOSS_DAMAGE_TYPES,
  CLAIM_LOSS_SEVERITIES,
  CLAIM_LOSS_CONFIDENCE_LEVELS,
  CLAIM_LOSS_IMAGE_QUALITY_LEVELS,
  CLAIM_LOSS_PROHIBITED_MARKERS,
} from "../src/ai/ClaimLossVisionTemplates.js";

// E9-S4 (ADR-019): claim-loss evidence assessment — single multimodal Gemini call against ONE
// normalized evidence image. Reuses the SAME model instance as text chat and the image
// diagnosis pipeline (services/chat.service.js `model`), so there is no second provider client.
// The prompt is the dedicated claim-loss template (`src/ai/ClaimLossVisionTemplates.js`, 09 §6.1
// prompt isolation); the output is normalized to the FROZEN observation contract with strict
// whitelist validation (unknown/prohibited fields stripped).
//
// Failure handling (mirrors services/vision.service.js):
//  - Provider/API/timeout errors are REAL failures: rethrown as sanitized 500 — the assessment
//    service then marks the assessment failed (retryable). Never downgraded into a fake result.
//  - A successful call returning unparseable output degrades to a conservative UNSURE
//    observation: uncertainty is explicit, nothing is invented.
//
// IMAGE_AI_MODE=mock is the existing dev/test-only seam (.env.example) returning a deterministic
// canned claim observation so regression suites never depend on external AI.

const UNSURE_CLAIM_OBSERVATION = Object.freeze({
  cropDetected: null,
  damageDetected: null,
  damageType: null,
  severity: null,
  visibleAffectedPortion: null,
  confidence: "unclear",
  uncertain: true,
  inconsistencies: ["Image could not be reliably analyzed"],
  observations: [],
  imageQuality: "unclear",
});

// Deterministic observation used when IMAGE_AI_MODE=mock (dev/test only).
const MOCK_CLAIM_OBSERVATION = Object.freeze({
  cropDetected: "rice",
  damageDetected: true,
  damageType: "flood",
  severity: "moderate",
  visibleAffectedPortion:
    "lower portion of the visible field shows standing water with lodged plants",
  confidence: "medium",
  uncertain: false,
  inconsistencies: [],
  observations: [
    "standing water in the furrows",
    "lodged rice plants near the water line",
    "dry crop visible in the upper portion of the image",
  ],
  imageQuality: "good",
});

const extractJson = (text) => {
  if (!text || !String(text).trim()) return null;
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

const cleanText = (value, max) =>
  value == null ? null : String(value).trim().slice(0, max);

const cleanTextArray = (value, maxCount, maxChars) =>
  Array.isArray(value)
    ? value
        .slice(0, maxCount)
        .map((item) => cleanText(item, maxChars))
        .filter(Boolean)
    : [];

const pickEnum = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

const isBoolean = (value) => typeof value === "boolean";

// Fisher-protection: true when a top-level output key signals a FROZEN-authorized semantic
// field. Everything not in the frozen whitelist is dropped by construction.
const isFrozenKey = (key) => CLAIM_LOSS_OBSERVATION_FIELDS.includes(key);

const hitProhibitedMarker = (key) => {
  const lower = String(key).toLowerCase();
  return CLAIM_LOSS_PROHIBITED_MARKERS.some((marker) => lower.includes(marker));
};

// Strict normalizer for the FROZEN claim-loss observation. Whitelist-only: any key outside
// CLAIM_LOSS_OBSERVATION_FIELDS is dropped; a dropped key matching a prohibited business-field
// marker (acreage/polygon/compensation/status/…) additionally marks the observation uncertain
// and records a deterministic inconsistency so the tamper is visible in the audit trail. This
// never coerce arbitrary text into a business value.
export const normalizeClaimObservation = (raw) => {
  if (!raw || typeof raw !== "object") return null;

  let uncertain = raw.uncertain !== false;
  const guardrailNotes = [];

  for (const key of Object.keys(raw)) {
    if (!isFrozenKey(key)) {
      if (hitProhibitedMarker(key)) {
        uncertain = true;
        guardrailNotes.push(
          `Model output contained an unauthorized field ("${key}"); it was removed and never persisted`
        );
      }
      // Unknown (non-prohibited) extra fields are silently stripped per the schema policy.
    }
  }

  const inconsistArray = cleanTextArray(raw.inconsistencies, 3, 200).concat(guardrailNotes);

  return {
    cropDetected: cleanText(raw.cropDetected, 120),
    damageDetected: isBoolean(raw.damageDetected) ? raw.damageDetected : null,
    damageType: pickEnum(raw.damageType, CLAIM_LOSS_DAMAGE_TYPES, null),
    severity: pickEnum(raw.severity, CLAIM_LOSS_SEVERITIES, null),
    visibleAffectedPortion: cleanText(raw.visibleAffectedPortion, 300),
    confidence: pickEnum(raw.confidence, CLAIM_LOSS_CONFIDENCE_LEVELS, "unclear"),
    uncertain,
    inconsistencies: inconsistArray,
    observations: cleanTextArray(raw.observations, 5, 200),
    imageQuality: pickEnum(raw.imageQuality, CLAIM_LOSS_IMAGE_QUALITY_LEVELS, "unclear"),
  };
};

export const analyzeClaimImage = async ({ imageBuffer, mediaType }) => {
  if (env.imageAiMode === "mock") {
    return { ...MOCK_CLAIM_OBSERVATION };
  }

  try {
    const messages = [
      new SystemMessage(CLAIM_LOSS_VISION_INSTRUCTIONS),
      new HumanMessage({
        content: [
          {
            type: "text",
            text: "Analyze the attached claim evidence image and return the observation JSON.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${mediaType};base64,${imageBuffer.toString("base64")}`,
            },
          },
        ],
      }),
    ];

    const result = await model.generate([messages]);
    const text = result.generations?.[0]?.[0]?.text || "";

    const parsed = extractJson(text);
    if (!parsed) {
      logger.warn("Claim evidence vision output was not parseable as JSON; marking image as unclear");
      return { ...UNSURE_CLAIM_OBSERVATION };
    }

    const normalized = normalizeClaimObservation(parsed);
    return normalized || { ...UNSURE_CLAIM_OBSERVATION };
  } catch (error) {
    logger.error({ err: error }, "Claim evidence vision analysis failed");
    throw ApiError.internal("Failed to analyze claim evidence image");
  }
};

export default { analyzeClaimImage, normalizeClaimObservation };