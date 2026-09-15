import axios from "axios";
import User from "../models/User.js";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { verifyToken, signAccessToken, signRefreshToken } from "../utils/token.js";
import { env } from "../config/env.js";

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
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { id_token } = tokenRes.data;
    const decoded = await verifyToken(id_token);

    if (!decoded) {
      throw ApiError.unauthorized("Invalid ID token");
    }

    const { email, name } = decoded;
    const cognitoSub = decoded.sub;

    // E1-S3: stable identity = cognitoSub (07_Database_Design §6). Look up by cognitoSub first; if
    // that misses, fall back to the legacy email-based record and backfill its cognitoSub, else create.
    let user = await User.findOne({ cognitoSub });
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.cognitoSub = cognitoSub;
        await user.save();
      } else {
        user = await User.create({ name, email, cognitoSub });
      }
    }

    const accessToken = signAccessToken({ cognitoSub, email, name });
    const refreshToken = signRefreshToken({ cognitoSub });

    return { user, accessToken, refreshToken };
  } catch (error) {
    logger.error({ err: error }, "Auth error");
    throw new ApiError(500, "Authentication failed");
  }
};

export { googleSignIn };
