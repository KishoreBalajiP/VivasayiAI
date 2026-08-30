import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as farmProfileService from "../services/farmProfile.service.js";

// E1-S5 (D-35): a profile is owned by the authenticated user (req.user.id = cognitoSub). The
// client never supplies an ownership email; identity comes from the verified token only.

// Upsert (create or update) the caller's farm profile (E2-S4, D-10 Option 1).
const saveProfile = asyncHandler(async (req, res) => {
  const { district, crops, acres, language } = req.body;
  const profile = await farmProfileService.upsert({
    cognitoSub: req.user.id,
    email: req.user.email,
    district,
    crops,
    acres,
    language,
  });
  return ApiResponse.success(res, "Farm profile saved", { profile });
});

// Fetch the caller's farm profile.
const getProfile = asyncHandler(async (req, res) => {
  const profile = await farmProfileService.getByUser(req.user.id);
  if (!profile) throw ApiError.notFound("Farm profile not found");
  return ApiResponse.success(res, "Farm profile fetched", { profile });
});

// Delete the caller's farm profile.
const deleteProfile = asyncHandler(async (req, res) => {
  const profile = await farmProfileService.remove(req.user.id);
  if (!profile) throw ApiError.notFound("Farm profile not found");
  return ApiResponse.success(res, "Farm profile deleted");
});

export { saveProfile, getProfile, deleteProfile };
