import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import { generateResponse } from "../services/chat.service.js";
import { getForUser, listRecentForUser } from "../services/chatSession.service.js";

const chat = asyncHandler(async (req, res) => {
  const result = await generateResponse({
    ...req.body,
    cognitoSub: req.user.id,
    email: req.user.email,
  });

  return ApiResponse.success(res, "Chat response generated successfully", result);
});

// Get chat session by ID (owned only)
const getChatSession = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const chatSession = await getForUser(chatId, req.user.id);

  if (!chatSession) {
    throw ApiError.notFound("Chat session not found");
  }

  return ApiResponse.success(res, "Chat session retrieved successfully", {
    chatSession
  });
});

// Get all chat sessions for the caller
const getUserChatSessions = asyncHandler(async (req, res) => {
  const chatSessions = await listRecentForUser(req.user.id);

  // Add message count and last message preview
  const sessionsWithMeta = chatSessions.map(session => ({
    _id: session._id,
    title: session.title,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messageCount: session.messages.length,
    lastMessage: session.messages.length > 0
      ? session.messages[session.messages.length - 1].text.slice(0, 100) + '...'
      : 'No messages'
  }));

  return ApiResponse.success(res, "User chat sessions retrieved successfully", {
    chatSessions: sessionsWithMeta,
    total: sessionsWithMeta.length
  });
});

export { chat as default, getChatSession, getUserChatSessions };
