import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    email: { type: String, unique: true, lowercase: true, trim: true },

    // Stable Cognito identity. This is the ownership key used throughout the app.
    cognitoSub: { type: String, unique: true, sparse: true, index: true },

    language: { type: String },

    // Admin authorization. Never accept this value from the client.
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
      index: true,
    },

    // Admin can disable an account without deleting its data.
    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
      index: true,
    },

    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
