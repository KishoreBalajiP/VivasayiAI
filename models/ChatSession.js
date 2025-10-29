import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  sender: { type: String, enum: ["user", "ai", "system"], required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const chatSessionSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, index: true },
  title: { type: String, default: "New Chat" },
  messages: { type: [messageSchema], default: [] },
}, { timestamps: true });

export default mongoose.model("ChatSession", chatSessionSchema);
  