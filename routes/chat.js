import express from "express";
import chat, { getChatSession, getUserChatSessions } from "../controllers/chat.controller.js";
import validate from "../middlewares/validate.js";
import { chatBody, chatParams, userEmailQuery } from "../utils/validation.schemas.js";

const router = express.Router();

// Chat with RAG-enhanced AI with context awareness
router.post("/", validate(chatBody), chat);

// Get specific chat session with context
router.get(
  "/session/:chatId",
  validate(chatParams, "params"),
  validate(userEmailQuery, "query"),
  getChatSession
);

// Get all chat sessions for a user
router.get("/sessions", validate(userEmailQuery, "query"), getUserChatSessions);

export default router;
