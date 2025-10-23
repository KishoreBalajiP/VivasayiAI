import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { connectDB } from "./config/db.js";
import serverless from "serverless-http";
import authRoutes from "./routes/auth.js";
import testRoutes from "./routes/test.js";

dotenv.config();

const app = express();

// Explicit CORS settings for frontend
app.use(cors({
  origin: "*",              // Allow all origins
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use(express.json());

// MongoDB connection
await connectDB();

// Routes
app.get("/", (req, res) => {
  res.json({ message: "Backend is Live!" });
});

app.use("/auth", authRoutes);
app.use("/test", testRoutes);

// Local server
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Lambda server
export const handler = serverless(app);
