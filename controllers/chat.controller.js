import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { generateResponse } from "../services/chat.service.js";
import { generateImageResponse } from "../services/chatImage.service.js";

// POST /chat accepts either a plain message (text chat, chat.service.js) or an uploadId
// (image diagnosis, chatImage.service.js). Ownership derives from the verified token
// (req.user) — never from the body (E1-S5 / D-35). Both paths return the same envelope
// (chatId, messages, response, hasContext, ...) so the frontend contract is uniform.
const chat = asyncHandler(async (req, res) => {
  const { uploadId } = req.body;

  const result = uploadId
    ? await generateImageResponse({
        ...req.body,
        cognitoSub: req.user.id,
        email: req.user.email,
      })
    : await generateResponse({
        ...req.body,
        cognitoSub: req.user.id,
        email: req.user.email,
      });

  return ApiResponse.success(res, "Chat response generated successfully", result);
});

export default chat;