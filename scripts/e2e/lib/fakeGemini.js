// Fake Gemini for the hermetic e2e harness (ADR-024, design-testing X2/§2.1 step 6).
//
// The harness keeps IMAGE_AI_MODE=live, so the REAL claim-vision and land-document code paths run
// (prompt, timeout, parsing, provider-error classification, the queue's retries). Only the model call
// itself is replaced: `model.generate` on the shared instance exported by services/chat.service.js,
// the same seam scripts/live/lib/liveCommon.js instrumentModel uses. Nothing here touches the network.
//
// Which prompt is it? The SystemMessage text is compared with the REAL prompt constants
// (CLAIM_LOSS_VISION_INSTRUCTIONS, LAND_DOCUMENT_SYSTEM_INSTRUCTIONS), never with a copy.
//
// Photo (claim-vision) modes, set by POST /__e2e/scenario {ai}:
//   damage | no_damage | uncertain       a valid observation JSON
//   q429                                 throws an SDK-shaped GoogleGenerativeAIFetchError, status 429 RESOURCE_EXHAUSTED
//   q503                                 the same shape, status 503 "The model is overloaded"
//   timeout                              answers only after the per-image timeout has passed
//   malformed | empty                    "not json" / an empty answer
//   failN:<mode>:<n>                     <mode> for the first n photo calls, then `damage`
// Land-document modes ({landDocument}): ok (a normalised extraction naming the farmer), unreadable,
// q429, q503, timeout, malformed. Any other prompt (chat) gets a short fixed text.

export const AI_BASE_MODES = Object.freeze(["damage", "no_damage", "uncertain", "q429", "q503", "timeout", "malformed", "empty"]);
export const FAILING_AI_MODES = Object.freeze(["q429", "q503", "timeout", "malformed", "empty"]);
export const LAND_DOCUMENT_MODES = Object.freeze(["ok", "unreadable", "q429", "q503", "timeout", "malformed"]);
export const DEFAULT_FARMER_NAME = "Murugan Selvam";

const FAIL_N = /^failN:([a-z0-9_]+):(\d{1,3})$/;

// "damage" -> { mode: "damage" }; "failN:q429:2" -> { mode: "failN", failMode: "q429", count: 2 }; else null.
export const parseAiMode = (value) => {
  const text = String(value ?? "").trim();
  if (AI_BASE_MODES.includes(text)) return { mode: text };
  const match = FAIL_N.exec(text);
  if (match && FAILING_AI_MODES.includes(match[1])) return { mode: "failN", failMode: match[1], count: Number(match[2]) };
  return null;
};

export const OBSERVATIONS = Object.freeze({
  damage: {
    cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate",
    visibleAffectedPortion: "lower portion of the visible field shows standing water with lodged plants",
    confidence: "high", uncertain: false, inconsistencies: [],
    observations: ["standing water in the furrows", "lodged rice plants near the water line"], imageQuality: "good",
  },
  no_damage: {
    cropDetected: "rice", damageDetected: false, damageType: null, severity: null, visibleAffectedPortion: null,
    confidence: "high", uncertain: false, inconsistencies: [], observations: ["healthy green canopy"], imageQuality: "good",
  },
  uncertain: {
    cropDetected: "rice", damageDetected: true, damageType: "flood", severity: "moderate", visibleAffectedPortion: "unclear",
    confidence: "low", uncertain: true, inconsistencies: ["image too dark to judge"], observations: [], imageQuality: "fair",
  },
});

export const landDocumentExtraction = ({ holderNames = [DEFAULT_FARMER_NAME], district = "Thanjavur" } = {}) => ({
  documentType: "land_record", issuingAuthority: "Revenue Department, Government of Tamil Nadu", recordNumber: "E2E-PATTA-0042",
  state: "Tamil Nadu", district, taluk: "Thanjavur", village: "Vallam", surveyNumber: "123/4A", subdivisionNumber: "2",
  holderNames, parcelExtent: null, extentUnit: "acre", documentDate: "2024-03-01", additionalIdentifiers: [],
  unreadable: false, language: "ta", confidence: "high", imageQuality: "good", uncertainFields: [],
});

// --- SDK-shaped provider errors -------------------------------------------------------------------

let SdkFetchError = null;
try {
  // The class the real client throws (a dependency of @langchain/google-genai). If it is ever absent,
  // a look-alike with the same name and fields is used instead.
  ({ GoogleGenerativeAIFetchError: SdkFetchError } = await import("@google/generative-ai"));
} catch {
  SdkFetchError = null;
}
class FakeFetchError extends Error {
  constructor(message, status, statusText, errorDetails) {
    super(`[GoogleGenerativeAI Error]: ${message}`);
    this.name = "GoogleGenerativeAIFetchError";
    this.status = status;
    this.statusText = statusText;
    this.errorDetails = errorDetails;
  }
}
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
export const providerError = (mode) => {
  const Fetch = SdkFetchError || FakeFetchError;
  if (mode === "q429") {
    return new Fetch(
      `Error fetching from ${ENDPOINT}: [429 Too Many Requests] Resource has been exhausted (e.g. check quota).`,
      429,
      "Too Many Requests",
      [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] },
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RESOURCE_EXHAUSTED", domain: "googleapis.com" },
      ]
    );
  }
  return new Fetch(`Error fetching from ${ENDPOINT}: [503 Service Unavailable] The model is overloaded. Please try again later.`, 503, "Service Unavailable", []);
};

// --- the fake ----------------------------------------------------------------------------------------

