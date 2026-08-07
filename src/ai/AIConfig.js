import { env } from "../../config/env.js";

// Centralized AI runtime configuration.
// All AI constants live here (12_Technical_Guidelines §2 #6: "no magic numbers").
// Defaults preserve today's hardcoded values so behaviour is unchanged until explicitly tuned.

const AIConfig = Object.freeze({
  provider: process.env.MODEL_PROVIDER || env.modelProvider || "gemini",
  model: process.env.MODEL_NAME || env.modelName || "gemini-2.5-flash",
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) || 2048,

  // Conversation context budget.
  chatHistoryWindow: Number(process.env.CHAT_HISTORY_MESSAGES) || 6, // 3 user/AI pairs today
  maxInputTokens: Number(process.env.MAX_INPUT_TOKENS) || 8192,
  reservedOutputTokens: Number(process.env.RESERVED_OUTPUT_TOKENS) || 512,
  // Approximate chars -> tokens ratio used for conservative history trimming.
  charsPerToken: 4,

  // RAG retrieval size (preserves today's nResults = 3).
  ragTopK: Number(process.env.RAG_TOP_K) || 3,

  embeddingModel: process.env.EMBEDDING_MODEL || "embed-english-v3.0",
});

export default AIConfig;
