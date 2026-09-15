import sharp from "sharp";
import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import { env } from "../config/env.js";

// E3 (D-22 Option 1): image normalization, the "process" step between validate and store.
//
//  - Decode safety: sharp must fully decode the payload. Magic bytes alone (E3-S1) prove
//    the outer container, but the AI pipeline additionally requires a real, safe image —
//    anything that fails `failOn: "error"` decode, or exceeds the pixel-count guard, is a
//    clean 4xx (validation), never a 5xx. This also bounds decompression memory.
//  - Normalization: the image is re-encoded in its original family (png/jpeg/webp) with
//    EXIF/thumbnail metadata dropped (privacy — APP-10 minimization; D-23), orientation
//    applied, and its longest edge capped at IMAGE_MAX_DIMENSION (a configurable default,
//    pending product tuning per D-22 — never enlarges).
//
// The returned buffer is the ONLY image that ever gets stored; the original upload bytes
// are released after this step.

const PNG_MIME = "image/png";
const WEBP_MIME = "image/webp";
const JPEG_MIME = "image/jpeg";

export const normalizeImage = async ({ buffer, mediaType }) => {
  const inputGuard = 20 * 1024 * 1024; // 20MP decode guard — keeps decompression bounded.
  try {
    // Pass 1: header-level read to fail fast on genuinely non-decodable input.
    const probe = sharp(buffer, { failOn: "error", limitInputPixels: inputGuard });
    const metadata = await probe.metadata();
    if (!metadata.format || !metadata.width || !metadata.height) {
      throw new Error("undecodable image");
    }

    const width = metadata.width;
    const height = metadata.height;
    const longestEdge = Math.max(width, height);
    const scale = Math.min(1, env.imageMaxDimension / longestEdge);

    let pipeline = sharp(buffer, { failOn: "error", limitInputPixels: inputGuard });

    // Apply EXIF orientation so the stored + analyzed image is upright (the re-encode then
    // drops the EXIF block itself — no `withMetadata()` is called anywhere in this step).
    pipeline = pipeline.rotate();

    if (scale < 1) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    switch (mediaType) {
      case PNG_MIME:
        pipeline = pipeline.png();
        break;
      case WEBP_MIME:
        pipeline = pipeline.webp();
        break;
      default:
        pipeline = pipeline.jpeg();
    }

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    const normalizedMime =
      info.format === "png" ? PNG_MIME : info.format === "webp" ? WEBP_MIME : JPEG_MIME;

    return {
      buffer: data,
      processed: {
        mediaType: normalizedMime,
        size: data.length,
        width: info.width,
        height: info.height,
      },
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.warn({ err: error }, "Image normalization failed");
    throw ApiError.badRequest("Invalid or unsupported image content");
  }
};

export default { normalizeImage };