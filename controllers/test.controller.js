import User from "../models/User.js";
import Query from "../models/Query.js";
import Context from "../models/Context.js";
import ApiResponse from "../utils/ApiResponse.js";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";

// User Controllers
const createUser = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  
  if (!name || !email) {
    throw ApiError.badRequest("Name and email are required");
  }
  
  const user = await User.create({ name, email });
  return ApiResponse.success(res, "User created successfully", user);
});

const getAllUsers = asyncHandler(async (req, res) => {
  const users = await User.find();
  return ApiResponse.success(res, "Users retrieved successfully", users);
});

// Query Controllers
const createQuery = asyncHandler(async (req, res) => {
  const { userId, queryText, location } = req.body;
  
  if (!userId || !queryText) {
    throw ApiError.badRequest("UserId and queryText are required");
  }
  
  const query = await Query.create({ userId, queryText, location });
  return ApiResponse.success(res, "Query created successfully", query);
});

const getAllQueries = asyncHandler(async (req, res) => {
  const queries = await Query.find();
  return ApiResponse.success(res, "Queries retrieved successfully", queries);
});

// Context Controllers
const createContext = asyncHandler(async (req, res) => {
  const { districtName, soilType, crops, fertilizerRecommendations } = req.body;
  
  if (!districtName || !soilType) {
    throw ApiError.badRequest("District name and soil type are required");
  }
  
  const context = await Context.create({ 
    districtName, 
    soilType, 
    crops, 
    fertilizerRecommendations 
  });
  return ApiResponse.success(res, "Context created successfully", context);
});

const getAllContexts = asyncHandler(async (req, res) => {
  const contexts = await Context.find();
  return ApiResponse.success(res, "Contexts retrieved successfully", contexts);
});

export {
  createUser,
  getAllUsers,
  createQuery,
  getAllQueries,
  createContext,
  getAllContexts
};