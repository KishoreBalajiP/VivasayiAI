import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { env } from "./env.js";

let isConnected = false;

export const connectDB = async () => {
  if (isConnected) return;
  try {
    const conn = await mongoose.connect(env.mongoUri);
    isConnected = true;
    logger.info({ host: conn.connection.host }, "MongoDB connected");
  } catch (error) {
    logger.error({ err: error }, "MongoDB connection failed");
    process.exit(1);
  }
};
