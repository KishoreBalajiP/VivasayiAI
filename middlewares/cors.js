import cors from "cors";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";

const allowedOrigins = new Set(env.corsOrigins);

const corsMiddleware = cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(ApiError.forbidden("Origin not allowed"));
  },
});

export default corsMiddleware;
