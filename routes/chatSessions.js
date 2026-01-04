import express from "express";
import ChatSession from "../models/ChatSession.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";

const router = express.Router();

// Create a new chat session
router.post("/new", asyncHandler(async (req, res) => {
  const { userEmail, title } = req.body;

  if (!userEmail) throw ApiError.badRequest("User email required");

  const newSession = await ChatSession.create({
    userEmail,
    title: title || "New Chat",
    messages: []
  });

  return ApiResponse.success(res, "Chat session created", { session: newSession });
}));

// List sessions for a user
router.get("/list/:email", asyncHandler(async (req, res) => {
  const { email } = req.params;
  if (!email) throw ApiError.badRequest("Email required");

  const sessions = await ChatSession
    .find({ userEmail: email })
    .sort({ updatedAt: -1 });

  return ApiResponse.success(res, "Sessions fetched", { sessions });
}));

// Add message to chat session (UPDATED)
router.post("/:id/message", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { sender, text } = req.body;

  if (!text || !sender) throw ApiError.badRequest("Sender and text required");

  const session = await ChatSession.findById(id);
  if (!session) throw ApiError.notFound("Chat session not found");

  // AUTO-GENERATE TITLE FROM FIRST MESSAGE
  if (session.messages.length === 0) {
    session.title = text.substring(0, 40);
  }

  session.messages.push({
    sender,
    text,
    timestamp: new Date()
  });

  await session.save();

  return ApiResponse.success(res, "Message saved", { session });
}));

// Get a session by ID
router.get("/:id", asyncHandler(async (req, res) => {
  const session = await ChatSession.findById(req.params.id);
  if (!session) throw ApiError.badRequest("Session not found");

  return ApiResponse.success(res, "Session fetched", { session });
}));

// Delete a chat session
router.delete("/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { userEmail } = req.body;

  const session = await ChatSession.findById(id);
  if (!session) throw ApiError.badRequest("Chat session not found");

  if (userEmail && session.userEmail !== userEmail) {
    throw ApiError.unauthorized("You cannot delete another user's chat");
  }

  await session.deleteOne();

  return ApiResponse.success(res, "Chat session deleted successfully");
}));

// Clear all chats
router.delete("/clear/all", asyncHandler(async (req, res) => {
  const { userEmail } = req.body;
  if (!userEmail) throw ApiError.badRequest("User email required");

  const result = await ChatSession.deleteMany({ userEmail });

  return ApiResponse.success(
    res,
    `All chat sessions deleted (${result.deletedCount} chats removed)`
  );
}));

export default router;
