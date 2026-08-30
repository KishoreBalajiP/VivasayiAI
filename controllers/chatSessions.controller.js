import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as chatSessionService from "../services/chatSession.service.js";

// E1-S5 (D-35): identity derives from the verified token (req.user.id = cognitoSub), never from
// client-supplied userEmail. Foreign/unowned resources return 404.

// Create a new chat session for the caller.
const createSession = asyncHandler(async (req, res) => {
  const { title } = req.body;
  const session = await chatSessionService.create({
    cognitoSub: req.user.id,
    email: req.user.email,
    title,
  });

  return ApiResponse.success(res, "Chat session created", { session });
});

// List the caller's sessions.
const listSessions = asyncHandler(async (req, res) => {
  const sessions = await chatSessionService.listForUser(req.user.id);

  return ApiResponse.success(res, "Sessions fetched", { sessions });
});

// Add message to the caller's chat session.
const appendMessage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { sender, text } = req.body;

  const session = await chatSessionService.appendMessage(id, req.user.id, { sender, text });
  if (!session) throw ApiError.notFound("Chat session not found");

  return ApiResponse.success(res, "Message saved", { session });
});

// Get a session by ID (owned only).
const getSession = asyncHandler(async (req, res) => {
  const session = await chatSessionService.getForUser(req.params.id, req.user.id);
  if (!session) throw ApiError.notFound("Session not found");

  return ApiResponse.success(res, "Session fetched", { session });
});

// Delete the caller's chat session.
const deleteSession = asyncHandler(async (req, res) => {
  const session = await chatSessionService.remove(req.params.id, req.user.id);
  if (!session) throw ApiError.notFound("Chat session not found");

  return ApiResponse.success(res, "Chat session deleted successfully");
});

// Clear all of the caller's chats.
const clearAllSessions = asyncHandler(async (req, res) => {
  const result = await chatSessionService.clearForUser(req.user.id);

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
