import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as parcelService from "../services/parcel.service.js";

// F-49 (Phase 1 — Farm Parcel Foundation, ADR-019 P1/P4/P10). Everything is scoped to the
// authenticated user's cognitoSub (req.user.id); the client never supplies an owner identity.
// Foreign/unowned parcels surface as 404 (no existence disclosure, ADR-018).

const mapMutationResult = (result) => {
  if (!result) throw ApiError.notFound("Farm profile not found");
  if (result.notFound) throw ApiError.notFound("Parcel not found");
  if (result.error) throw ApiError.badRequest(result.message || "Invalid parcel geometry");
  return result;
};

// List all parcels on the caller's farm profile.
const listParcels = asyncHandler(async (req, res) => {
  const parcels = await parcelService.listForUser(req.user.id);
  return ApiResponse.success(res, "Parcels fetched", { parcels });
});

// Create a parcel on the caller's farm profile. Path: POST /profile/parcels.
const createParcel = asyncHandler(async (req, res) => {
  const { name, crop, geometry } = req.body;
  const result = await parcelService.createForUser(req.user.id, { name, crop, geometry });
  const mapped = mapMutationResult(result);
  return ApiResponse.success(res, "Parcel created", { parcel: mapped.parcel });
});

// Fetch a single owned parcel. Path: GET /profile/parcels/:parcelId.
const getParcel = asyncHandler(async (req, res) => {
  const parcel = await parcelService.getForUser(req.user.id, req.params.parcelId);
  if (!parcel) throw ApiError.notFound("Parcel not found");
  return ApiResponse.success(res, "Parcel fetched", { parcel });
});

// Update allowed fields (name, crop, geometry) on an owned parcel. Area is recomputed when the
// geometry changes. Path: PATCH /profile/parcels/:parcelId.
const updateParcel = asyncHandler(async (req, res) => {
  const { name, crop, geometry } = req.body;
  const result = await parcelService.updateForUser(req.user.id, req.params.parcelId, {
    name,
    crop,
    geometry,
  });
  const mapped = mapMutationResult(result);
  return ApiResponse.success(res, "Parcel updated", { parcel: mapped.parcel });
});

// Delete an owned parcel (never the profile). Path: DELETE /profile/parcels/:parcelId.
const deleteParcel = asyncHandler(async (req, res) => {
  const result = await parcelService.removeForUser(req.user.id, req.params.parcelId);
  if (!result) throw ApiError.notFound("Farm profile not found");
  if (result.notFound) throw ApiError.notFound("Parcel not found");
  return ApiResponse.success(res, "Parcel deleted");
});

// Recompute authoritative area from stored geometry. Path: POST /profile/parcels/:parcelId/area
// (finalized 08_API_Documentation item 10).
const recalculateParcelArea = asyncHandler(async (req, res) => {
  const result = await parcelService.recalculateAreaForUser(req.user.id, req.params.parcelId);
  const mapped = mapMutationResult(result);
  return ApiResponse.success(res, "Parcel area recalculated", { parcel: mapped.parcel });
});

export { listParcels, createParcel, getParcel, updateParcel, deleteParcel, recalculateParcelArea };