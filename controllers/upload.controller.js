import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as uploadService from "../services/upload.service.js";

// E3-S1 thin controller (12 §4): delegates to the upload service. Identity is never read
// from the body/query — the caller is established by requireAuth (req.user) on the route.
const uploadImage = asyncHandler(async (req, res) => {
  const result = uploadService.receiveUpload({
    size: req.upload.size,
    mimetype: req.upload.mimetype,
  });

  return ApiResponse.success(res, "Image uploaded successfully", result);
});

export { uploadImage };