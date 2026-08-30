import express from "express";
import helmet from "helmet";
import { connectDB } from "./config/db.js";
import { validateEnv, SERVER_REQUIRED } from "./config/env.js";
import serverless from "serverless-http";
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chat.js";
import chatSessionsRoutes from "./routes/chatSessions.js"; // add import for chatSessions routes
import weatherRoutes from "./routes/weather.js";
import farmProfileRoutes from "./routes/farmProfile.js";
import { notFoundHandler, errorHandler } from "./middlewares/error.js";
import corsMiddleware from "./middlewares/cors.js";
import { authLimiter, chatLimiter, chatDailyLimiter } from "./middlewares/rateLimit.js";
import requestLogger from "./middlewares/requestLogger.js";
import ApiResponse from "./utils/ApiResponse.js";

validateEnv(SERVER_REQUIRED);

const app = express();

// Security headers
app.use(helmet());

// Strict CORS (allow-list; supports credentials for httpOnly cookie auth)
app.use(corsMiddleware);

// Request logging + correlation (runs before body-parse so parse errors get a requestId)
app.use(requestLogger);

app.use(express.json({ limit: "1mb" }));

// MongoDB connection
await connectDB();

// Routes
app.get("/", (req, res) => {
  res.json({ message: "Backend is Live!" });
});

// Health check for deployment, uptime monitoring and health checks
app.get("/health", (req, res) => {
  ApiResponse.success(res, "OK", {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use("/auth", authLimiter, authRoutes);
app.use("/chat", chatLimiter, chatDailyLimiter, chatRoutes);
app.use("/chatsessions", chatSessionsRoutes); // add chatSessions routes
app.use("/weather", weatherRoutes);
app.use("/profile", farmProfileRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

// Local server
// const PORT = process.env.PORT || 8000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Lambda server
export const handler = serverless(app);