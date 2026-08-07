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

const chatKeyGenerator = (req) =>
  req.body?.userEmail || ipKeyGenerator(req.ip || "unknown");

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
