import express from "express";
import { uploadSingle, validateUploadedImage } from "../middlewares/upload.js";
import { uploadLimiter } from "../middlewares/rateLimit.js";
import validate from "../middlewares/validate.js";
import { presignUploadBody, uploadParams } from "../utils/validation.schemas.js";
import {
  uploadImage,
  presignUpload,
  completeImageUpload,
} from "../controllers/upload.controller.js";

const router = express.Router();

// E3 (D-22 Option 1): multipart image upload + storage pipeline — kept ONLY as a deprecated,
// backward-compat transport during presigned-S3 migration. Auth is enforced app-wide by
// requireAuth (this router is mounted after it in index.js). Per-user rate limit, in-memory
// parse, magic-byte validation, normalization (sharp), private-S3 storage and a
// metadata-only response — see services/upload.service.js. Analysis happens later via
// POST /chat with the returned uploadId (services/chatImage.service.js).
router.post("/", uploadLimiter, uploadSingle, validateUploadedImage, uploadImage);

// E3 presigned transport (production path): GET capability → Browser→S3 PUT → verify+normalize.
// Both are small JSON bodies behind the same per-user limiter; the image binary itself never
// transits API Gateway/Lambda (services/uploadPresign.service.js).
router.post("/presign", uploadLimiter, validate(presignUploadBody), presignUpload);
router.post(
  "/:uploadId/complete",
  uploadLimiter,
  validate(uploadParams, "params"),
  completeImageUpload
);

export default router;