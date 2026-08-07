import mongoose from "mongoose";
import { env } from "./env.js";

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) return;
  try {
    const conn = await mongoose.connect(env.mongoUri);
    isConnected = true;
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};
