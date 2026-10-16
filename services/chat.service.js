import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { withAiTimeout, AiTimeoutError, isProviderLimitError, getAiMaxRetries } from "../utils/aiTimeout.js";
import ChatSession from "../models/ChatSession.js";
import { env, validateEnv, CHAT_REQUIRED } from "../config/env.js";
import { deriveTitle, getForUser } from "./chatSession.service.js";
import {
  buildPrompt,
  buildFallbackPrompt,
  promptConfig,
} from "../src/ai/PromptBuilder.js";
import { selectTemplate } from "../src/ai/PromptTemplates.js";
import { cleanupResponse } from "../src/ai/ResponseCleanup.js";
import AIConfig from "../src/ai/AIConfig.js";
import { assembleContext, renderContextBlock } from "./context.service.js";
import { INTENTS } from "../src/ai/Intent.js";

validateEnv(CHAT_REQUIRED);

const model = new ChatGoogleGenerativeAI({
  apiKey: env.googleApiKey,
  model: AIConfig.model,
  maxOutputTokens: AIConfig.maxOutputTokens,
  maxRetries: getAiMaxRetries(),
});

// Use Cohere embeddings (same as ingestion) - 1024 dimensions
const embeddings = new CohereEmbeddings({
  apiKey: env.cohereApiKey,
  model: AIConfig.embeddingModel
});

// Initialize ChromaDB cloud client
const chromaClient = new CloudClient({
  apiKey: env.chromaApiKey,
  tenant: env.chromaTenant,
  database: env.chromaDatabase
});

// Lazy ChromaDB collection connection — avoid blocking at import time so that integration
// tests which import the full Express app do not fail when ChromaDB is unreachable.
let collectionPromise = null;
let collectionReady = false;
let collection;

const ensureCollection = async () => {
  if (collectionReady) return collection;
  if (!collectionPromise) {
    collectionPromise = (async () => {
      try {
        collection = await chromaClient.getCollection({ name: "farming-documents" });
        collectionReady = true;
        logger.info("Connected to ChromaDB collection: farming-documents");
        return collection;
      } catch (error) {
        logger.error({ err: error }, "Failed to connect to ChromaDB collection");
        // Forget the failed attempt: caching the rejected promise would disable RAG for the whole
        // life of this Lambda container after a single transient failure.
        collectionPromise = null;
        throw new Error("ChromaDB collection not found. Please run ingestion first.");
      }
    })();
  }
  return collectionPromise;
};

// RAG function using ChromaDB. Retrieval is query-only (the chat history is not used for it).
// Returns the joined text plus WHICH documents it came from, so the answer can be attributed. Only a
// file name is exposed, never the bucket or the object path.
async function performRAG(userMessage) {
  try {
    const coll = await ensureCollection();
    const messageEmbedding = await embeddings.embedQuery(userMessage);
    const results = await coll.query({
      queryEmbeddings: [messageEmbedding],
      nResults: AIConfig.ragTopK,
      include: ["documents", "metadatas"],
    });

    const documents = results.documents && results.documents[0] ? results.documents[0] : [];
    const metadatas = results.metadatas && results.metadatas[0] ? results.metadatas[0] : [];
    const context = documents.length > 0 ? documents.join("\n\n") : "";

    const seen = new Set();
    const sources = [];
    metadatas.forEach((meta) => {
      const filename = meta && (meta.filename || (meta.source ? String(meta.source).split("/").pop() : null));
      if (filename && !seen.has(filename)) {
        seen.add(filename);
        sources.push({ filename: String(filename).slice(0, 120) });
      }
    });

    return { context: context || null, sourceCount: documents.length, sources };
  } catch (error) {
    logger.error({ err: error }, "RAG retrieval failed");
    return { context: null, sourceCount: 0, sources: [] };
  }
}

