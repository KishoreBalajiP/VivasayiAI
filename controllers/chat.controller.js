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

// RAG function using ChromaDB
async function performRAG(userMessage) {
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

    const enhancedPrompt = context 
      ? `${systemPrompt}\n\nYou have access to the following relevant agricultural data:\n\n${context}\n\nUse this information to provide accurate, data-driven advice.`
      : systemPrompt;

    const messages = [
      new SystemMessage(enhancedPrompt),
      new HumanMessage(userMessage),
    ];

    const result = await model.generate([messages]);
    return {
      response: result.generations[0][0].text,
      hasContext: context.length > 0,
      sourceCount: results.documents?.[0]?.length || 0
    };
  } catch (error) {
    console.error("RAG Error:", error);
    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userMessage),
    ];
    const result = await model.generate([messages]);
    return {
      response: result.generations[0][0].text,
      hasContext: false,
      sourceCount: 0
    };
  }
}

const chat = asyncHandler(async (req, res) => {
  const { message, chatId, userEmail } = req.body; // added chatId & userEmail

  if (!message) throw ApiError.badRequest("Message is required");
  if (!userEmail) throw ApiError.badRequest("userEmail is required"); // ensures user identity

  try {
    const result = await performRAG(message);

    let chatSession;

    if (!chatId) {
      chatSession = await ChatSession.create({
        userEmail,
        title: message.slice(0, 50),
        messages: [
          { sender: "user", text: message },
          { sender: "ai", text: result.response }
        ]
      });
    } else {
      chatSession = await ChatSession.findById(chatId);
      if (chatSession) {
        chatSession.messages.push({ sender: "user", text: message });
        chatSession.messages.push({ sender: "ai", text: result.response });
        chatSession.updatedAt = new Date();
        await chatSession.save();
      } else {
        chatSession = await ChatSession.create({
          userEmail,
          title: message.slice(0, 50),
          messages: [
            { sender: "user", text: message },
            { sender: "ai", text: result.response }
          ]
        });
      }
    }

    return ApiResponse.success(res, "Chat response generated successfully", {
      chatId: chatSession._id,
      messages: chatSession.messages,
      response: result.response,
      hasContext: result.hasContext,
      sourceCount: result.sourceCount,
      timestamp: new Date().toISOString(),
      session: chatSession
    });
  } catch (error) {
    console.error("AI Model Error:", error);
    throw ApiError.badRequest(error);
  }
});

export default chat;
