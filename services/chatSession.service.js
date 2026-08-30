import ChatSession from "../models/ChatSession.js";

// E1-S5 (D-35): all session queries are scoped by the authenticated user's cognitoSub
// (derived from the verified token via req.user.id). Foreign resources return null (404).
// userEmail is retained as a display/legacy dual-key; it is set server-side, never from the client.

// Shared title truncation (per-call-site lengths preserved: 50 on create, 40 on first append)
const deriveTitle = (text, maxLength) => text.slice(0, maxLength);

const create = async ({ cognitoSub, email, title }) =>
  ChatSession.create({
    cognitoSub,
    userEmail: email ?? null,
    title: title || "New Chat",
    messages: []
  });

// Owned read: returns null for foreign/unowned sessions (404 upstream).
const getForUser = async (chatId, cognitoSub) =>
  ChatSession.findOne({ _id: chatId, cognitoSub });

const sessionsByUserQuery = (cognitoSub) =>
  ChatSession.find({ cognitoSub }).sort({ updatedAt: -1 });

const listForUser = (cognitoSub) => sessionsByUserQuery(cognitoSub);

const listRecentForUser = (cognitoSub) =>
  sessionsByUserQuery(cognitoSub).select("_id title updatedAt createdAt messages").limit(50);

// Append only to a session owned by the caller; foreign sessions return null (404 upstream).
const appendMessage = async (id, cognitoSub, { sender, text }) => {
  const session = await ChatSession.findOne({ _id: id, cognitoSub });
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

// Delete only the caller's session; foreign sessions return null (404 upstream).
const remove = async (id, cognitoSub) => {
  const session = await ChatSession.findOneAndDelete({ _id: id, cognitoSub });
  return session;
};

const clearForUser = async (cognitoSub) => ChatSession.deleteMany({ cognitoSub });

export {
  deriveTitle,
  create,
  getForUser,
  listForUser,
  listRecentForUser,
  appendMessage,
  remove,
  clearForUser,
};
