import express from "express";
import helmet from "helmet";
import authRoutes from "./routes/auth.js";
import chatRoutes from "./routes/chat.js";
import chatSessionsRoutes from "./routes/chatSessions.js"; // add import for chatSessions routes
import weatherRoutes from "./routes/weather.js";
import farmProfileRoutes from "./routes/farmProfile.js";
import uploadRoutes from "./routes/upload.js";
import { notFoundHandler, errorHandler } from "./middlewares/error.js";
import requireAuth from "./middlewares/auth.js";
import corsMiddleware from "./middlewares/cors.js";
import { authLimiter, chatLimiter, chatDailyLimiter } from "./middlewares/rateLimit.js";
import requestLogger from "./middlewares/requestLogger.js";
import ApiResponse from "./utils/ApiResponse.js";

// Thin, side-effect-free Express app so the same app is used by production (wrapped in
// serverless-http inside index.js) and by the integration tests (imported directly, no DB/Env
// dependency). Env validation + DB connection + serverless wrap live in index.js only.

const app = express();

// Security headers
app.use(helmet());

// Strict CORS (allow-list; supports credentials for httpOnly cookie auth)
app.use(corsMiddleware);

// Request logging + correlation (runs before body-parse so parse errors get a requestId)
app.use(requestLogger);

app.use(express.json({ limit: "1mb" }));

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

// E1-S4/E1-S5: protect all application routes (except auth/health — and root `/` stays a public
// liveness probe). requireAuth validates the session Bearer token (HS256) and populates req.user
// from the token; ownership is scoped by req.user.id (cognitoSub) per E1-S5 (D-35).
app.use(requireAuth);
app.use("/chat", chatLimiter, chatDailyLimiter, chatRoutes);
app.use("/chatsessions", chatSessionsRoutes); // add chatSessions routes
app.use("/weather", weatherRoutes);
app.use("/profile", farmProfileRoutes);
app.use("/upload", uploadRoutes); // E3-S1: multipart image upload transport (behind requireAuth)

app.use(notFoundHandler);
app.use(errorHandler);

export default app;