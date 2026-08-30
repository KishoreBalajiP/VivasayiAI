import express from "express";
import validate from "../middlewares/validate.js";
import { farmProfileBody, listParams } from "../utils/validation.schemas.js";
import { saveProfile, getProfile, deleteProfile } from "../controllers/farmProfile.controller.js";

const router = express.Router();

// Upsert (create or update) the caller's farm profile (E2-S4).
router.post("/", validate(farmProfileBody), saveProfile);

// Get a user's farm profile.
router.get("/:email", validate(listParams, "params"), getProfile);

// Delete a user's farm profile.
router.delete("/:email", validate(listParams, "params"), deleteProfile);

export default router;
