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

  // Crop-recommendation intent (no soil prerequisite). Routed BEFORE CLARIFICATIONS so a
  // general "which/what crop" question is answered from the available context instead of
  // triggering a clarifying soil/detail question. The model is told explicitly that soil
  // type is NOT a prerequisite — only an optional refinement — and that ungrounded crop
  // suitability must never be invented (grounding rules preserved).
  CROP_RECOMMENDATION:
    "You are a Tamil Nadu agricultural advisor recommending suitable crops. Base the recommendation on the labelled Context block (district, region type, weather, farm profile crops/area when known) and any agricultural knowledge base provided in this prompt. A general crop recommendation does NOT require soil type, so never ask for it first: proceed with what is known and, when soil is missing, offer it only as an optional refinement that could narrow the suggestion. If the available district or reference information is insufficient for a grounded recommendation, clearly state what is known and which additional details would improve the answer (for example the exact district, land size, or water availability) — do not invent crop suitability. If uncertain, end with the safety line to consult the local agricultural officer.",

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

// Intent vocabulary for crop-recommendation questions (English + Tamil). This detects the
// INTENT only — it is NOT crop/soil reference data and never fabricates suitability (the
// same E2-S2 rule as context.service.js's CROP_ALIASES). Routing here happens before the
// clarification heuristic so "what crop ..." questions are answered from context rather
// than bounced into a clarifying (soil) question.
const CROP_RECOMMENDATION_PATTERNS = Object.freeze([
  /\bwhat crop\b/,
  /\bwhich crop\b/,
  /\bwhat .* (to )?(grow|plant|sow|raise)\b/,
  /\bwhich .* (to )?(grow|plant|sow|raise)\b/,
  /\bcrop[s]? .*\b(good|suitable|best|recommend|suggested|workable)\b/,
  /\b(good|suitable|best|recommend|suggest) .*crop[s]?\b/,
  /\bcrop[s]? .* me\b/,
  /\bwhat can i (grow|plant|sow)\b/,
  /\bwhat should i (grow|plant|sow)\b/,
]);

const TAMIL_CROP_RECOMMENDATION_PATTERNS = Object.freeze([
  /எந்த பயிர்/,
  /என்ன பயிர்/,
  /பயிர்.*(நல்ல|சிறந்த|ஏற்ற|பரிந்துரை|வளர்க்க)/,
]);

const isCropRecommendation = (message) => {
  const m = (message || "").toLowerCase();
  if (TAMIL_CROP_RECOMMENDATION_PATTERNS.some((re) => re.test(m))) return true;
  return CROP_RECOMMENDATION_PATTERNS.some((re) => re.test(m));
};

// Lightweight intent selector (rule-based — no ML, no external services).
// The app is farming-only, so agriculture guidance is the safe default.
export const selectTemplate = (message) => {
  if (!message || !message.trim()) return TEMPLATES.FALLBACK_RESPONSE;
  if (isGreeting(message)) return TEMPLATES.GREETINGS;
  // Crop-recommendation intent wins over the broad clarification heuristic: a general
  // "which/what crop should I grow" question must not be routed into clarification.
  if (isCropRecommendation(message)) return TEMPLATES.CROP_RECOMMENDATION;
  if (isClarification(message)) return TEMPLATES.CLARIFICATIONS;
  return TEMPLATES.AGRICULTURE_GUIDANCE;
};

export { TEMPLATES };
export default TEMPLATES;
