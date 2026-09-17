import { z } from "zod";
import { env } from "../config/env.js";

const MONGO_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const email = (requiredMessage = "Email is required") =>
  z
    .string({ message: requiredMessage })
    .trim()
    .min(1, requiredMessage)
    .email("Invalid email format");

const mongoId = (message = "Invalid ID format") =>
  z.string({ message }).trim().regex(MONGO_ID_PATTERN, message);

const requiredText = (message, max = env.messageMaxLength) =>
  z
    .string({ message })
    .trim()
    .min(1, message)
    .max(max, `Exceeds ${max} character limit`);

const sender = z
  .string({ message: "Sender and text required" })
  .trim()
  .min(1, "Sender and text required")
  .pipe(
    z.enum(["user", "ai", "system"], {
      message: "sender must be 'user', 'ai', or 'system'",
    })
  );

const language = z.enum(["en", "ta"], {
  message: "language must be 'en' or 'ta'",
});

// E3: server-generated image identifier from POST /upload (`img_<uuid>`).
const uploadId = z
  .string({ message: "Invalid image upload ID" })
  .trim()
  .regex(/^img_[0-9a-fA-F-]{36}$/, "Invalid image upload ID");

const title = z
  .string()
  .trim()
  .max(200, "Title exceeds 200 character limit")
  .optional();

const authCode = z
  .string({ message: "Missing authorization code" })
  .trim()
  .min(1, "Missing authorization code");

const googleLoginBody = z.object({ code: authCode });

// Reusable free-form district name validator (E2-S1 weather + E2-S3 chat context assembly).
// Resolved server-side via geocoding / the `districts` reference collection; we only cap length.
const weatherDistrict = z
  .string({ message: "District is required" })
  .trim()
  .min(1, "District is required")
  .max(80, "District name exceeds 80 character limit");

const chatBody = z
  .object({
    // E3: `message` becomes optional when an image is attached (`uploadId`).
    message: requiredText("Message is required").optional(),
    chatId: mongoId("Invalid chat ID format").optional(),
    language: language.optional(),
    // Context assembly input (E2-S3): optional farmer district captured by the client.
    district: weatherDistrict.optional(),
    // E3: attach a previously uploaded image to this turn (POST /chat → image diagnosis).
    uploadId: uploadId.optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.message && !data.uploadId) {
      ctx.addIssue({
        code: "custom",
        path: ["message"],
        message: "Message is required",
      });
    }
  });

const chatParams = z.object({ chatId: mongoId("Invalid chat ID format") });

// E3 presigned upload (services/uploadPresign.service.js): only the metadata needed to
// authorize a direct-to-S3 upload. The server always owns the S3 key and the uploadId;
// filename is metadata-only, validated as an input-hygiene guard (never used in keys).
const presignUploadContentType = z.enum(
  ["image/jpeg", "image/png", "image/webp"],
  { message: "Unsupported image type" }
);
const presignUploadSize = z
  .number({ message: "File size is required" })
  .int("File size is required")
  .positive("File size must be greater than 0")
  .max(1e9, "Image exceeds the maximum allowed size");
const presignUploadBody = z.object({
  contentType: presignUploadContentType,
  size: presignUploadSize,
  filename: z
    .string()
    .trim()
    .max(200, "Filename is invalid")
    .regex(/^[^\\/\u0000]+$/, "Filename is invalid")
    .min(1, "Filename is invalid")
    .optional(),
});

// Param for POST /upload/:uploadId/complete — same server-generated id format as /chat's.
const uploadParams = z.object({ uploadId });

const createSessionBody = z.object({ title });

const messageBody = z.object({
  sender,
  text: requiredText("Sender and text required"),
});

const sessionParams = z.object({ id: mongoId("Invalid session ID format") });

const weatherQuery = z.object({ district: weatherDistrict });

// Farm profile (E2-S4, D-10 Option 1): district + non-empty crops + positive acres.
// Soil type and phone are excluded per APP-10 minimization (D-10) — not collected.
// E1-S5 (D-35): ownership derives from the verified token (req.user), not the body.
const crop = requiredText("Crop name is required", 100);
const farmProfileBody = z.object({
  district: weatherDistrict,
  crops: z
    .array(crop, { message: "crops must be a non-empty array of crop names" })
    .min(1, "At least one crop is required")
    .max(20, "Too many crops listed"),
  acres: z
    .number({ message: "acres is required" })
    .positive("Acres must be greater than 0")
    .max(1e6, "Acres too large"),
  language: language.optional(),
});

export {
  googleLoginBody,
  chatBody,
  chatParams,
  createSessionBody,
  messageBody,
  sessionParams,
  weatherQuery,
  farmProfileBody,
  presignUploadBody,
  uploadParams,
};
