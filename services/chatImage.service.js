import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import ImageRecord from "../models/ImageRecord.js";
import ChatSession from "../models/ChatSession.js";
import { env } from "../config/env.js";
import { model, performRAG } from "./chat.service.js";
import { getObject } from "./s3.service.js";
import { analyzeImage } from "./vision.service.js";
import { assembleContextAndRender } from "./context.service.js";
import { getByUser as getFarmProfile } from "./farmProfile.service.js";
import { getForUser, deriveTitle } from "./chatSession.service.js";
import { buildImageDiagnosisPrompt } from "../src/ai/PromptBuilder.js";
import { cleanupResponse } from "../src/ai/ResponseCleanup.js";
import AIConfig from "../src/ai/AIConfig.js";

// E3 (D-22 Option 1): the image diagnosis pipeline — the synchronous flow approved in D-41:
//   uploadId (owned) → image from private S3 → machine-vision observation (Gemini 2.5 Flash,
//   multimodal) → context assembly (+ farm profile) → RAG retrieval → farmer-facing reasoning
//   → ChatSession persistence + ImageRecord update.
//
// Ownership is scoped by the authenticated caller's cognitoSub (E1-S5, D-35); an upload id
// that is not owned by the caller is a 404 — never a cross-user leak. RAG and context are
// best-effort (both degrade gracefully like text chat). The only externally-dependent,
// correctness-critical step is the vision model; if it errors, the request fails cleanly (500)
// rather than fabricating a diagnosis.

const TAMIL_RANGE = /[\u0b80-\u0bff]/;

// Reason caption used only to seed RAG retrieval when the farmer sent no text with the photo.
const momentImageCaption = () => "crop disease or pest symptoms visible in a leaf photo";

const fallbackResponse = (language) =>
  language === "ta"
    ? "மன்னிக்கவும், இந்த படத்தை பகுப்பாய்வு செய்ய முடியவில்லை. உங்கள் பக்கத்து வேளாண்மை அலுவலரிடம் கேட்கவும்."
    : "Sorry, I could not analyze this photo. Please contact your local agricultural officer.";

// Deterministic reasoning output for IMAGE_AI_MODE=mock (dev/test only). Mirrors the shape a
// real model round would produce so the regression suite asserts stable, meaningful text.
const mockReasoning = (observation, language) => {
  if (language === "ta") {
    return "இந்தப் படத்தை பகுப்பாய்வு செய்தேன்: நெல் பயிரில் கீழ் இலைகள் மஞ்சளாக மாறியும், இலைகளில் சிறிய பழுப்பு புள்ளிகள் தென்படுகின்றன. மிகவும் சாத்தியமான காரணம் நைட்ரஜன் குறைபாடு. தேவையான அளவு யூரியாவை மேலுரமாக இடவும். சில நாட்கள் கவனித்து, பிரச்சனை அதிகரித்தால் அருகிலுள்ள வேளாண்மை அலுவலரை அணுகவும். உங்கள் பயிர் நன்றாக வளரட்டும்!";
  }
  const summary =
    observation?.summary || "the crop leaves showing discoloration";
  return `Based on the photo, it shows: ${summary}. The most likely concern is ${
    observation?.likelyIssues?.[0]?.name || "not clearly identifiable"
  }. Apply the recommended nitrogen fertilizer and observe for a few days. If the problem worsens, please contact your local agricultural officer. Wishing you a healthy harvest!`;
};

// Resolves the response language: explicit `language` param wins, then a Tamil message, then
// the caller's farm profile language, then English. Image-only turns cannot rely on the model
// inferring language from an empty message, so we control it explicitly.
const resolveLanguage = async ({ language, message, cognitoSub }) => {
  if (language === "ta" || language === "en") return language;
  if (message && TAMIL_RANGE.test(message)) return "ta";
  try {
    const profile = await getFarmProfile(cognitoSub);
    if (profile?.language === "ta" || profile?.language === "en") return profile.language;
  } catch (error) {
    logger.warn({ cognitoSub, err: error }, "image.lang_profile_failed");
  }
  return "en";
};

// Marks the record failed (best-effort save) and throws the sanitized public error.
const failRecord = async (record, stage, internalMessage) => {
  try {
    record.status = "failed";
    record.error = { stage, message: String(internalMessage).slice(0, 400) };
    await record.save();
  } catch (saveError) {
    logger.warn({ uploadId: record.uploadId, err: saveError }, "image.fail_record_save_failed");
  }
};