const answer = (text) => ({
  generations: [[{ text, message: { content: text, usage_metadata: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }, generationInfo: { finishReason: "STOP" } }]],
  llmOutput: { fake: true },
});

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === "function") timer.unref();
});

const systemTextOf = (conversations) => {
  const conversation = Array.isArray(conversations) ? conversations[0] : null;
  const first = Array.isArray(conversation) ? conversation[0] : null;
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (first.lc_kwargs && typeof first.lc_kwargs.content === "string") return first.lc_kwargs.content;
  return "";
};

// `prompts` = { claimVision, landDocument } (the real constants). `timeoutMs()` is how long a
// "timeout" answer takes: longer than the per-image budget, so the real AiTimeoutError path fires.
export const createFakeGemini = ({ prompts, timeoutMs = () => Number(process.env.E2E_FAKE_TIMEOUT_MS) || 8000 } = {}) => {
  if (!prompts || typeof prompts.claimVision !== "string" || typeof prompts.landDocument !== "string") {
    throw new Error("createFakeGemini needs the real claim-vision and land-document prompt constants");
  }
  const state = { ai: "damage", landDocument: "ok", holderNames: [DEFAULT_FARMER_NAME], version: 0, failuresServed: 0, calls: { claim_vision: 0, land_document: 0, other: 0 } };

  const classify = (conversations) => {
    const text = systemTextOf(conversations);
    if (text === prompts.claimVision) return "claim_vision";
    if (text === prompts.landDocument) return "land_document";
    return "other";
  };

  const failWith = async (mode) => {
    if (mode === "q429" || mode === "q503") throw providerError(mode);
    if (mode === "timeout") {
      await sleep(timeoutMs());
      return answer(JSON.stringify(OBSERVATIONS.damage));
    }
    if (mode === "malformed") return answer("I looked at the photo but I cannot give the JSON object you asked for.");
    if (mode === "empty") return answer("");
    return null;
  };

  const generate = async (conversations) => {
    const kind = classify(conversations);
    state.calls[kind] += 1;
    if (kind === "claim_vision") {
      const parsed = parseAiMode(state.ai) || { mode: "damage" };
      if (parsed.mode === "failN") {
        if (state.failuresServed < parsed.count) {
          state.failuresServed += 1;
          return failWith(parsed.failMode);
        }
        return answer(JSON.stringify(OBSERVATIONS.damage));
      }
      if (OBSERVATIONS[parsed.mode]) return answer(JSON.stringify(OBSERVATIONS[parsed.mode]));
      return failWith(parsed.mode);
    }
    if (kind === "land_document") {
      const mode = LAND_DOCUMENT_MODES.includes(state.landDocument) ? state.landDocument : "ok";
      if (mode === "ok") return answer(JSON.stringify(landDocumentExtraction({ holderNames: state.holderNames })));
      if (mode === "unreadable") return answer(JSON.stringify({ ...landDocumentExtraction({ holderNames: [] }), unreadable: true, confidence: "unclear", imageQuality: "unreadable" }));
      if (mode === "timeout") {
        await sleep(timeoutMs());
        return answer(JSON.stringify(landDocumentExtraction({ holderNames: state.holderNames })));
      }
      return failWith(mode);
    }
    return answer("This is the hermetic e2e model. Chat is not exercised by the e2e suite.");
  };

  // Set the scenario. A new scenario (any call) restarts the failN counter.
  const configure = ({ ai, landDocument, holderNames } = {}) => {
    if (ai !== undefined) {
      if (!parseAiMode(ai)) throw Object.assign(new Error(`Unknown ai mode: ${ai}`), { statusCode: 400 });
      state.ai = String(ai);
    }
    if (landDocument !== undefined) {
      if (!LAND_DOCUMENT_MODES.includes(landDocument)) throw Object.assign(new Error(`Unknown landDocument mode: ${landDocument}`), { statusCode: 400 });
      state.landDocument = landDocument;
    }
    if (holderNames !== undefined) state.holderNames = Array.isArray(holderNames) ? holderNames.map(String).slice(0, 5) : [DEFAULT_FARMER_NAME];
    state.failuresServed = 0;
    state.version += 1;
    return snapshot();
  };
  const snapshot = () => ({ ai: state.ai, landDocument: state.landDocument, holderNames: [...state.holderNames], version: state.version, failuresServed: state.failuresServed, calls: { ...state.calls } });

  return { generate, configure, snapshot, classify };
};

// Replace `model.generate` on the shared chat-service model. Returns a restore function.
export const installFakeGemini = (model, fake) => {
  if (!model || typeof model.generate !== "function") throw new Error("installFakeGemini: model.generate not found");
  const original = model.generate;
  model.generate = (...args) => fake.generate(...args);
  return () => {
    model.generate = original;
  };
};

// The real prompt constants, loaded from the application (needs config/env.js to be loadable).
export const loadPromptConstants = async () => {
  const [{ CLAIM_LOSS_VISION_INSTRUCTIONS }, { LAND_DOCUMENT_SYSTEM_INSTRUCTIONS }] = await Promise.all([
    import("../../../src/ai/ClaimLossVisionTemplates.js"),
    import("../../../services/landDocumentExamination.service.js"),
  ]);
  return { claimVision: CLAIM_LOSS_VISION_INSTRUCTIONS, landDocument: LAND_DOCUMENT_SYSTEM_INSTRUCTIONS };
};

export default { createFakeGemini, installFakeGemini, loadPromptConstants, parseAiMode, providerError, AI_BASE_MODES, LAND_DOCUMENT_MODES };
