import express from "express";
import axios from "axios";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const router = express.Router();

router.post("/google", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Missing authorization code" });

    const clientId = process.env.COGNITO_CLIENT_ID;
    const clientSecret = process.env.COGNITO_CLIENT_SECRET || "";
    const redirectUri = process.env.COGNITO_REDIRECT_URI;
    const domain = process.env.COGNITO_DOMAIN;

    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("client_id", clientId);
    if (clientSecret) params.append("client_secret", clientSecret);
    params.append("redirect_uri", redirectUri);
    params.append("code", code);

    const tokenRes = await axios.post(
      `https://${domain}/oauth2/token`,
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { id_token } = tokenRes.data;
    const decoded = jwt.decode(id_token);

    if (!decoded) return res.status(401).json({ error: "Invalid ID token" });

    const { email, name } = decoded;

    let user = await User.findOne({ email });
    if (!user) user = await User.create({ name, email, language: "ta" });

    res.json({ message: "Login successful", user, id_token });
  } catch (err) {
    console.error("Auth error:", err.response?.data || err.message);
    res.status(500).json({ error: "Authentication failed" });
  }
});

export default router;
