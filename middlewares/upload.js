import multer from "multer";
import ApiError from "../utils/ApiError.js";
import { env } from "../config/env.js";
import {
  ALLOWED_IMAGE_MIME_TYPES,
  detectImageMime,
} from "../utils/imageFormat.js";

// E3-S1 (D-22 Option 1): multipart-to-backend transport, validated in one place.
// Images are buffered in memory ONLY for the duration of the request (bounded by
// IMAGE_UPLOAD_MAX_BYTES, ≤5MB default, and a per-user rate limit). No file is
// written to disk and nothing is persisted — S3 storage is E3-S2 (D-23 pending).
//
// Size is enforced by our own storage (not busboy's limits.fileSize): busboy truncates
// a part at the limit and then fails the whole multipart parse ("Unexpected end of
// form"), producing a misleading error. Here we simply stop accumulating once the cap
// is crossed and fail with a clean MulterError (413). Memory stays bounded — bytes over
// the cap are discarded, not stored.
const cappedMemoryStorage = {
  _handleFile(req, file, cb) {
    const chunks = [];
    let total = 0;
    let settled = false;

    file.stream.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > env.imageUploadMaxBytes) {
        settled = true;
        return cb(new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname));
      }
      chunks.push(chunk);
    });
    file.stream.on("end", () => {
      if (settled) return;
      settled = true;
      cb(null, { buffer: Buffer.concat(chunks), size: total });
    });
    file.stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      cb(err);
    });
  },
  _removeFile(req, file, cb) {
    delete file.buffer;
    cb(null);
  },
};

const uploadMulter = multer({
  storage: cappedMemoryStorage,
  limits: {
    files: 1,
    fields: 100,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(ApiError.badRequest("Unsupported image type"));
    }
    cb(null, true);
  },
});

// Map multer/busboy failures to sanitized ApiErrors (errorHandler returns only the
// literal message — no stack, no filename, no filesystem/path details). Anything that
// reaches this point originated from parsing the client's multipart body (multer
// MulterErrors, busboy framing errors), so it must be a clean 4xx, never a 500.
const mapUploadError = (err) => {
  if (err instanceof ApiError) return err;
  if (err && err.code) {
    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        return new ApiError(413, "Image exceeds the maximum allowed size");
      case "LIMIT_FILE_COUNT":
        return ApiError.badRequest("Only one image file is allowed per upload");
      case "LIMIT_UNEXPECTED_FILE":
        return ApiError.badRequest("Unexpected form field or file");
      default:
        return ApiError.badRequest("Invalid or unsupported image content");
    }
  }
  return ApiError.badRequest("Invalid or unsupported image content");
};

// Express middleware: run multer.single("image") and convert any multer error into a
// sanitized ApiError flow (avoiding a raw 500 for LIMIT_*/fileFilter failures).
export const uploadSingle = (req, res, next) => {
  uploadMulter.single("image")(req, res, (err) => {
    if (err) return next(mapUploadError(err));
    return next();
  });
};

// Runs after a successful multipart parse: a file must be present, its bytes must be a
// real approved image, and the bytes must match the client-declared MIME type (no
// arbitrary files renamed with an image extension pass). Identity is never read here —
// ownership comes only from the authenticated request (requireAuth / req.user).
export const validateUploadedImage = (req, res, next) => {
  if (!req.file) {
    return next(ApiError.badRequest("Image file is required"));
  }

  // Defensive size gate (belt-and-suspenders on top of multer's limits.fileSize).
  if (req.file.size > env.imageUploadMaxBytes) {
    return next(new ApiError(413, "Image exceeds the maximum allowed size"));
  }

  const sniffed = detectImageMime(req.file.buffer);
  if (!sniffed) {
    return next(ApiError.badRequest("Invalid or unsupported image content"));
  }
  if (sniffed !== req.file.mimetype) {
    return next(
      ApiError.badRequest("Image content does not match its declared type")
    );
  }

  req.upload = {
    size: req.file.size,
    mimetype: req.file.mimetype,
  };
  return next();
};