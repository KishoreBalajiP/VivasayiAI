import AIConfig from "./AIConfig.js";

// Formats stored session messages into a single conversation-history string.
// Rules (12_Technical_Guidelines: trim oldest first, preserve user/assistant ordering):
//  - messages are ordered as stored (user, ai, user, ai, ...) and that order is preserved;
//  - oldest messages are trimmed first when over the configured window/token budget;
//  - only the most recent AIConfig.chatHistoryWindow messages (3 user/AI pairs) are returned today,
//    preserving the current behavior exactly.

const roleLabel = (sender) => (sender === "user" ? "User" : "Assistant");

export const formatHistory = (messages, opts = {}) => {
  const list = Array.isArray(messages) && messages.length > 0 ? messages : [];
  const windowSize = Number(opts.window) || AIConfig.chatHistoryWindow;

  // Trim oldest first, preserve order.
  const recent = list.length > windowSize ? list.slice(list.length - windowSize) : list;

  // Token-budget guard: conservatively trim oldest messages if the estimated
  // token count would exceed the input budget (reserved for output tokens).
  const budgetTokens =
    Number(opts.maxInputTokens) || AIConfig.maxInputTokens;
  const reserve = Number(opts.reservedOutputTokens) || AIConfig.reservedOutputTokens;
  const available = Math.max(1, budgetTokens - reserve);
  const maxChars = available * (Number(opts.charsPerToken) || AIConfig.charsPerToken);

  let trimmed = recent.slice();
  let estimate = () =>
    trimmed.reduce((n, m) => n + (m?.text?.length || 0) + 20, 0);

  while (trimmed.length > 1 && estimate() > maxChars) {
    // Remove oldest (first user/assistant turn pair when possible).
    trimmed = trimmed.slice(trimmed.length - windowSize, trimmed.length);
    // Fallback: drop one message at a time from the front.
    if (estimate() > maxChars) trimmed = trimmed.slice(1);
  }

  return trimmed
    .map((m) => `${roleLabel(m.sender)}: ${m.text || ""}`.trim())
    .filter(Boolean)
    .join("\n");
};

export const historyCount = (messages) =>
  Array.isArray(messages) ? messages.length : 0;

export default { formatHistory, historyCount };
