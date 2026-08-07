import express from "express";
import validate from "../middlewares/validate.js";
import {
  createSessionBody,
  listParams,
  messageBody,
  sessionParams,
  deleteBody,
  clearAllBody
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

// List sessions for a user
router.get("/list/:email", validate(listParams, "params"), listSessions);

// Add message to chat session
router.post("/:id/message", validate(sessionParams, "params"), validate(messageBody), appendMessage);

// Get a session by ID
router.get("/:id", validate(sessionParams, "params"), getSession);

// Delete a chat session
router.delete("/:id", validate(sessionParams, "params"), validate(deleteBody), deleteSession);

// Clear all chats
router.delete("/clear/all", validate(clearAllBody), clearAllSessions);

export default router;
