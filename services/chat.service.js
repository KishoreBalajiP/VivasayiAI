import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import ChatSession from "../models/ChatSession.js";
import { env, validateEnv, CHAT_REQUIRED } from "../config/env.js";
import { deriveTitle, getById } from "./chatSession.service.js";
import {
  buildPrompt,
  buildFallbackPrompt,
  promptConfig,
} from "../src/ai/PromptBuilder.js";
import { selectTemplate } from "../src/ai/PromptTemplates.js";
import { cleanupResponse } from "../src/ai/ResponseCleanup.js";
import AIConfig from "../src/ai/AIConfig.js";

validateEnv(CHAT_REQUIRED);

const model = new ChatGoogleGenerativeAI({
  apiKey: env.googleApiKey,
  model: AIConfig.model,
  maxOutputTokens: AIConfig.maxOutputTokens,
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

let collection;
try {
  collection = await chromaClient.getCollection({
    name: "farming-documents"
  });
  logger.info("Connected to ChromaDB collection: farming-documents");
  logger.info("Note: Embedding warnings are expected - we use Cohere embeddings externally");
} catch (error) {
  logger.error({ err: error }, "Failed to connect to ChromaDB collection");
  throw new Error("ChromaDB collection not found. Please run ingestion first.");
}

// RAG function using ChromaDB with chat context
async function performRAG(userMessage, chatHistory = []) {
  try {
    const messageEmbedding = await embeddings.embedQuery(userMessage);
    const results = await collection.query({
      queryEmbeddings: [messageEmbedding],
      nResults: AIConfig.ragTopK,
    });

    let context = "";
    if (results.documents && results.documents[0] && results.documents[0].length > 0) {
      context = results.documents[0].join("\n\n");
    }

    return {
      context: context || null,
      sourceCount: results.documents?.[0]?.length || 0,
    };
  } catch (error) {
    logger.error({ err: error }, "RAG retrieval failed");
    return { context: null, sourceCount: 0 };
  }
}

const generateResponse = async ({ message, chatId, userEmail }) => {
  const conversationId = chatId || `new-${userEmail || "anon"}`;
  const template = selectTemplate(message);
  const startedAt = Date.now();

  try {
    let chatSession;
    let chatHistory = [];

    // Get existing chat session and its history if chatId is provided
    if (chatId) {
      chatSession = await getById(chatId);
      if (chatSession) {
        chatHistory = chatSession.messages || [];
      }
    }

    // Perform RAG with chat context
    const rag = await performRAG(message, chatHistory);
    const hasRag = !!rag.context;

    // Build the prompt via the single, modular PromptBuilder (no manual concatenation).
    const messages = hasRag
      ? buildPrompt({
          userMessage: message,
          history: chatHistory,
          context: rag.context,
          template,
        })
      : buildFallbackPrompt({ userMessage: message, history: chatHistory });

    const lmMessages = messages.map((m) =>
      m.role === "system" ? new SystemMessage(m.content) : new HumanMessage(m.content)
    );

    const modelStart = Date.now();
    const result = await model.generate([lmMessages]);
    const latency = Date.now() - modelStart;

    let response = result.generations?.[0]?.[0]?.text || result.generations?.[0]?.[0]?.message?.content || "";
    if (!response || !response.trim()) {
      // Gracefully recover from malformed/empty AI output.
      logger.warn({ conversationId }, "Empty AI response; using fallback");
      response =
        "மன்னிக்கவும், பதிலில் பரிந்துர்க்க முடியவில்லை. உங்கள் பக்கத்து வேளாண்மை அலுவலரிட�் கேட�்கவும்.";
    }

    // Clean up the model output (dedupe headings, normalize bullets, collapse blanks).
    response = cleanupResponse(response);

    const usage = result.usageMetadata || result.usage || {};
    const tokens = {
      input: Number(usage.input_tokens ?? usage.promptTokens ?? 0),
      output: Number(usage.output_tokens ?? usage.completionTokens ?? 0),
      total: Number(usage.total_tokens ?? usage.totalTokens ?? 0),
    };

    logger.info(
      {
        conversationId,
        provider: AIConfig.provider,
        model: AIConfig.model,
        template,
        latency,
        ...tokens,
        hasRag,
        sourceCount: rag.sourceCount,
      },
      "chat.generate"
    );

    if (!chatId || !chatSession) {
      // Create new chat session
      chatSession = await ChatSession.create({
        userEmail,
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
      chatHistoryCount: chatHistory.length,
      timestamp: new Date().toISOString(),
      session: chatSession
    };
  } catch (error) {
    logger.error(
      { conversationId, template, err: error, durationMs: Date.now() - startedAt },
      "AI Model Error"
    );
    throw ApiError.internal("Failed to generate chat response");
  }
};

export { generateResponse };
