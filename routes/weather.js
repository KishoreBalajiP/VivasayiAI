import express from "express";
import validate from "../middlewares/validate.js";
import { weatherQuery } from "../utils/validation.schemas.js";
import { getWeatherByDistrict } from "../controllers/weather.controller.js";

const router = express.Router();

// GET /api/v1/weather?district=<district-name>
// Cache-first; degrades to "unknown" on provider failure (E2-S1, D-16..D-18).
router.get("/", validate(weatherQuery, "query"), getWeatherByDistrict);

export default router;
