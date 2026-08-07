// Modular prompt templates — one snippet per interaction type.
// These are appended to the system prompt as a "task focus" by PromptBuilder,
// so prompts are modular and intent-driven without any orchestration/provider layer.
// No personal data lives in these snippets; they are generic guidance strings only.

const TEMPLATES = Object.freeze({
  GENERAL_CHAT:
    "Respond naturally to the user's message. Keep the answer concise, friendly, and grounded in Tamil Nadu agriculture when relevant.",

  AGRICULTURE_GUIDANCE:
    "You are a Tamil Nadu agricultural advisor. Give practical, step-by-step advice: problem diagnosis first, then a clear recommended action with timings/dosage where applicable, and a 'consult your local agriculture officer' safety net if uncertain. End with a short encouragement.",

  PROPERTY_ASSISTANCE:
    "Assist with Tamil Nadu farmland/soil/crop-property questions: tenure, soil testing, land preparation, crop suitability per region, and resource planning. Use simple language.",

  GREETINGS:
    "Respond to a greeting warmly and briefly, then offer a one-line farming tip or ask how you can help with their crop today. Do not jump straight into advice.",

  CLARIFICATIONS:
    "The question is ambiguous or lacks detail. Ask a short, friendly clarifying question (what crop, what district, what symptom) so you can give accurate advice. Do not guess.",

  FALLBACK_RESPONSE:
    "You could not produce a reliable answer. Reply in the user's language with a brief apology and the safety line: 'மன்னிக்கவும், இந்த கேள்விக்கு பதிலில் பரிந்துர்க்க முடியவில்லை. உங்கள் பக்கத்து வேளாண்மை அலுவலரிடம் கேட்கவும்.' (Please consult your local agricultural officer.)",
});

const GREETING_WORDS = new Set([
  "hello", "hi", "hey", "namaste", "vanakkam", "good morning", "good evening",
  "good afternoon",
]);
// Tamil / Tanglish greetings kept short and language-agnostic.
const GREETING_TOKENS = ["வணக்கம்", "வணக்கம", "ஹல்லோ", "ஹாய்"];

const CLARIFICATION_SIGNALS = new Set([
  "what", "how", "tell me about", "explain", "?",
]);
const UNCLEAR_TOKENS = new Set([""]);

const isGreeting = (message) => {
  const m = (message || "").toLowerCase().trim();
  if (GREETING_TOKENS.some((t) => t.toLowerCase() === m)) return true;
  return [...GREETING_WORDS].some((g) => m === g || m.startsWith(g + " ") || m.startsWith(g + "!"));
};

const isClarification = (message) => {
  const m = (message || "").toLowerCase().trim();
  if (!m || !m.endsWith("?")) return false;
  // Very short questions with little context are treated as clarification-seekers.
  const tokens = m.replace(/[?.!]+/, "").split(/\s+/).filter(Boolean);
  return tokens.length <= 3 || [...CLARIFICATION_SIGNALS].some((s) => m.includes(s));
};

// Lightweight intent selector (rule-based — no ML, no external services).
// The app is farming-only, so agriculture guidance is the safe default.
export const selectTemplate = (message) => {
  if (!message || !message.trim()) return TEMPLATES.FALLBACK_RESPONSE;
  if (isGreeting(message)) return TEMPLATES.GREETINGS;
  if (isClarification(message)) return TEMPLATES.Clarifications;
  return TEMPLATES.AGRICULTURE_GUIDANCE;
};

export { TEMPLATES };
export default TEMPLATES;
