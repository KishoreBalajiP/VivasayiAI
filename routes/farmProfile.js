import express from "express";
import validate from "../middlewares/validate.js";
import { sessionMutationLimiter } from "../middlewares/rateLimit.js";
import {
  farmProfileBody,
  createParcelBody,
  patchParcelBody,
  parcelParams,
} from "../utils/validation.schemas.js";
import { saveProfile, getProfile, deleteProfile } from "../controllers/farmProfile.controller.js";
import {
  listParcels,
  createParcel,
  getParcel,
  updateParcel,
  deleteParcel,
  recalculateParcelArea,
} from "../controllers/parcel.controller.js";

const router = express.Router();

// Upsert (create or update) the caller's farm profile (E2-S4).
router.post("/", validate(farmProfileBody), saveProfile);

// Get the caller's farm profile.
router.get("/", getProfile);

// Delete the caller's farm profile.
router.delete("/", deleteProfile);

// ----------------------------------------------------------------------------
// F-49 (Phase 1 — Farm Parcel Foundation, ADR-019 P1/P4/P10).
// Parcel CRUD; ownership always derives from req.user.id (verified token). Mutations reuse the
// existing authenticated per-user mutation limiter (same protection as chat session mutations);
// reads are unthrottled (consistent with existing session read routes).
// ----------------------------------------------------------------------------

// List the caller's parcels.
router.get("/parcels", listParcels);

// Create a parcel on the caller's farm profile (requires an existing profile).
router.post("/parcels", sessionMutationLimiter, validate(createParcelBody), createParcel);

// Fetch a single owned parcel.
router.get("/parcels/:parcelId", validate(parcelParams, "params"), getParcel);

// Update allowed fields (name, crop, geometry) on an owned parcel.
router.patch(
  "/parcels/:parcelId",
  sessionMutationLimiter,
  validate(parcelParams, "params"),
  validate(patchParcelBody),
  updateParcel
);

// Delete an owned parcel (never the profile).
router.delete(
  "/parcels/:parcelId",
  sessionMutationLimiter,
  validate(parcelParams, "params"),
  deleteParcel
);

// Recompute authoritative area from stored geometry.
router.post(
  "/parcels/:parcelId/area",
  sessionMutationLimiter,
  validate(parcelParams, "params"),
  recalculateParcelArea
);

export default router;