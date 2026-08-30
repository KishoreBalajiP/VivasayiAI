import ApiError from "../utils/ApiError.js";
import { extractToken, verifyAccessToken, buildUserContext } from "../utils/token.js";

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

  req.user = buildUserContext(payload);
  return next();
};

export default requireAuth;
