import ChatSession from "../models/ChatSession.js";
import ApiError from "../utils/ApiError.js";

// Shared title truncation (per-call-site lengths preserved: 50 on create, 40 on first append)
const deriveTitle = (text, maxLength) => text.slice(0, maxLength);

const create = async ({ userEmail, title }) =>
  ChatSession.create({
    userEmail,
    title: title || "New Chat",
    messages: []
  });

const getById = async (id) => ChatSession.findById(id);

const getForUser = async (chatId, userEmail) =>
  ChatSession.findOne({ _id: chatId, userEmail });

const sessionsByUserQuery = (email) =>
  ChatSession.find({ userEmail: email }).sort({ updatedAt: -1 });

const listForUser = (email) => sessionsByUserQuery(email);

const listRecentForUser = (email) =>
  sessionsByUserQuery(email).select("_id title updatedAt createdAt messages").limit(50);

const appendMessage = async (id, { sender, text }) => {
  const session = await ChatSession.findById(id);
  if (!session) return null;

  // AUTO-GENERATE TITLE FROM FIRST MESSAGE
  if (session.messages.length === 0) {
    session.title = deriveTitle(text, 40);
  }

  session.messages.push({
    sender,
    text,
    timestamp: new Date()
  });

  await session.save();

  return session;
};

const remove = async (id, userEmail) => {
  const session = await ChatSession.findById(id);
  if (!session) return null;

  if (userEmail && session.userEmail !== userEmail) {
    throw ApiError.unauthorized("You cannot delete another user's chat");
  }

  await session.deleteOne();

  return session;
};

const clearForUser = async (userEmail) => ChatSession.deleteMany({ userEmail });

export {
  deriveTitle,
  create,
  getById,
  getForUser,
  listForUser,
  listRecentForUser,
  appendMessage,
  remove,
  clearForUser,
};
