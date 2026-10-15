import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  sender: { type: String, enum: ["user", "ai", "system"], required: true },
  // E3: `text` is required for plain turns, but an image-only turn legitimately carries no
  // text — Mongoose treats "" as missing, so require() is conditional on the image link.
  text: {
    type: String,
    required: function () { return !this.imageId; },
  },
  // E3: link-only reference to an attached image turn. Binary is never stored here — the
  // value is the server-generated uploadId (`img_<uuid>`), which keys ImageRecord (S3 +
  // vision metadata).
  imageId: { type: String, default: undefined },
  timestamp: { type: Date, default: Date.now },
  // Set on messages a CLIENT wrote through POST /chatsessions/:id/message. Messages produced by the
  // server (POST /chat) carry no origin. Client-authored non-user messages are never replayed to the
  // model as earlier assistant or system turns (see ConversationFormatter), so a caller cannot plant
  // fake assistant output in their own prompt history.
  origin: { type: String, enum: ["client"], default: undefined },
}, { _id: false });

const chatSessionSchema = new mongoose.Schema({
  // E1-S5 (D-35): ownership scoped by the authenticated user's stable cognitoSub (immutable,
  // non-spoofable). userEmail retained as a display/legacy dual-key (07_Database_Design §6).
  cognitoSub: { type: String, required: true, index: true },
  userEmail: { type: String, index: true },
  title: { type: String, default: "New Chat" },
  messages: { type: [messageSchema], default: [] },
}, { timestamps: true });

// Production-safety: index the `List recent sessions` query (find by cognitoSub, sort by
// updatedAt desc) so reads stay efficient as sessions grow. The per-field indexes alone
// can only serve the filter, not the sort, without a blocking sort.
chatSessionSchema.index({ cognitoSub: 1, updatedAt: -1 });

export default mongoose.model("ChatSession", chatSessionSchema);
  