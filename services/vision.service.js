import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import { model } from "./chat.service.js";
import { VISION_INSTRUCTIONS } from "../src/ai/ImageDiagnosisTemplates.js";

// E3 (D-24): vision analysis stage. Runs a single multimodal Gemini call against the
// normalized image using the SAME model instance as text chat (AIConfig.model). Output is
// parsed into a normalized, structured observation object.
//
// Failure handling:
//  - API/network errors (model down, provider error) are real failures: rethrown as a
//    sanitized 500 — never downgraded into a fake "unclear" diagnosis.
//  - A successful call that returns unparseable/empty output (e.g. refused or garbage
//    response to a non-agricultural photo) degrades to a conservative UNSURE_OBSERVATION:
//    uncertainty is explicit, nothing is invented, and the reasoning stage tells the farmer
//    the photo could not be reliably analyzed.
//
// IMAGE_AI_MODE=mock is a dev/test-only seam (documented in .env.example) returning a
// deterministic canned observation so regression suites do not depend on external AI.

const UNSURE_OBSERVATION = Object.freeze({
  crop: null,
  symptoms: [],
  likelyIssues: [],
  confidence: "unclear",
  uncertain: true,
  summary: null,
});

// Deterministic observation used when IMAGE_AI_MODE=mock (dev/test only).
const MOCK_OBSERVATION = Object.freeze({
  crop: "rice",
  symptoms: [
    "yellowing of lower leaves",
    "small brownish spots on leaf blades",
  ],
  likelyIssues: [
    {
      name: "Nitrogen deficiency",
      type: "deficiency",
      confidence: "medium",
      evidence: ["uniform yellowing of older leaves"],
    },
    {
      name: "Brown spot suspected",
      type: "disease",
      confidence: "low",
      evidence: ["small brownish spots visible on blades"],
    },
  ],
  confidence: "medium",
  uncertain: false,
  summary:
    "Rice field showing mild yellowing of lower leaves with sparse brownish spots on the blades.",
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

const pickEnum = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

const cleanText = (value, max) =>
  value == null ? null : String(value).trim().slice(0, max);

const normalizeObservation = (raw) => {
  const issues = Array.isArray(raw.likelyIssues)
    ? raw.likelyIssues.slice(0, 3).map((issue) => ({
        name: cleanText(issue?.name, 120) || "Unknown",
        type: pickEnum(issue?.type, ["pest", "disease", "deficiency", "environmental", "other"], "other"),
        confidence: pickEnum(issue?.confidence, ["high", "medium", "low", "uncertain"], "low"),
        evidence: Array.isArray(issue?.evidence)
          ? issue.evidence.slice(0, 5).map((e) => cleanText(e, 200)).filter(Boolean)
          : [],
      }))
    : [];

  return {
    crop: cleanText(raw.crop, 120),
    symptoms: Array.isArray(raw.symptoms)
      ? raw.symptoms.slice(0, 6).map((s) => cleanText(s, 200)).filter(Boolean)
      : [],
    likelyIssues: issues,
    confidence: pickEnum(raw.confidence, ["high", "medium", "low", "unclear"], "unclear"),
    uncertain: raw.uncertain !== false,
    summary: cleanText(raw.summary, 400),
  };
};

export const analyzeImage = async ({ imageBuffer, mediaType }) => {
  if (env.imageAiMode === "mock") {
    return { ...MOCK_OBSERVATION };
  }

  try {
    const messages = [
      new SystemMessage(VISION_INSTRUCTIONS),
      new HumanMessage({
        content: [
          {
            type: "text",
            text: "Analyze the attached crop photo and return the observation JSON.",
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
      logger.warn("Vision output was not parseable as JSON; marking image as unclear");
      return { ...UNSURE_OBSERVATION };
    }
    return normalizeObservation(parsed);
  } catch (error) {
    logger.error({ err: error }, "Vision analysis failed");
    throw ApiError.internal("Failed to analyze the image");
  }
};

export default { analyzeImage };