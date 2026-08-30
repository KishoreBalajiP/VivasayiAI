import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { isCognitoIssuer, getKey } from "./jwks.js";

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

// E1-S2: replace jwt.decode with real server-side verification.
// Returns the verified payload, or `null` on ANY failure (fail closed). Never falls back to
// unverified decoding. Auth flow: signature (Cognito JWKS via the token's constrained issuer),
// issuer family, audience (= Cognito app client id), expiry, and RS256-only.
const verifyToken = async (token) => {
  if (!token || typeof token !== "string") return null;

  let header;
  let payload;
  try {
    header = jwt.decode(token, { complete: true })?.header;
    payload = jwt.decode(token);
  } catch {
    return null;
  }
  if (!header || typeof header.kid !== "string") return null;
  if (!payload || typeof payload.iss !== "string") return null;

  // Restrict the issuer to the AWS Cognito family before trusting its JWKS (SSRF + forgery guard).
  if (!isCognitoIssuer(payload.iss)) return null;

  const key = await getKey(payload.iss, header.kid);
  if (!key) return null;

  try {
    const verified = jwt.verify(token, key, {
      algorithms: ["RS256"],
      audience: env.cognitoClientId,
    });
    return verified;
  } catch {
    return null;
  }
};

const buildUserContext = (payload) => ({
  id: payload?.sub || null,
  email: payload?.email || null,
  name: payload?.name || null,
  role: payload?.role || null,
});

export { extractToken, verifyToken, buildUserContext };
