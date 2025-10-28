import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { connectDB } from "./config/db.js";
import serverless from "serverless-http";
import authRoutes from "./routes/auth.js";
import testRoutes from "./routes/test.js";
import chatRoutes from "./routes/chat.js";
import chatSessionsRoutes from "./routes/chatSessions.js"; // add import for chatSessions routes

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
app.use("/chat", chatRoutes);
app.use("/chatsessions", chatSessionsRoutes); // add chatSessions routes

// Local server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Lambda server
//export const handler = serverless(app);