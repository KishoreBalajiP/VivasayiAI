import express from "express";
import { uploadSingle, validateUploadedImage } from "../middlewares/upload.js";
import { uploadLimiter } from "../middlewares/rateLimit.js";
import { uploadImage } from "../controllers/upload.controller.js";

const router = express.Router();

// E3-S1: multipart image upload transport. Auth is enforced app-wide by requireAuth
// (this router is mounted after it in index.js). Per-user rate limit, in-memory parse,
// magic-byte validation, metadata-only response — see services/upload.service.js.
router.post("/", uploadLimiter, uploadSingle, validateUploadedImage, uploadImage);

export default router;