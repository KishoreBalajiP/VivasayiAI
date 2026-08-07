import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import systemPrompt from "../utils/prompts.js";
import ChatSession from "../models/ChatSession.js";
import { env, validateEnv, CHAT_REQUIRED } from "../config/env.js";
import { deriveTitle, getById } from "./chatSession.service.js";

validateEnv(CHAT_REQUIRED);

const model = new ChatGoogleGenerativeAI({
    apiKey: env.googleApiKey,
    model: "gemini-2.5-flash",
    maxOutputTokens: 2048,
});

// Use Cohere embeddings (same as ingestion) - 1024 dimensions
const embeddings = new CohereEmbeddings({
  apiKey: env.cohereApiKey,
  model: "embed-english-v3.0"
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
      nResults: 3,
    });

    let context = "";
    if (results.documents && results.documents[0] && results.documents[0].length > 0) {
      context = results.documents[0].join("\n\n");
    }

    // Build chat context from previous messages
    let chatContext = "";
    if (chatHistory && chatHistory.length > 0) {
      // Get last 6 messages (3 user-AI pairs) to keep context manageable
      const recentMessages = chatHistory.slice(-6);
      chatContext = recentMessages
        .map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`)
        .join('\n');
    }

    // Enhanced prompt with both RAG context and chat history
    let enhancedPrompt = systemPrompt;
    
    if (chatContext) {
      enhancedPrompt += `\n\nPrevious conversation context:\n${chatContext}\n\nRemember this conversation history and provide contextually relevant responses.`;
    }
    
    if (context) {
      enhancedPrompt += `\n\nRelevant agricultural knowledge base:\n${context}\n\nUse this information to provide accurate, data-driven advice.`;
    }

    const messages = [
      new SystemMessage(enhancedPrompt),
      new HumanMessage(userMessage),
    ];

    const result = await model.generate([messages]);
    return {
      response: result.generations[0][0].text,
      hasContext: context.length > 0,
      hasChatHistory: chatHistory.length > 0,
      sourceCount: results.documents?.[0]?.length || 0,
      chatHistoryCount: chatHistory.length
    };
  } catch (error) {
    logger.error({ err: error }, "RAG Error");
    
    // Fallback with chat context even if RAG fails
    let fallbackPrompt = systemPrompt;
    if (chatHistory && chatHistory.length > 0) {
      const recentMessages = chatHistory.slice(-6);
      const chatContext = recentMessages
        .map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`)
        .join('\n');
      fallbackPrompt += `\n\nPrevious conversation context:\n${chatContext}`;
    }
    
    const messages = [
      new SystemMessage(fallbackPrompt),
      new HumanMessage(userMessage),
    ];
    const result = await model.generate([messages]);
    return {
      response: result.generations[0][0].text,
      hasContext: false,
      hasChatHistory: chatHistory.length > 0,
      sourceCount: 0,
      chatHistoryCount: chatHistory.length
    };
  }
}

const generateResponse = async ({ message, chatId, userEmail }) => {
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
    const result = await performRAG(message, chatHistory);

    if (!chatId || !chatSession) {
      // Create new chat session
      chatSession = await ChatSession.create({
        userEmail,
        title: deriveTitle(message, 50),
        messages: [
          { sender: "user", text: message },
          { sender: "ai", text: result.response }
        ]
      });
    } else {
      // Update existing chat session
      if (chatSession.messages.length === 0) {
        chatSession.title = deriveTitle(message, 40);
      }

      chatSession.messages.push({ sender: "user", text: message });
      chatSession.messages.push({ sender: "ai", text: result.response });
      chatSession.updatedAt = new Date();
      await chatSession.save();
    }

    return {
      chatId: chatSession._id,
      messages: chatSession.messages,
      response: result.response,
      hasContext: result.hasContext,
      hasChatHistory: result.hasChatHistory,
      sourceCount: result.sourceCount,
      chatHistoryCount: result.chatHistoryCount,
      timestamp: new Date().toISOString(),
      session: chatSession
    };
  } catch (error) {
    logger.error({ err: error }, "AI Model Error");
    throw ApiError.internal("Failed to generate chat response");
  }
};

export { generateResponse };
