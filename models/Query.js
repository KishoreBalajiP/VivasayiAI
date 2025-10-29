import mongoose from "mongoose";

const querySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  sessionId: { type: String }, // Optional: group conversations by session
  queryText: { type: String, required: true },
  responseText: { type: String },        // AI's answer
  attachments: [{ type: String }],      // image/file URLs
  location: { type: String },           // district name or GPS info
  contextId: { type: mongoose.Schema.Types.ObjectId, ref: "Context" }, // link to district context
}, { timestamps: true });

// Index for faster conversation retrieval
querySchema.index({ userId: 1, createdAt: -1 });
querySchema.index({ userId: 1, sessionId: 1, createdAt: -1 });

export default mongoose.model("Query", querySchema);