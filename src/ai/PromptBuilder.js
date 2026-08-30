import { getSystemPrompt } from "./SystemInstructions.js";
import { selectTemplate } from "./PromptTemplates.js";
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

export const promptConfig = {
  maxOutputTokens: AIConfig.maxOutputTokens,
};

export default { buildPrompt, buildFallbackPrompt, promptConfig };
