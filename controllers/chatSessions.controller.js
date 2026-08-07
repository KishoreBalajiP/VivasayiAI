import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as chatSessionService from "../services/chatSession.service.js";

// Create a new chat session
const createSession = asyncHandler(async (req, res) => {
  const { userEmail, title } = req.body;

  const session = await chatSessionService.create({ userEmail, title });

  return ApiResponse.success(res, "Chat session created", { session });
});

// List sessions for a user
const listSessions = asyncHandler(async (req, res) => {
  const { email } = req.params;

  const sessions = await chatSessionService.listForUser(email);

  return ApiResponse.success(res, "Sessions fetched", { sessions });
});

// Add message to chat session
const appendMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { sender, text } = req.body;

  const session = await chatSessionService.appendMessage(id, { sender, text });
  if (!session) throw ApiError.notFound("Chat session not found");

  return ApiResponse.success(res, "Message saved", { session });
});

// Get a session by ID
const getSession = asyncHandler(async (req, res) => {
  const session = await chatSessionService.getById(req.params.id);
  if (!session) throw ApiError.badRequest("Session not found");

  return ApiResponse.success(res, "Session fetched", { session });
});

// Delete a chat session
const deleteSession = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { userEmail } = req.body;

  const session = await chatSessionService.remove(id, userEmail);
  if (!session) throw ApiError.badRequest("Chat session not found");

  return ApiResponse.success(res, "Chat session deleted successfully");
});

// Clear all chats
const clearAllSessions = asyncHandler(async (req, res) => {
  const { userEmail } = req.body;

  const result = await chatSessionService.clearForUser(userEmail);

  return ApiResponse.success(
    res,
    `All chat sessions deleted (${result.deletedCount} chats removed)`
  );
});

export {
  createSession,
  listSessions,
  appendMessage,
  getSession,
  deleteSession,
  clearAllSessions,
};
