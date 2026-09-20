import mongoose from "mongoose";

// Farm profile — first-class identity context (E2-S4, F-21, D-10 Option 1).
// E1-S5 (D-35): owned/scoped by the caller's cognitoSub (from the verified token); userEmail is a
// retained display/legacy dual-key.
// Minimal onboarding set per D-10/APP-10: district, crops, acres. Soil type and phone are
// deliberately NOT collected (soil is district-derived per D-19; phone is PII deferred to
// WhatsApp, E6). Used by the Context Engine slice (E2-S3) for zero-question continuity (D-14).
//
// F-49 (Phase 1 — Farm Parcel Foundation, ADR-019 P1/P4/P10): a profile now carries MULTIPLE
// agricultural parcels. Parcels are additive and backward compatible — existing profiles with
// no geometry keep `parcels: []` and are never auto-fabricated geometry. `calculatedAreaAcres`
// is always computed server-side from the parcel geometry (`services/parcelGeometry.service.js`);
// client-supplied area values are never authoritative.
const parcelSchema = new mongoose.Schema(
  {
    // Server-generated opaque identifier `par_<uuid>` (crypto.randomUUID). Never a Mongo
    // ObjectId and never client-chosen. Future claim records reference this value.
    parcelId: { type: String, required: true, immutable: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    crop: { type: String, required: true, trim: true, maxlength: 100 },
    // GeoJSON Polygon, WGS84 (EPSG:4326), coordinate order [longitude, latitude]. Exterior ring
    // only (no holes in MVP). No 2dsphere index in Phase 1 — no spatial queries exist yet.
    geometry: {
      type: {
        type: String,
        enum: ["Polygon"],
        required: true,
        default: "Polygon",
      },
      coordinates: {
        type: [[[Number]]],
        required: true,
      },
    },
    calculatedAreaAcres: {
      type: Number,
      required: true,
      min: [0, "Area must be positive"],
    },
  },
  { timestamps: true, _id: false, minimize: false }
);

const farmProfileSchema = new mongoose.Schema(
  {
    // E1-S5 (D-35): the profile is owned/scoped by the authenticated user's stable cognitoSub
    // (unique, sparse for legacy). userEmail retained as a display/legacy dual-key so legacy
    // email-keyed rows can be backfilled to cognitoSub without losing the email.
    cognitoSub: { type: String, unique: true, sparse: true, index: true, trim: true },
    userEmail: { type: String, trim: true, lowercase: true },
    district: { type: String, required: true, trim: true },
    crops: { type: [String], required: true, validate: [(c) => Array.isArray(c) && c.length > 0, "At least one crop is required"] },
    acres: { type: Number, required: true, min: [0.01, "Acres must be greater than 0"] },
    language: { type: String, enum: ["en", "ta"], default: undefined },
    parcels: { type: [parcelSchema], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model("FarmProfile", farmProfileSchema);
