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

const chatBody = z.object({
  message: requiredText("Message is required"),
  userEmail: email("userEmail is required"),
  chatId: mongoId("Invalid chat ID format").optional(),
  language: language.optional(),
  // Context assembly input (E2-S3): optional farmer district captured by the client.
  district: weatherDistrict.optional(),
});

const chatParams = z.object({ chatId: mongoId("Invalid chat ID format") });

const userEmailQuery = z.object({ userEmail: email("User email is required") });

const createSessionBody = z.object({ userEmail: email("User email required"), title });

const listParams = z.object({ email: email("Email required") });

const messageBody = z.object({
  sender,
  text: requiredText("Sender and text required"),
});

const sessionParams = z.object({ id: mongoId("Invalid session ID format") });

const deleteBody = z.object({ userEmail: email().optional() });

const clearAllBody = z.object({ userEmail: email("User email required") });

const weatherQuery = z.object({ district: weatherDistrict });

// Farm profile (E2-S4, D-10 Option 1): district + non-empty crops + positive acres.
// Soil type and phone are excluded per APP-10 minimization (D-10) — not collected.
const crop = requiredText("Crop name is required", 100);
const farmProfileBody = z.object({
  userEmail: email("userEmail is required"),
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
  userEmailQuery,
  createSessionBody,
  listParams,
  messageBody,
  sessionParams,
  deleteBody,
  clearAllBody,
  weatherQuery,
  farmProfileBody,
};
