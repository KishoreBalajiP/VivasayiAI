import express from "express";
import validate from "../middlewares/validate.js";
import { farmProfileBody } from "../utils/validation.schemas.js";
import { saveProfile, getProfile, deleteProfile } from "../controllers/farmProfile.controller.js";

const router = express.Router();

// Upsert (create or update) the caller's farm profile (E2-S4).
router.post("/", validate(farmProfileBody), saveProfile);

// Get the caller's farm profile.
router.get("/", getProfile);

// Delete the caller's farm profile.
router.delete("/", deleteProfile);

export default router;
