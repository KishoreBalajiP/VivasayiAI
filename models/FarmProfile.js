import mongoose from "mongoose";

// Farm profile — first-class identity context (E2-S4, F-21, D-10 Option 1).
// Keyed by userEmail (the only identity available today; cognitoSub is planned in E1-S3).
// Minimal onboarding set per D-10/APP-10: district, crops, acres. Soil type and phone are
// deliberately NOT collected (soil is district-derived per D-19; phone is PII deferred to
// WhatsApp, E6). Used by the Context Engine slice (E2-S3) for zero-question continuity (D-14).
const farmProfileSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    district: { type: String, required: true, trim: true },
    crops: { type: [String], required: true, validate: [(c) => Array.isArray(c) && c.length > 0, "At least one crop is required"] },
    acres: { type: Number, required: true, min: [0.01, "Acres must be greater than 0"] },
    language: { type: String, enum: ["en", "ta"], default: undefined },
  },
  { timestamps: true }
);

export default mongoose.model("FarmProfile", farmProfileSchema);
