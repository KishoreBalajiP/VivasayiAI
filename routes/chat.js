import express from "express";
import chat, { getChatSession, getUserChatSessions } from "../controllers/chat.controller.js";

const router = express.Router();

// Chat with RAG-enhanced AI with context awareness
router.post("/", chat);

// Get specific chat session with context
router.get("/session/:chatId", getChatSession);

// Get all chat sessions for a user
router.get("/sessions", getUserChatSessions);

export default router;