import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import * as farmProfileService from "../services/farmProfile.service.js";

// Upsert (create or update) the caller's farm profile (E2-S4, D-10 Option 1).
const saveProfile = asyncHandler(async (req, res) => {
  const { userEmail, district, crops, acres, language } = req.body;
  const profile = await farmProfileService.upsert({ userEmail, district, crops, acres, language });
  return ApiResponse.success(res, "Farm profile saved", { profile });
});

// Fetch the profile for a user (used by the context engine + onboarding UI).
const getProfile = asyncHandler(async (req, res) => {
  const { email } = req.params;
  const profile = await farmProfileService.getByUser(email);
  if (!profile) throw ApiError.notFound("Farm profile not found");
  return ApiResponse.success(res, "Farm profile fetched", { profile });
});

// Delete a user's profile.
const deleteProfile = asyncHandler(async (req, res) => {
  const { email } = req.params;
  const profile = await farmProfileService.remove(email);
  if (!profile) throw ApiError.notFound("Farm profile not found");
  return ApiResponse.success(res, "Farm profile deleted");
});

export { saveProfile, getProfile, deleteProfile };
