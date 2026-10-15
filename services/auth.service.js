import axios from "axios";
import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { verifyToken, signAccessToken, signRefreshToken } from "../utils/token.js";
import { env } from "../config/env.js";

const COGNITO_TIMEOUT_MS = 10000;

// Log only what is needed to diagnose a failure. The raw AxiosError must never be logged: its
// `config` carries the request body (client_secret and the one-time authorization code) and headers.
const describeError = (error) => {
  if (error?.isAxiosError) {
    return {
      status: error.response?.status ?? null,
      providerError: error.response?.data?.error ?? null,
      code: error.code ?? null,
      message: error.message,
    };
  }
  return { message: error?.message ?? String(error), name: error?.name ?? "Error" };
};

const isTrue = (value) => value === true || value === "true";

const googleSignIn = async (code) => {
  const clientId = env.cognitoClientId;
  const clientSecret = env.cognitoClientSecret || "";
  const redirectUri = env.cognitoRedirectUri;
  const domain = env.cognitoDomain;

  const params = new URLSearchParams();
  params.append("grant_type", "authorization_code");
  params.append("client_id", clientId);
  if (clientSecret) params.append("client_secret", clientSecret);
  params.append("redirect_uri", redirectUri);
  params.append("code", code);

  try {
    const tokenRes = await axios.post(
      `https://${domain}/oauth2/token`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: COGNITO_TIMEOUT_MS }
    );

    const { id_token } = tokenRes.data;
    const decoded = await verifyToken(id_token);

    if (!decoded) {
      throw ApiError.unauthorized("Invalid ID token");
    }

    const { email, name } = decoded;
    const cognitoSub = decoded.sub;

    // Phase 10 (E9-S10): the admin role derives ONLY from the verified Cognito identity
    // (cognito:groups / custom:role claims) — never from a client-supplied value. Whatever the
    // user object stores, the token is minted here with the authoritative role.
    const groups = Array.isArray(decoded?.["cognito:groups"]) ? decoded["cognito:groups"] : [];
    const role =
      groups.includes("admin") || String(decoded?.["custom:role"] || "") === "admin"
        ? "admin"
        : "farmer";

    // E1-S3: stable identity = cognitoSub (07_Database_Design §6). Look up by cognitoSub first; if
    // that misses, a LEGACY email-keyed record (no cognitoSub yet) may be linked — but only when the
    // identity provider vouches for the email, and never over a record already bound to a different
    // Cognito identity (that would let a second identity with the same email take the account).
    let user = await User.findOne({ cognitoSub });
    if (!user) {
      const legacy = email ? await User.findOne({ email }) : null;
      if (legacy) {
        if (legacy.cognitoSub && legacy.cognitoSub !== cognitoSub) {
          logger.warn({ cognitoSub }, "Login refused: email is bound to a different identity");
          throw ApiError.conflict("This email is already linked to a different account");
        }
        if (!isTrue(decoded.email_verified)) {
          logger.warn({ cognitoSub }, "Login refused: unverified email cannot link a legacy account");
          throw ApiError.forbidden("Email address is not verified");
        }
        legacy.cognitoSub = cognitoSub;
        await legacy.save();
        user = legacy;
      } else {
        user = await User.create({ name, email, cognitoSub });
      }
    }

    const accessToken = signAccessToken({ cognitoSub, email, name, role });
    const refreshToken = signRefreshToken({ cognitoSub });

    return { user, accessToken, refreshToken, role };
  } catch (error) {
    // Deliberate API errors (401/403/409 above) pass through unchanged.
    if (error instanceof ApiError) throw error;

    logger.error(describeError(error), "Auth error");

    if (error?.isAxiosError) {
      const status = error.response?.status;
      // The token endpoint rejected the code (invalid_grant, redirect mismatch, ...): the caller's
      // problem, not an outage.
      if (status && status >= 400 && status < 500) {
        throw ApiError.unauthorized("Invalid or expired authorization code");
      }
      // No response, a timeout or a 5xx from Cognito: the provider is unavailable.
      throw new ApiError(502, "Authentication provider unavailable");
    }
    throw new ApiError(500, "Authentication failed");
  }
};

export { googleSignIn };
