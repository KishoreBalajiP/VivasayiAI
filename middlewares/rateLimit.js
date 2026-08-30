import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import ApiResponse from "../utils/ApiResponse.js";
import { env } from "../config/env.js";

const handleLimitExceeded = (req, res, next, options) => {
  res.status(options.statusCode).json(
    new ApiResponse(options.statusCode, "Too many requests, please try again later.", {})
  );
};

const authLimiter = rateLimit({
  windowMs: env.authRateLimitWindowMs,
  limit: env.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
});

// E1-S5 (D-35): rate-limit keyed by the authenticated user's cognitoSub (req.user.id), never a
// client-supplied email. Runs after requireAuth, so req.user is populated.
const chatKeyGenerator = (req) =>
  req.user?.id || ipKeyGenerator(req.ip || "unknown");

const chatLimiter = rateLimit({
  windowMs: env.chatRateLimitWindowMs,
  limit: env.chatRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
  keyGenerator: chatKeyGenerator,
});

const chatDailyLimiter = rateLimit({
  windowMs: env.chatDailyRateLimitWindowMs,
  limit: env.chatDailyRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
  keyGenerator: chatKeyGenerator,
});

export { authLimiter, chatLimiter, chatDailyLimiter };