const generateImageResponse = async ({
  uploadId,
  message,
  chatId,
  language,
  district,
  cognitoSub,
  email,
}) => {
  const textInput = (message || "").trim();
  const conversationId = chatId || `new-${cognitoSub || "anon"}`;
  const startedAt = Date.now();

  let record;
  try {
    // 1. Owned record lookup (foreign/unknown -> 404, no cross-user leak).
    record = await ImageRecord.findOne({ uploadId, cognitoSub });
    if (!record) {
      throw ApiError.notFound("Image upload not found");
    }

    // A presigned upload that was not completed has no stored normalized image; analyzing it
    // would be a misleading 500. The client must finish POST /upload/:id/complete first.
    if (record.status === "pending" || record.status === "uploaded") {
      throw ApiError.badRequest("Image has not been uploaded yet");
    }

    record.status = "processing";
    record.error = { stage: null, message: null };
    await record.save();

    // 2. Resolve response language before any generation.
    const responseLanguage = await resolveLanguage({ language, message: textInput, cognitoSub });

    // 3. Fetch the normalized image from private S3.
    const image = await getObject(record.s3Key);
    if (!image) {
      throw ApiError.internal("Image storage unavailable");
    }

    // 4. Machine-vision observation (structured JSON). Throws sanitized 500 on model error.
    const observation = await analyzeImage({
      imageBuffer: image.buffer,
      mediaType: image.mediaType || record.processed.mediaType,
    });

    // 5. Context assembly (never throws) + RAG retrieval (degrades gracefully). History is
    //    seeded from the owned session (if chatId given and owned) so the diagnosis is
    //    context-aware within a conversation, exactly like text chat.
    let chatSession = chatId ? await getForUser(chatId, cognitoSub) : null;
    const chatHistory = chatSession?.messages || [];
    const renderedContext = await assembleContextAndRender({
      district,
      cognitoSub,
      userMessage: textInput || "image diagnosis",
    });
    const rag = await performRAG(textInput || momentImageCaption(), chatHistory);
    const hasRag = !!rag.context;

    // 6. Stage-2 reasoning (mock seam for tests, otherwise one Gemini call).
    let response;
    if (env.imageAiMode === "mock") {
      response = mockReasoning(observation, responseLanguage);
    } else {
      const messages = buildImageDiagnosisPrompt({
        observation,
        userMessage: textInput,
        history: chatHistory,
        context: rag.context,
        assembledContext: renderedContext,
        language: responseLanguage,
      });
      const lmMessages = messages.map((m) =>
        m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content)
      );
      const result = await model.generate([lmMessages]);
      response =
        result.generations?.[0]?.[0]?.text ||
        result.generations?.[0]?.[0]?.message?.content ||
        "";
      if (!response || !response.trim()) {
        logger.warn({ conversationId }, "Empty image response; using fallback");
        response = fallbackResponse(responseLanguage);
      }
      response = cleanupResponse(response);
    }

    // 7. Persist: update ImageRecord (authoritative diagnosis) + ChatSession turn.
    record.vision = observation;
    record.response = { text: response, language: responseLanguage };
    record.status = "completed";
    record.error = { stage: null, message: null };

    const userText = textInput;

    if (!chatId || !chatSession) {
      chatSession = await ChatSession.create({
        cognitoSub,
        userEmail: email ?? null,
        title: deriveTitle(textInput || "New Chat", 50),
        messages: [
          { sender: "user", text: userText, imageId: uploadId, timestamp: new Date() },
          { sender: "ai", text: response, timestamp: new Date() },
        ],
      });
    } else {
      if (chatSession.messages.length === 0) {
        chatSession.title = deriveTitle(textInput || "New Chat", 40);
      }
      chatSession.messages.push({ sender: "user", text: userText, imageId: uploadId });
      chatSession.messages.push({ sender: "ai", text: response });
      chatSession.updatedAt = new Date();
      await chatSession.save();
    }

    record.chatSessionId = chatSession._id;
    await record.save();

    logger.info(
      {
        conversationId,
        uploadId,
        provider: AIConfig.provider,
        model: AIConfig.model,
        latency: Date.now() - startedAt,
        language: responseLanguage,
        hasRag,
        sourceCount: rag.sourceCount,
      },
      "image.generate"
    );

    return {
      chatId: chatSession._id,
      messages: chatSession.messages,
      response,
      uploadId,
      image: {
        status: "completed",
        processed: record.processed,
        vision: record.vision,
      },
      hasContext: hasRag,
      hasChatHistory: chatHistory.length > 0,
      sourceCount: rag.sourceCount,
      timestamp: new Date().toISOString(),
      session: chatSession,
    };
  } catch (error) {
    if (record) {
      const stage = error instanceof ApiError ? `api_${error.statusCode}` : "pipeline";
      await failRecord(record, stage, error.message || String(error));
    }
    if (error instanceof ApiError) throw error;
    logger.error({ conversationId, uploadId, err: error, durationMs: Date.now() - startedAt }, "Image pipeline error");
    throw ApiError.internal("Failed to analyze the image");
  }
};

export { generateImageResponse };

export default { generateImageResponse };