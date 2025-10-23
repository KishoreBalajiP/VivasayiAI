import express from "express";
import User from "../models/User.js";
import Query from "../models/Query.js";
import Context from "../models/Context.js";

const router = express.Router();

// --- User test ---
router.post("/user", async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await User.create({ name, email });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/users", async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Query test ---
router.post("/query", async (req, res) => {
  try {
    const { userId, queryText, location } = req.body;
    const query = await Query.create({ userId, queryText, location });
    res.json(query);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/queries", async (req, res) => {
  try {
    const queries = await Query.find();
    res.json(queries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Context test ---
router.post("/context", async (req, res) => {
  try {
    const { districtName, soilType, crops, fertilizerRecommendations } = req.body;
    const context = await Context.create({ districtName, soilType, crops, fertilizerRecommendations });
    res.json(context);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/contexts", async (req, res) => {
  try {
    const contexts = await Context.find();
    res.json(contexts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
