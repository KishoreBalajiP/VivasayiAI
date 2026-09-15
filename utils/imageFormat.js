// Image format allow-list + magic-byte sniffing (E3-S1, D-22 Option 1: content-type sniff).
//
// Transport accepts only these approved image MIME types (phone photos + screenshots/web):
// JPEG, PNG, WEBP. GIF/HEIC are intentionally NOT accepted yet — see 17_Backlog E3-S1 note.
// We never trust the client-declared Content-Type alone; every accepted upload's bytes must
// match its declared type (magic bytes), so arbitrary files renamed with an image extension
// are rejected (no raw multipart Content-Type passthrough).

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const SNIFFERS = {
  "image/jpeg": (b) =>
    b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b.length >= PNG_SIG.length &&
    PNG_SIG.every((byte, i) => b[i] === byte),
  "image/webp": (b) =>
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP",
};

export const ALLOWED_IMAGE_MIME_TYPES = new Set(Object.keys(SNIFFERS));

export const EXTENSION_BY_MIME = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});

// Returns the canonical MIME type the buffer's bytes actually hold, or null if the content
// is not one of the approved image formats (or is too short / malformed).
export const detectImageMime = (buffer) => {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 3) return null;
  for (const [mime, sniff] of Object.entries(SNIFFERS)) {
    if (sniff(buffer)) return mime;
  }
  return null;
};