// Reply language: an explicit request setting wins, then the farmer's profile, then the script of the
// message itself (Tamil script means a Tamil reply). Anything else lets the model mirror the message.
const TAMIL_SCRIPT = /[\u0B80-\u0BFF]/;
export const resolveReplyLanguage = ({ requested, profileLanguage, message }) => {
  if (requested === "ta" || requested === "en") return requested;
  if (TAMIL_SCRIPT.test(message || "")) return "ta";
  if (profileLanguage === "ta" || profileLanguage === "en") return profileLanguage;
  return undefined;
};

// Token usage as reported by the provider. LangChain puts it on `llmOutput.tokenUsage`; some
// providers put it on the generation message. The previous code read neither and logged zeros.
const readTokenUsage = (result) => {
  const usage =
    (result && result.llmOutput && (result.llmOutput.tokenUsage || result.llmOutput.estimatedTokenUsage)) ||
    (result && result.generations && result.generations[0] && result.generations[0][0] && result.generations[0][0].message && result.generations[0][0].message.usage_metadata) ||
    (result && (result.usageMetadata || result.usage)) ||
    {};
  return {
    input: Number(usage.promptTokens ?? usage.input_tokens ?? usage.inputTokens ?? 0),
    output: Number(usage.completionTokens ?? usage.output_tokens ?? usage.outputTokens ?? 0),
    total: Number(usage.totalTokens ?? usage.total_tokens ?? 0),
  };
};

