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

const SESSION_ISSUER = "vivasayi-api";

// E1-S3: refuse to sign/verify session tokens when the signing secret is unset (fail closed).
const requireSessionSecret = () => {
  const secret = env.sessionJwtSecret;
  if (!secret || typeof secret !== "string" || secret.length < 16) {
    throw new Error("SESSION_JWT_SECRET is not configured (E1-S3 session tokens)");
  }
  return secret;
};

// E1-S3 (ADR-013 / D-34): sign a short-lived access token carrying the stable cognitoSub identity.
const signAccessToken = (identity) => {
  const secret = requireSessionSecret();
  return jwt.sign(
    {
      sub: identity.cognitoSub,
      email: identity.email ?? null,
      name: identity.name ?? null,
      tokenType: "access",
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: Math.floor(env.accessTokenTtlMs / 1000),
      issuer: SESSION_ISSUER,
      audience: "session",
    }
  );
};

// E1-S3: sign a longer-lived refresh token. Rotating/revocable lifecycle is deferred to a later
// story (ADR-013 note); this only mints the refresh credential at login.
const signRefreshToken = (identity) => {
  const secret = requireSessionSecret();
  return jwt.sign(
    { sub: identity.cognitoSub, tokenType: "refresh" },
    secret,
    {
      algorithm: "HS256",
      expiresIn: Math.floor(env.refreshTokenTtlMs / 1000),
      issuer: SESSION_ISSUER,
      audience: "session",
    }
  );
};

// E1-S3: verify a backend-issued access token. Fails closed (null) on any mismatch — HS256-only,
// issuer/audience/tokenType pinned, signature + expiry enforced by jsonwebtoken.
const verifyAccessToken = (token) => {
  if (!token || typeof token !== "string") return null;
  const secret = env.sessionJwtSecret;
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: SESSION_ISSUER,
      audience: "session",
    });
    if (decoded.tokenType !== "access") return null;
    if (typeof decoded.sub !== "string") return null;
    return decoded;
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

export {
  extractToken,
  verifyToken,
  verifyAccessToken,
  signAccessToken,
  signRefreshToken,
  buildUserContext,
};
