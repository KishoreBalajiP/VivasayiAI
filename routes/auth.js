import express from "express";
import { googleLogin } from "../controllers/auth.controller.js";
import validate from "../middlewares/validate.js";
import { googleLoginBody } from "../utils/validation.schemas.js";

const router = express.Router();

// Google OAuth login route
router.post("/google", validate(googleLoginBody), googleLogin);

export default router;
