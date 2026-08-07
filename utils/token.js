import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const extractToken = (req) => {
  const header = req.headers?.authorization;
  if (header && header.startsWith("Bearer ")) {
    return header.slice(7).trim();
  }

  const cookieName = env.sessionCookieName;
  const cookieHeader = req.headers?.cookie;
  if (cookieHeader && cookieName) {
    for (const part of cookieHeader.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === cookieName) {
        return rest.join("=");
      }
    }
  }

  return null;
};

// Seam: E1-S2 replaces jwt.decode with JWKS signature/issuer/audience/expiry verification
const verifyToken = (token) => {
  if (!token || typeof token !== "string") return null;
  return jwt.decode(token);
};

const buildUserContext = (payload) => ({
  id: payload?.sub || null,
  email: payload?.email || null,
  name: payload?.name || null,
  role: payload?.role || null,
});

export { extractToken, verifyToken, buildUserContext };
