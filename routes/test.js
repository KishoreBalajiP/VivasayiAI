import express from "express";
import {
  createUser,
  getAllUsers,
  createQuery,
  getAllQueries,
  createContext,
  getAllContexts
} from "../controllers/test.controller.js";

const router = express.Router();

// User routes
router.post("/user", createUser);
router.get("/users", getAllUsers);

// Query routes
router.post("/query", createQuery);
router.get("/queries", getAllQueries);

// Context routes
router.post("/context", createContext);
router.get("/contexts", getAllContexts);

export default router;
