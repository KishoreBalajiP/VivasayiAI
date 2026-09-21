import mongoose from "mongoose";

// F-49 (ADR-019) — Agricultural Loss / Affected-Area Claim (07_Database_Design §6).
//
// Ownership is scoped by the authenticated user's cognitoSub (E1-S5, D-35): every service
// lookup is `{ _id, cognitoSub }` and any foreign claim resolves to 404. `claimedAreaAcres`
// is ALWAYS server-calculated from `claimedGeometry` (services/parcelGeometry.service.js,
// P4) — the client can never supply an area. `parcelSnapshot` is denormalized from the
// server-owned FarmProfile parcel at creation time (it carries the FarmProfile `name`,
// which the Phase 2 claim model captures alongside the DB-doc fields).

export const CLAIM_EVENT_TYPES = [
  "flood",
  "storm",
  "drought",
  "pest",
  "disease",
  "fire",
  "other",
];

export const CLAIM_STATES = [
  "draft",
  "submitted",
  "processing",
  "verified",
  "partially_verified",
  "more_evidence_required",
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "withdrawn",
];

const parcelSnapshotSchema = new mongoose.Schema(
  {
    parcelId: { type: String, required: true },
    name: { type: String, default: null },
    crop: { type: String, default: null },
    parcelAreaAcres: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const lossClaimSchema = new mongoose.Schema(
  {
    // E1-S5 (D-35): ownership scoped by the authenticated user's stable cognitoSub.
    cognitoSub: { type: String, required: true, index: true },
    profileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FarmProfile",
      required: true,
    },
    parcelId: { type: String, required: true },
    parcelSnapshot: { type: parcelSnapshotSchema, required: true },
    eventType: { type: String, enum: CLAIM_EVENT_TYPES, required: true },
    // When damage occurred (server-validated P2: not future, within CLAIM_WINDOW_DAYS).
    eventDate: { type: Date, required: true },
    // Farmer-drawn GeoJSON Polygon, WGS84 [lon, lat]; validated + area-computed server-side.
    claimedGeometry: {
      type: { type: String, enum: ["Polygon"], default: "Polygon", required: true },
      coordinates: { type: [[[Number]]], required: true },
    },
    claimedAreaAcres: { type: Number, required: true, min: 0 },
    evidence: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "ClaimEvidence",
      default: [],
    },
    state: { type: String, enum: CLAIM_STATES, default: "draft", index: true },
    // Client UUID for idempotent creation. Uniqueness is OWNER-scoped (compound sparse unique
    // index below) so one user's key can never collide with — or leak — another user's claim.
    idempotencyKey: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// 07 §6 indexes.
lossClaimSchema.index({ cognitoSub: 1, createdAt: -1 }); // my claims
lossClaimSchema.index({ parcelId: 1, state: 1 }); // active claims per parcel
// Idempotency: the same owner + same key may only ever map to ONE claim. Owner-scoped (never a
// global unique), sparse so claims without a key never collide.
lossClaimSchema.index(
  { cognitoSub: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);
// Prevents duplicate VERIFIED claims for the same parcel + event date + event type once a
// decision exists (the batch guard a later duplicate draw could create).
lossClaimSchema.index(
  { parcelId: 1, eventDate: 1, eventType: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ["verified", "partially_verified"] } },
  }
);

export default mongoose.model("LossClaim", lossClaimSchema);