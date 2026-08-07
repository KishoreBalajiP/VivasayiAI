import axios from "axios";
import User from "../models/User.js";
import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { verifyToken } from "../utils/token.js";
import { env } from "../config/env.js";

// Google OAuth login
const googleLogin = asyncHandler(async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    throw ApiError.badRequest("Missing authorization code");
  }

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
    const decoded = verifyToken(id_token);

    if (!decoded) {
      throw ApiError.unauthorized("Invalid ID token");
    }

    const { email, name } = decoded;

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({ name, email });
    }

    return ApiResponse.success(res, "Login successful", { user, id_token });
    
  } catch (error) {
    console.error("Auth error:", error.response?.data || error.message);
    throw new ApiError(500, "Authentication failed");
  }
});

export { googleLogin };