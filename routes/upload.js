import express from "express";
import { uploadSingle, validateUploadedImage } from "../middlewares/upload.js";
import { uploadLimiter } from "../middlewares/rateLimit.js";
import { uploadImage } from "../controllers/upload.controller.js";

const router = express.Router();

// E3 (D-22 Option 1): multipart image upload + storage pipeline. Auth is enforced app-wide
// by requireAuth (this router is mounted after it in index.js). Per-user rate limit,
// in-memory parse, magic-byte validation, normalization (sharp), private-S3 storage and a
// metadata-only response — see services/upload.service.js. Analysis happens later via
// POST /chat with the returned uploadId (services/chatImage.service.js).
router.post("/", uploadLimiter, uploadSingle, validateUploadedImage, uploadImage);

export default router;