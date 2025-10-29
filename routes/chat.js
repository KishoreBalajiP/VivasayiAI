import express from "express";
import chat from "../controllers/chat.controller.js";

const router = express.Router();

// Chat with RAG-enhanced AI
router.post("/", chat);

export default router;