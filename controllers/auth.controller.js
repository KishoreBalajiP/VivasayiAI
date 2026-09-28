import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { googleSignIn } from "../services/auth.service.js";

// Google OAuth login
const googleLogin = asyncHandler(async (req, res) => {
  const { code } = req.body;

  // E1-S3: returns backend-issued session tokens (access + refresh) instead of the raw Cognito
  // id_token (ADR-013 / D-34; SEC-06). Refresh endpoint/logout are later stories.
  const { user, accessToken, refreshToken, role } = await googleSignIn(code);

  // Phase 10 (E9-S10): the serialized user carries the authoritative role so the frontend can
  // gate the admin section without decoding tokens. `role` always derives from the verified
  // Cognito identity server-side — never from the client.
  const serializedUser = user && user.toObject ? { ...user.toObject(), role } : { role };

  return ApiResponse.success(res, "Login successful", {
    user: serializedUser,
    accessToken,
    refreshToken,
  });
});

export { googleLogin };
