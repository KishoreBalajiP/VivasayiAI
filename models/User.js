import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  // E1-S3: stable, immutable, non-spoofable Cognito sub (07_Database_Design §6). Sparse unique so
  // legacy users without a sub don't collide; email stays for display only.
  cognitoSub: { type: String, unique: true, sparse: true },
  language: { type: String }, // user selects after login
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("User", userSchema);
