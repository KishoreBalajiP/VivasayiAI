import express from "express";
import validate from "../middlewares/validate.js";
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
router.post("/new", validate(createSessionBody), createSession);

// List the caller's sessions
router.get("/list", listSessions);

// Add message to chat session
router.post("/:id/message", validate(sessionParams, "params"), validate(messageBody), appendMessage);

// Get a session by ID (owned only)
router.get("/:id", validate(sessionParams, "params"), getSession);

// Delete a chat session (owned only)
router.delete("/:id", validate(sessionParams, "params"), deleteSession);

// Clear all of the caller's chats
router.delete("/clear/all", clearAllSessions);

export default router;
