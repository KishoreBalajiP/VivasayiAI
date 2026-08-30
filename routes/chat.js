import express from "express";
import chat, { getChatSession, getUserChatSessions } from "../controllers/chat.controller.js";
import validate from "../middlewares/validate.js";
import { chatBody, chatParams } from "../utils/validation.schemas.js";

const router = express.Router();

// Chat with RAG-enhanced AI with context awareness
router.post("/", validate(chatBody), chat);

// Get specific chat session with context (owned by the caller)
router.get(
  "/session/:chatId",
  validate(chatParams, "params"),
  getChatSession
);

// Get all chat sessions for the caller
router.get("/sessions", getUserChatSessions);

export default router;
