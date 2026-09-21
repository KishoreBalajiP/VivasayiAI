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

// F-49 (ADR-019 — 15_Security §5): per-user claim and claim-evidence rate limits, keyed by the
// authenticated cognitoSub (same pattern as the chat/session/upload limiters — runs after
// requireAuth). Defaults match .env.example: 5 claims/hour, 20 evidence uploads/hour per user.
const claimLimiter = rateLimit({
  windowMs: env.claimRateLimitWindowMs,
  limit: env.claimRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
  keyGenerator: chatKeyGenerator,
});

const evidenceLimiter = rateLimit({
  windowMs: env.evidenceRateLimitWindowMs,
  limit: env.evidenceRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
  keyGenerator: chatKeyGenerator,
});

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

const sessionMutationLimiter = rateLimit({
  windowMs: env.sessionMutationRateLimitWindowMs,
  limit: env.sessionMutationRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
  keyGenerator: chatKeyGenerator,
});

// E3-S1: uploads are per-user rate limited (multipart bytes hit Lambda memory; bounded by
// limit + body-size cap — D-22/D-38). Runs after requireAuth, so keyed by req.user.id.
const uploadLimiter = rateLimit({
  windowMs: env.uploadRateLimitWindowMs,
  limit: env.uploadRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handleLimitExceeded,
  keyGenerator: chatKeyGenerator,
});

export {
  authLimiter,
  chatLimiter,
  chatDailyLimiter,
  sessionMutationLimiter,
  uploadLimiter,
  claimLimiter,
  evidenceLimiter,
};
