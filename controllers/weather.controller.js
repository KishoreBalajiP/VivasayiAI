import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import { getWeather } from "../services/weather.service.js";

// Thin controller: validate → service → envelope. No business logic (12 §4 Controllers).
const getWeatherByDistrict = asyncHandler(async (req, res) => {
  const { district } = req.query;
  const result = await getWeather(district);
  return ApiResponse.success(res, "Weather retrieved successfully", result);
});

export { getWeatherByDistrict };
