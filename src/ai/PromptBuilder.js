import { getSystemPrompt } from "./SystemInstructions.js";
import { selectTemplate } from "./PromptTemplates.js";
import { IMAGE_DIAGNOSIS_FOCUS } from "./ImageDiagnosisTemplates.js";
import { formatHistory } from "./ConversationFormatter.js";
import AIConfig from "./AIConfig.js";
import ApiError from "../../utils/ApiError.js";

// Single source of prompt construction. Controllers/services must never manually
// concatenate prompts (12_Technical_Guidelines: "No duplicated prompt logic").
//
// Builds:
//   [ { role: 'system', content }, { role: 'user', content } ]
// History + RAG context are embedded in the system content — identical to the
// current prompt shape so model behaviour is preserved. The Context Engine slice
// (E2-S3, services/context.service.js) supplies `assembledContext` — a labelled
// plain-text Context block injected into the system content (ADR-014, D-03).

const buildHistoryBlock = (history) => {
  const text = formatHistory(history);
  return text
    ? `\n\nPrevious conversation context:\n${text}\n\nRemember this conversation history and provide contextually relevant responses.`
    : "";
};

const buildContextBlock = (context) => {
  const text = context && Array.isArray(context)
    ? context.filter(Boolean).join("\n\n")
    : context ? String(context) : "";
  return text
    ? `\n\nRelevant agricultural knowledge base:\n${text}\n\nUse this information to provide accurate, data-driven advice.`
    : "";
};

const buildAssembledContextBlock = (assembledContext) =>
  assembledContext && String(assembledContext).trim()
    ? `\n\n${String(assembledContext).trim()}`
    : "";

export const buildPrompt = ({ userMessage, history, context, template, assembledContext }) => {
  if (!userMessage || !String(userMessage).trim()) {
    throw ApiError.badRequest("Message is required");
  }

  const focus = template || selectTemplate(userMessage);
  const system =
    getSystemPrompt() +
    `\n\nTask focus: ${focus}` +
    buildHistoryBlock(history || []) +
    buildAssembledContextBlock(assembledContext);

  if (context) {
    // RAG succeeded path — context block is appended (mirrors current behaviour).
    return [
      { role: "system", content: system + buildContextBlock(context) },
      { role: "user", content: String(userMessage).trim() },
    ];
  }

  // Fallback path (no RAG context) — no knowledge-base block.
  return [
    { role: "system", content: system },
    { role: "user", content: String(userMessage).trim() },
  ];
};

export const buildFallbackPrompt = ({ userMessage, history, assembledContext }) => {
  // RAG failure recovery: system + history only (matches current fallback path).
  const focus = selectTemplate(userMessage);
  return [
    {
      role: "system",
      content:
        getSystemPrompt() +
        `\n\nTask focus: ${focus}` +
        buildHistoryBlock(history || []) +
        buildAssembledContextBlock(assembledContext),
    },
    { role: "user", content: String(userMessage || "").trim() },
  ];
};

// E3 (D-22/D-24): stage-2 reasoning prompt for an image diagnosis turn. The vision stage
// (services/vision.service.js) already produced a structured `observation`; this builds the
// farmer-facing reasoning prompt: base system instructions + an explicit language rule
// (image-only turns have no message text to infer language from) + conversation history +
// assembled farm context + the observation JSON + RAG knowledge base. User-derived values
// are injected here — never concatenated in services.
export const buildImageDiagnosisPrompt = ({
  observation,
  userMessage,
  history,
  context,
  assembledContext,
  language,
}) => {
  const focus = IMAGE_DIAGNOSIS_FOCUS;

  const languageRule =
    language === "ta"
      ? `\n\nThe farmer expects a reply in Tamil. Respond completely in Tamil, using natural local expressions and Tamil script.`
      : language === "en"
        ? `\n\nThe farmer expects a reply in English. Respond in simple, clear English suitable for rural users.`
        : "";

  const observationBlock = observation
    ? `\n\nMachine vision observation from the attached photo (JSON):\n${JSON.stringify(observation)}\n\nUse this observation as evidence, but only claim what you can support. If the observation is unclear, say so and ask for a better photo instead of guessing.`
    : "";

  const system =
    getSystemPrompt() +
    `\n\nTask focus: ${focus}` +
    languageRule +
    buildHistoryBlock(history || []) +
    buildAssembledContextBlock(assembledContext) +
    observationBlock;

  const userContent =
    userMessage && String(userMessage).trim()
      ? String(userMessage).trim()
      : "Look at the attached crop photo and help me.";

  if (context) {
    return [
      { role: "system", content: system + buildContextBlock(context) },
      { role: "user", content: userContent },
    ];
  }

  return [{ role: "system", content: system }, { role: "user", content: userContent }];
};

export const promptConfig = {
  maxOutputTokens: AIConfig.maxOutputTokens,
};

export default { buildPrompt, buildFallbackPrompt, buildImageDiagnosisPrompt, promptConfig };
