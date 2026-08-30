import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { googleSignIn } from "../services/auth.service.js";

// Google OAuth login
const googleLogin = asyncHandler(async (req, res) => {
  const { code } = req.body;

  // E1-S3: returns backend-issued session tokens (access + refresh) instead of the raw Cognito
  // id_token (ADR-013 / D-34; SEC-06). Refresh endpoint/logout are later stories.
  const { user, accessToken, refreshToken } = await googleSignIn(code);

  return ApiResponse.success(res, "Login successful", {
    user,
    accessToken,
    refreshToken,
  });
});

export { googleLogin };
