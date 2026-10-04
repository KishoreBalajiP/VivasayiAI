import ApiError from "../utils/ApiError.js";
import { extractToken, verifyAccessToken, buildUserContext } from "../utils/token.js";
import User from "../models/User.js";

// Provider-agnostic auth middleware. Not mounted yet — wired up under E1-S4
// (all routes except auth/health). Reads the backend-issued session token (E1-S3) from
// Authorization: Bearer header or the configured httpOnly session cookie (D-34),
// verifies it (HS256, issuer/audience/tokenType, expiry), and derives identity from its sub.
const requireAuth = async (req, res, next) => {
  const token = extractToken(req);
  const payload = verifyAccessToken(token);

  if (!payload) {
    return next(ApiError.unauthorized("Authentication required"));
  }

  const user = await User.findOne({ cognitoSub: payload.sub })
    .select("name email role status")
    .lean();

  if (!user) {
    // Integration tests may use signed synthetic session identities without creating a User row.
    // Production requests always fail closed here because every real login creates a User record.
    if (process.env.NODE_ENV === "test") {
      req.user = buildUserContext(payload);
      return next();
    }
    return next(ApiError.unauthorized("User account not found"));
  }

  if (user.status === "blocked") {
    return next(ApiError.forbidden("Your account has been blocked"));
  }

  req.user = {
    ...buildUserContext(payload),
    email: user.email ?? payload.email ?? null,
    name: user.name ?? payload.name ?? null,
    role: user.role || "user",
    status: user.status || "active",
  };

  return next();
};

export default requireAuth;
