// Modular prompt templates — one snippet per interaction type.
// These are appended to the system prompt as a "task focus" by PromptBuilder,
// so prompts are modular and intent-driven without any orchestration/provider layer.
// No personal data lives in these snippets; they are generic guidance strings only.
import { classifyIntent, INTENTS } from "./Intent.js";

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
    "The message is too short to tell what the farmer needs. Ask ONE short, friendly question about what they want help with. Do not guess, and do not ask for details the Context already lists as known.",

  CLAIM_SUPPORT:
    "You are helping a farmer understand their crop-loss claim. Use only the claim records in the Context block. Explain the status in simple words and say what the farmer can do next. Never promise approval, an amount of compensation, or a timeline, and never state a reason for a decision that is not in the Context. If the records do not answer the question, say so and suggest contacting the agriculture office.",

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

// Template selection is driven by the intent classifier (src/ai/Intent.js), which also decides which
// context to load and whether a follow-up question is justified. A message is NOT routed to
// "ask a clarifying question" merely because it ends with a question mark: that rule sent nearly
// every real question into a clarification loop.
export const selectTemplate = (message) => {
  switch (classifyIntent(message)) {
    case INTENTS.GREETING:
      return TEMPLATES.GREETINGS;
    case INTENTS.CLAIM_STATUS:
      return TEMPLATES.CLAIM_SUPPORT;
    case INTENTS.CROP_RECOMMENDATION:
      return TEMPLATES.CROP_RECOMMENDATION;
    case INTENTS.UNCLEAR:
      return message && message.trim() ? TEMPLATES.CLARIFICATIONS : TEMPLATES.FALLBACK_RESPONSE;
    default:
      // The app is farming-only, so agriculture guidance is the safe default.
      return TEMPLATES.AGRICULTURE_GUIDANCE;
  }
};

export { TEMPLATES };
export default TEMPLATES;
