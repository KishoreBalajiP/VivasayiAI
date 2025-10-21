import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { connectDB } from "./config/db.js";
import serverless from "serverless-http"; // Uncomment when deploying to AWS Lambda

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB connection
await connectDB();

// Routes
app.get("/", (req, res) => {
  res.json({ message: "Tamil Nadu Farming Assistant Backend is Live!" });
});

// ----- LOCAL SERVER MODE -----
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Local server running on port ${PORT}`));

// ----- LAMBDA MODE -----
export const handler = serverless(app); // Uncomment these two lines for AWS Lambda
