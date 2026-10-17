import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import logger from "../utils/logger.js";
import { env } from "../config/env.js";
import { model } from "./chat.service.js";
import { withAiTimeout, AiTimeoutError, getDefaultTimeoutMs } from "../utils/aiTimeout.js";
import { ProviderError, toProviderError, logProviderError, PROVIDER_ERROR_KINDS } from "../utils/providerErrors.js";
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
//    The error is a ProviderError (utils/providerErrors.js) whose `kind` says why (quota, timeout,
//    …); the HTTP status and message are unchanged.
//  - A successful call returning unparseable output degrades to a conservative UNSURE
//    observation (`onUnparseable: "unsure"`, the default): uncertainty is explicit, nothing is
//    invented. With `onUnparseable: "throw"` (policy v1.1-safe-ai, `aiMalformedOutput:
//    "unavailable"`) it is instead a retryable `malformed_response` failure, so an unreadable
//    answer can never become a request for more evidence.
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

const VISION_FAILURE_MESSAGE = "Failed to analyze claim evidence image";
const VISION_CONTEXT = { provider: "gemini", operation: "claim.vision_analyze" };

// `timeoutMs` lets the caller (claimAssessment) shrink a single call to whatever remains of the
// request's overall time budget, so N sequential evidence images can never accumulate past the
// API Gateway / Lambda ceiling. Omitted -> the shared GEMINI default. `onUnparseable` ("unsure" |
// "throw") decides what an answer that is not the observation JSON becomes (see above).
export const analyzeClaimImage = async ({ imageBuffer, mediaType, timeoutMs, onUnparseable = "unsure" }) => {
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

    // Effective bound is the TIGHTER of the shared per-call default and whatever budget the
    // caller says is left. Callers may only ever shorten a call, never extend it past the
    // configured per-call ceiling.
    const effectiveTimeoutMs = Math.min(
      getDefaultTimeoutMs(),
      typeof timeoutMs === "number" ? timeoutMs : Number.POSITIVE_INFINITY,
    );

    const result = await withAiTimeout(
      () => model.generate([messages]),
      "claim.vision_analyze",
      effectiveTimeoutMs,
    ).catch((err) => {
      if (err instanceof AiTimeoutError) {
        throw new ProviderError({ kind: PROVIDER_ERROR_KINDS.TIMEOUT, ...VISION_CONTEXT, statusCode: 500, message: "AI service did not respond in time" });
      }
      throw err;
    });
    const text = result.generations?.[0]?.[0]?.text || "";

    const parsed = extractJson(text);
    const normalized = parsed ? normalizeClaimObservation(parsed) : null;
    if (!normalized) {
      if (onUnparseable === "throw") {
        throw new ProviderError({ kind: PROVIDER_ERROR_KINDS.MALFORMED, ...VISION_CONTEXT, statusCode: 500, message: VISION_FAILURE_MESSAGE });
      }
      logger.warn("Claim evidence vision output was not parseable as JSON; marking image as unclear");
      return { ...UNSURE_CLAIM_OBSERVATION };
    }
    return normalized;
  } catch (error) {
    // Codes only: never the provider's message body, the prompt or the image.
    const providerError = toProviderError(error, VISION_CONTEXT);
    logProviderError(logger, providerError);
    // Same sanitized 500 envelope as before, now carrying the failure kind for the queue.
    throw new ProviderError({
      kind: providerError.kind,
      ...VISION_CONTEXT,
      httpStatus: providerError.httpStatus,
      statusCode: 500,
      message: VISION_FAILURE_MESSAGE,
    });
  }
};

export default { analyzeClaimImage, normalizeClaimObservation };