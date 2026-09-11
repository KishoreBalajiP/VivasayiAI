import express from "express";
import chat from "../controllers/chat.controller.js";
import validate from "../middlewares/validate.js";
import { chatBody } from "../utils/validation.schemas.js";

const router = express.Router();

// Chat with RAG-enhanced AI with context awareness
router.post("/", validate(chatBody), chat);

export default router;
