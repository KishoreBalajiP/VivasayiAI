import cors from "cors";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";

const allowedOrigins = new Set(env.corsOrigins);

// Response headers a browser on another origin may read (ADR-022): the frontend honours
// `Retry-After` / `RateLimit-Reset` when it is rate limited and shows `x-request-id` as a support
// reference. Without this list the browser hides them.
export const EXPOSED_HEADERS = Object.freeze(["Retry-After", "x-request-id", "RateLimit-Reset"]);

const corsMiddleware = cors({
  credentials: true,
  exposedHeaders: [...EXPOSED_HEADERS],
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(ApiError.forbidden("Origin not allowed"));
  },
});

export default corsMiddleware;
