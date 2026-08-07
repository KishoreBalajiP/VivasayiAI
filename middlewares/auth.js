import ApiError from "../utils/ApiError.js";
import { extractToken, verifyToken, buildUserContext } from "../utils/token.js";

// Provider-agnostic auth middleware. Not mounted yet — wired up under E1-S4
// (all routes except auth/health). Reads token from Authorization: Bearer
// header or the configured httpOnly session cookie (D-34).
const requireAuth = (req, res, next) => {
  const token = extractToken(req);
  const payload = verifyToken(token);

  if (!payload) {
    return next(ApiError.unauthorized("Authentication required"));
  }

  req.user = buildUserContext(payload);
  return next();
};

export default requireAuth;
