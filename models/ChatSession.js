import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  sender: { type: String, enum: ["user", "ai", "system"], required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
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
  