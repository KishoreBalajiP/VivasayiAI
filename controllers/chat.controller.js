import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { CohereEmbeddings } from "@langchain/cohere";
import { CloudClient } from "chromadb";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import systemPrompt from "../utils/prompts.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import ChatSession from "../models/ChatSession.js"; // added only this import

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", ".env");
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.warn("dotenv: no .env loaded from", envPath, "— continuing (maybe using real env vars)");
} else {
  console.log("dotenv loaded .env from:", envPath);
}

function sanitizeApiKey(raw) {
  if (raw === undefined || raw === null) return null;
  let s = typeof raw === "string" ? raw : String(raw);
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  return s;
}

const rawApiKey = process.env.GOOGLE_API_KEY;
const apiKey = sanitizeApiKey(rawApiKey);
const { CHROMA_API_KEY, CHROMA_TENANT, CHROMA_DATABASE } = process.env;

if (!apiKey) {
    console.error(
        "Missing GOOGLE_API_KEY. Make sure you have a valid key in the environment or in",
        envPath,
    );
    throw new Error("Missing GOOGLE_API_KEY in environment");
}

if (!CHROMA_API_KEY || !CHROMA_TENANT || !CHROMA_DATABASE) {
    throw new Error("Missing ChromaDB cloud credentials in environment");
}

const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: "gemini-2.5-flash",
    maxOutputTokens: 2048,
});

// Use Cohere embeddings (same as ingestion) - 1024 dimensions
const embeddings = new CohereEmbeddings({
  apiKey: process.env.COHERE_API_KEY,
  model: "embed-english-v3.0"
});

// Initialize ChromaDB cloud client
const chromaClient = new CloudClient({
  apiKey: CHROMA_API_KEY,
  tenant: CHROMA_TENANT,
  database: CHROMA_DATABASE
});

let collection;
try {
  collection = await chromaClient.getCollection({
    name: "farming-documents"
  });
  console.log("✅ Connected to ChromaDB collection: farming-documents");
  console.log("🔕 Note: Embedding warnings are expected - we use Cohere embeddings externally");
} catch (error) {
  console.error("❌ Failed to connect to ChromaDB collection:", error.message);
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
    console.error("RAG Error:", error);
    
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

const chat = asyncHandler(async (req, res) => {
  const { message, chatId, userEmail } = req.body; // added chatId & userEmail

  if (!message) throw ApiError.badRequest("Message is required");
  if (!userEmail) throw ApiError.badRequest("userEmail is required"); // ensures user identity

  try {
    let chatSession;
    let chatHistory = [];

    // Get existing chat session and its history if chatId is provided
    if (chatId) {
      chatSession = await ChatSession.findById(chatId);
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
        title: message.slice(0, 50),
        messages: [
          { sender: "user", text: message },
          { sender: "ai", text: result.response }
        ]
      });
    } else {
      // Update existing chat session
  if (chatSession.messages.length === 0) {
    chatSession.title = message.substring(0, 40);
  }

  // Update existing chat session
  chatSession.messages.push({ sender: "user", text: message });
  chatSession.messages.push({ sender: "ai", text: result.response });
  chatSession.updatedAt = new Date();
  await chatSession.save();
    }

    return ApiResponse.success(res, "Chat response generated successfully", {
      chatId: chatSession._id,
      messages: chatSession.messages,
      response: result.response,
      hasContext: result.hasContext,
      hasChatHistory: result.hasChatHistory,
      sourceCount: result.sourceCount,
      chatHistoryCount: result.chatHistoryCount,
      timestamp: new Date().toISOString(),
      session: chatSession
    });
  } catch (error) {
    console.error("AI Model Error:", error);
    throw ApiError.badRequest(error);
  }
});

// Get chat session by ID
const getChatSession = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { userEmail } = req.query;

  if (!chatId) throw ApiError.badRequest("Chat ID is required");
  if (!userEmail) throw ApiError.badRequest("User email is required");

  try {
    const chatSession = await ChatSession.findOne({
      _id: chatId,
      userEmail: userEmail
    });

    if (!chatSession) {
      throw ApiError.notFound("Chat session not found");
    }

    return ApiResponse.success(res, "Chat session retrieved successfully", {
      chatSession
    });
  } catch (error) {
    console.error("Get Chat Session Error:", error);
    throw ApiError.badRequest(error);
  }
});

// Get all chat sessions for a user
const getUserChatSessions = asyncHandler(async (req, res) => {
  const { userEmail } = req.query;

  if (!userEmail) throw ApiError.badRequest("User email is required");

  try {
    const chatSessions = await ChatSession.find({ userEmail })
      .sort({ updatedAt: -1 })
      .select('_id title updatedAt createdAt messages')
      .limit(50); // Limit to recent 50 sessions

    // Add message count and last message preview
    const sessionsWithMeta = chatSessions.map(session => ({
      _id: session._id,
      title: session.title,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      messageCount: session.messages.length,
      lastMessage: session.messages.length > 0 
        ? session.messages[session.messages.length - 1].text.slice(0, 100) + '...'
        : 'No messages'
    }));

    return ApiResponse.success(res, "User chat sessions retrieved successfully", {
      chatSessions: sessionsWithMeta,
      total: sessionsWithMeta.length
    });
  } catch (error) {
    console.error("Get User Chat Sessions Error:", error);
    throw ApiError.badRequest(error);
  }
});

export { chat as default, getChatSession, getUserChatSessions };
