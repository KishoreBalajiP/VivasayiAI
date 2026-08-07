import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { googleSignIn } from "../services/auth.service.js";

// Google OAuth login
const googleLogin = asyncHandler(async (req, res) => {
  const { code } = req.body;

  const { user, id_token } = await googleSignIn(code);

  return ApiResponse.success(res, "Login successful", { user, id_token });
});

export { googleLogin };
