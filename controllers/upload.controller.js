import asyncHandler from "../utils/asyncHandler.js";
import ApiResponse from "../utils/ApiResponse.js";
import { receiveUpload } from "../services/upload.service.js";
import {
  createPresignedUpload,
  completeUpload,
} from "../services/uploadPresign.service.js";

// E3 thin controller (12 §4): delegates to the upload service. Identity is never read
// from the body/query — the caller is established by requireAuth (req.user) on the route.
// The pipeline (validate → normalize → S3 store → metadata record) runs synchronously so a
// successful response means the image is durably stored and owned by the caller.
const uploadImage = asyncHandler(async (req, res) => {
  const result = await receiveUpload({
    buffer: req.upload.buffer,
    size: req.upload.size,
    mimetype: req.upload.mimetype,
    cognitoSub: req.user.id,
    email: req.user.email,
  });

  return ApiResponse.success(res, "Image uploaded successfully", result);
});

// E3 presigned transport: authorize a direct-to-S3 upload. Returns only the scoped
// { uploadId, uploadUrl, expiresIn }; the s3Key/config stay server-side.
const presignUpload = asyncHandler(async (req, res) => {
  const result = await createPresignedUpload({
    ...req.body,
    cognitoSub: req.user.id,
    email: req.user.email,
  });
  return ApiResponse.success(res, "Upload authorized", result);
});

// E3 presigned transport: verify the direct S3 upload server-side, normalize, and promote
// the record to the same "stored" state POST /upload produced.
const completeImageUpload = asyncHandler(async (req, res) => {
  const result = await completeUpload({
    uploadId: req.params.uploadId,
    cognitoSub: req.user.id,
  });
  return ApiResponse.success(res, "Image uploaded successfully", result);
});

export { uploadImage, presignUpload, completeImageUpload };
export default uploadImage;