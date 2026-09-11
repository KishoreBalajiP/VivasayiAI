import express from "express";
import validate from "../middlewares/validate.js";
import { sessionMutationLimiter } from "../middlewares/rateLimit.js";
import {
  createSessionBody,
  messageBody,
  sessionParams
} from "../utils/validation.schemas.js";
import {
  createSession,
  listSessions,
  appendMessage,
  getSession,
  deleteSession,
  clearAllSessions
} from "../controllers/chatSessions.controller.js";

const router = express.Router();

// Create a new chat session
router.post("/new", sessionMutationLimiter, validate(createSessionBody), createSession);

// List the caller's sessions
router.get("/list", listSessions);

// Add message to chat session
router.post("/:id/message", sessionMutationLimiter, validate(sessionParams, "params"), validate(messageBody), appendMessage);

// Get a session by ID (owned only)
router.get("/:id", validate(sessionParams, "params"), getSession);

// Delete a chat session (owned only)
router.delete("/:id", sessionMutationLimiter, validate(sessionParams, "params"), deleteSession);

// Clear all of the caller's chats
router.delete("/clear/all", sessionMutationLimiter, clearAllSessions);

export default router;