// E1-S5 (D-35): ownership derives from the authenticated caller's cognitoSub (req.user.id); the
// client never supplies an ownership email. userEmail is retained server-side as a display key.
const generateResponse = async ({ message, chatId, cognitoSub, email, district, parcelId = null, language: requestedLanguage }) => {
  const conversationId = chatId || `new-${cognitoSub || "anon"}`;
  const template = selectTemplate(message);
  const startedAt = Date.now();

  try {
    let chatSession;
    let chatHistory = [];

    // Get an existing chat session and its history if chatId is provided — but only if it is
    // owned by the caller. Foreign/unowned ids are treated as absent (no cross-user data leak);
    // the flow falls back to creating a new session for the caller.
    if (chatId) {
      chatSession = await getForUser(chatId, cognitoSub);
      if (chatSession) {
        chatHistory = chatSession.messages || [];
      }
    }

    // Context Engine: classify the intent, then load ONLY the sources it needs and resolve the
    // farmer's district / parcel / crop from their own records. Never throws (ADR-014).
    const contextStart = Date.now();
    const snapshot = await assembleContext({ district, cognitoSub, userMessage: message, parcelId });
    const renderedContext = renderContextBlock(snapshot);
    const contextMs = Date.now() - contextStart;

    // Retrieval for knowledge-style questions; greetings and claim questions have nothing to retrieve.
    const ragStart = Date.now();
    const skipRag = snapshot.intent === INTENTS.GREETING || snapshot.intent === INTENTS.CLAIM_STATUS;
    const rag = skipRag ? { context: null, sourceCount: 0, sources: [] } : await performRAG(message);
    const ragMs = Date.now() - ragStart;
    const hasRag = !!rag.context;

    const language = resolveReplyLanguage({
      requested: requestedLanguage,
      profileLanguage: snapshot.farmProfile && snapshot.farmProfile.language,
      message,
    });

    // Build the prompt via the single, modular PromptBuilder (no manual concatenation).
    const messages = hasRag
      ? buildPrompt({
          userMessage: message,
          history: chatHistory,
          context: rag.context,
          template,
          assembledContext: renderedContext,
          language,
        })
      : buildFallbackPrompt({ userMessage: message, history: chatHistory, assembledContext: renderedContext, language });

    const lmMessages = messages.map((m) =>
      m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content)
    );

    const modelStart = Date.now();
    // Bounded under the API Gateway/Lambda ceiling so a slow Gemini call cannot produce a 503
    // and cause the user's retries to trip the per-user application rate limiter (429).
    const result = await withAiTimeout(
      () => model.generate([lmMessages]),
      "chat.text_generate",
    ).catch((err) => {
      if (err instanceof AiTimeoutError) {
        logger.warn(
          { conversationId, latencyMs: Date.now() - modelStart, timeoutMs: err.timeoutMs },
          "chat.text_generate_timeout",
        );
        return null;
      }
      if (isProviderLimitError(err)) {
        logger.warn({ conversationId, status: err.status, latencyMs: Date.now() - modelStart }, "chat.text_generate_provider_limit");
        throw ApiError.serviceUnavailable("AI service is busy. Please try again later.");
      }
      throw err;
    });
    const latency = Date.now() - modelStart;
    if (!result) {
      throw ApiError.internal("AI service did not respond in time");
    }

    let response = result.generations?.[0]?.[0]?.text || result.generations?.[0]?.[0]?.message?.content || "";
    if (!response || !response.trim()) {
      // Gracefully recover from malformed/empty AI output.
      logger.warn({ conversationId }, "Empty AI response; using fallback");
      response =
        "மன்னிக்கவும், இந்த கேள்விக்கு பதிலில் பரிந்துர்க்க முடியவில்லை. உங்கள் பக்கத்து வேளாண்மை அலுவலரிடம் கேட்கவும்.";
    }

    // Clean up the model output (dedupe headings, normalize bullets, collapse blanks).
    response = cleanupResponse(response);

    const tokens = readTokenUsage(result);

    logger.info(
      {
        conversationId,
        provider: AIConfig.provider,
        model: AIConfig.model,
        intent: snapshot.intent,
        latency,
        contextMs,
        ragMs,
        loaded: snapshot.loaded,
        followUp: snapshot.sufficiency.followUp ? snapshot.sufficiency.followUp.slot : null,
        ...tokens,
        hasRag,
        sourceCount: rag.sourceCount,
      },
      "chat.generate"
    );

    if (!chatId || !chatSession) {
      // Create new chat session (owned by the caller's cognitoSub)
      chatSession = await ChatSession.create({
        cognitoSub,
        userEmail: email ?? null,
        title: deriveTitle(message, 50),
        messages: [
          { sender: "user", text: message },
          { sender: "ai", text: response }
        ]
      });
    } else {
      // Update existing chat session
      if (chatSession.messages.length === 0) {
        chatSession.title = deriveTitle(message, 40);
      }

      chatSession.messages.push({ sender: "user", text: message });
      chatSession.messages.push({ sender: "ai", text: response });
      chatSession.updatedAt = new Date();
      await chatSession.save();
    }

    logger.info(
      { conversationId, totalLatency: Date.now() - startedAt },
      "chat.generate.complete"
    );

    return {
      chatId: chatSession._id,
      messages: chatSession.messages,
      response,
      hasContext: hasRag,
      hasChatHistory: chatHistory.length > 0,
      sourceCount: rag.sourceCount,
      // Which documents the answer was grounded in (file names only). Empty when nothing was retrieved.
      sources: rag.sources || [],
      chatHistoryCount: chatHistory.length,
      // Instrumentation for evaluation: what the assistant understood and loaded, and how long each stage took.
      meta: {
        intent: snapshot.intent,
        sufficient: snapshot.sufficiency.sufficient,
        followUpSlot: snapshot.sufficiency.followUp ? snapshot.sufficiency.followUp.slot : null,
        loaded: snapshot.loaded,
        language: language || null,
        latencyMs: { context: contextMs, rag: ragMs, model: latency, total: Date.now() - startedAt },
        tokens,
      },
      timestamp: new Date().toISOString(),
      session: chatSession
    };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 503) throw error;
    logger.error(
      { conversationId, template, err: error, durationMs: Date.now() - startedAt },
      "AI Model Error"
    );
    throw ApiError.internal("Failed to generate chat response");
  }
};

// Test seam: forget the cached Chroma connection (module state) so tests start clean.
const _resetCollectionCache = () => {
  collectionPromise = null;
  collectionReady = false;
  collection = undefined;
};

export { generateResponse, model, performRAG, _resetCollectionCache };
