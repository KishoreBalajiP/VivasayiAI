import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  language: { type: String, default: "ta" },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("User", userSchema);
