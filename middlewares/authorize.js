import ApiError from "../utils/ApiError.js";

// Authorization gate factories. Run AFTER requireAuth (req.user must exist).
// Provider-agnostic: they only read req.user, never tokens or the DB.

// requireRole(...roles) — allow only requests whose req.user.role is listed.
// Provider-agnostic: they only read req.user, never tokens or the DB. Mounted by the admin
// router (app.js /admin) since Phase 10 (E9-S10); role is minted into the session token at
// login from the verified Cognito identity (services/auth.service.js).
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized("Authentication required"));
  }

  const { role } = req.user;
  if (!role || !allowedRoles.includes(role)) {
    return next(ApiError.forbidden("Insufficient permissions"));
  }

  return next();
};

// authorize(assertAllowed) — generic gate for any policy (e.g. ownership in T-108).
// assertAllowed(req) returns boolean; deny -> 403.
const authorize = (assertAllowed) => (req, res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized("Authentication required"));
  }

  if (!assertAllowed(req)) {
    return next(ApiError.forbidden("Insufficient permissions"));
  }

  return next();
};

export { requireRole, authorize };
