import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import logger from "../utils/logger.js";
import { generateResponse } from "../services/chat.service.js";
import { getForUser, listRecentForUser } from "../services/chatSession.service.js";

const chat = asyncHandler(async (req, res) => {
  const result = await generateResponse(req.body);

  return ApiResponse.success(res, "Chat response generated successfully", result);
});

// Get chat session by ID
const getChatSession = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { userEmail } = req.query;

  try {
    const chatSession = await getForUser(chatId, userEmail);

    if (!chatSession) {
      throw ApiError.notFound("Chat session not found");
    }

    return ApiResponse.success(res, "Chat session retrieved successfully", {
      chatSession
    });
  } catch (error) {
    logger.error({ err: error }, "Get Chat Session Error");
    throw ApiError.internal("Failed to retrieve chat session");
  }
});

// Get all chat sessions for a user
const getUserChatSessions = asyncHandler(async (req, res) => {
  const { userEmail } = req.query;

  try {
    const chatSessions = await listRecentForUser(userEmail);

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
  } catch (error) {
    logger.error({ err: error }, "Get User Chat Sessions Error");
    throw ApiError.internal("Failed to retrieve chat sessions");
  }
});

export { chat as default, getChatSession, getUserChatSessions };
