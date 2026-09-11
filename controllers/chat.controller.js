import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { generateResponse } from "../services/chat.service.js";

const chat = asyncHandler(async (req, res) => {
  const result = await generateResponse({
    ...req.body,
    cognitoSub: req.user.id,
    email: req.user.email,
  });

  return ApiResponse.success(res, "Chat response generated successfully", result);
});

export default chat;
