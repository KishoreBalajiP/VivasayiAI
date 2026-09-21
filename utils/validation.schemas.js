import { z } from "zod";
import { env } from "../config/env.js";
import { validateParcelGeometry } from "../services/parcelGeometry.service.js";

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

// ----------------------------------------------------------------------------
// F-49 (Phase 1 — Farm Parcel Foundation, ADR-019 P1/P4/P10)
// Parcel CRUD under /profile/parcels. Ownership (cognitoSub) always derives from the verified
// token (req.user), never from the body. `parcelId` is always server-generated (`par_<uuid>`),
// clients can never choose or mutate it; `calculatedAreaAcres` is always computed server-side
// and is never accepted from the client.
// ----------------------------------------------------------------------------

const PARCEL_ID_PATTERN = /^par_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const parcelId = z
  .string({ message: "Invalid parcel ID" })
  .trim()
  .regex(PARCEL_ID_PATTERN, "Invalid parcel ID");

const parcelName = requiredText("Parcel name is required", 100);
const parcelCrop = requiredText("Crop name is required", 100);

// GeoJSON Polygon, WGS84 [lon, lat] in the coordinate plane; deep geometric checks (closure,
// self-intersection, non-degenerate area) are enforced in validateParcelGeometry, referenced
// below via superRefine. Only one exterior ring is allowed (no holes in MVP).
const lonCoordinate = z
  .number({ message: "Invalid longitude" })
  .finite("Coordinates must be finite numbers")
  .min(-180, "Longitude must be between -180 and 180")
  .max(180, "Longitude must be between -180 and 180");
const latCoordinate = z
  .number({ message: "Invalid latitude" })
  .finite("Coordinates must be finite numbers")
  .min(-90, "Latitude must be between -90 and 90")
  .max(90, "Latitude must be between -90 and 90");
const position = z.tuple([lonCoordinate, latCoordinate], {
  message: "Position must be [longitude, latitude]",
});
const linearRing = z.array(position, {
  message: "Linear ring must be an array of positions",
});

const polygonGeometry = z
  .object({
    type: z.literal("Polygon", { message: "geometry.type must be 'Polygon'" }),
    coordinates: z.array(linearRing, {
      message: "coordinates must be an array of linear rings",
    }),
  })
  .superRefine((geometry, ctx) => {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["coordinates"],
        message: "coordinates must contain at least one linear ring",
      });
    } else {
      const result = validateParcelGeometry(geometry);
      if (!result.ok) {
        ctx.addIssue({ code: "custom", path: ["geometry"], message: result.reason });
      }
    }
  });

const createParcelBody = z.object({
  name: parcelName,
  crop: parcelCrop,
  // Client-supplied area (calculatedAreaAcres / area / acres) is stripped by zod's default
  // object parsing (not strict), so it is silently ignored for authority — the server always
  // computes and stores its own value (P4). This matches existing validation conventions.
  geometry: polygonGeometry,
});

const patchParcelBody = z
  .object({
    name: parcelName.optional(),
    crop: parcelCrop.optional(),
    geometry: polygonGeometry.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field to update is required");

const parcelParams = z.object({ parcelId });

// ----------------------------------------------------------------------------
// F-49 (Phase 2 — Agricultural Loss Claim, ADR-019 P1/P2/P4/P9)
// Claim lifecycle + claim-scoped evidence. Ownership (cognitoSub) always derives from the
// verified token (req.user), never from the body. No client-supplied area, profile, parcel
// name/crop, or state is ever accepted (zod strips unknown keys) — the server is authoritative.
// ----------------------------------------------------------------------------

const claimId = mongoId("Invalid claim ID format");

const eventType = z.enum(
  ["flood", "storm", "drought", "pest", "disease", "fire", "other"],
  { message: "eventType must be one of flood, storm, drought, pest, disease, fire, other" }
);

const idempotencyKey = z
  .string({ message: "idempotencyKey is required" })
  .trim()
  .min(8, "idempotencyKey must be at least 8 characters")
  .max(64, "idempotencyKey exceeds 64 characters")
  .regex(/^[A-Za-z0-9_-]+$/, "idempotencyKey contains invalid characters");

// Accepts an ISO-8601 string (or numeric timestamp). Future/outside-window dates are rejected
// server-side in the service (P2), never by client authority alone.
const claimDate = z.coerce.date({ message: "eventDate must be a valid date" });

const createClaimBody = z.object({
  parcelId,
  eventType,
  eventDate: claimDate,
  geometry: polygonGeometry,
  idempotencyKey,
});

const claimParams = z.object({ claimId });

// Evidence identifiers use the same server-generated `img_<uuid>` format as /upload.
const claimEvidenceParams = z.object({ evidenceId: uploadId });

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
  parcelId,
  createParcelBody,
  patchParcelBody,
  parcelParams,
  claimId,
  eventType,
  idempotencyKey,
  claimDate,
  createClaimBody,
  claimParams,
  claimEvidenceParams,
};
