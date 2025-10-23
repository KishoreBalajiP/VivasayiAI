import mongoose from "mongoose";

const querySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  queryText: { type: String, required: true },
  responseText: { type: String },        // AI’s answer
  attachments: [{ type: String }],      // image/file URLs
  location: { type: String },           // district name or GPS info
  contextId: { type: mongoose.Schema.Types.ObjectId, ref: "Context" }, // link to district context
}, { timestamps: true });

export default mongoose.model("Query", querySchema);
