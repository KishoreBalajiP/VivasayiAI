import { randomUUID } from "node:crypto";
import { EXTENSION_BY_MIME } from "../utils/imageFormat.js";

// E3-S1: upload transport only. The validated bytes live in memory for the duration of
// the request and are then released — nothing is written to disk or MongoDB (15_Security
// §5 / 07_Database_Design: no binary-in-Mongo; S3 handling is E3-S2, D-23 pending). This
// service returns the small, stable metadata descriptor the later vision pipeline (E3-S2+)
// and the client need. The upload id is server-generated and never derived from, or derived
// to, any client-supplied filename.
export const receiveUpload = ({ size, mimetype }) => ({
  uploadId: `img_${randomUUID()}`,
  mediaType: mimetype,
  extension: EXTENSION_BY_MIME[mimetype],
  size,
  status: "uploaded",
});