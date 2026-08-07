import express from "express";
import helmet from "helmet";
import { connectDB } from "./config/db.js";
import { validateEnv, SERVER_REQUIRED } from "./config/env.js";
import serverless from "serverless-http";
import authRoutes from "./routes/auth.js";
import testRoutes from "./routes/test.js";
import chatRoutes from "./routes/chat.js";
import chatSessionsRoutes from "./routes/chatSessions.js"; // add import for chatSessions routes
import { notFoundHandler, errorHandler } from "./middlewares/error.js";
import corsMiddleware from "./middlewares/cors.js";
import { authLimiter, chatLimiter, chatDailyLimiter } from "./middlewares/rateLimit.js";

validateEnv(SERVER_REQUIRED);

const app = express();

// Security headers
app.use(helmet());

// Strict CORS (allow-list; supports credentials for httpOnly cookie auth)
app.use(corsMiddleware);

app.use(express.json());

// MongoDB connection
await connectDB();

// Routes
app.get("/", (req, res) => {
  res.json({ message: "Backend is Live!" });
});

app.use("/auth", authLimiter, authRoutes);
app.use("/test", testRoutes);
app.use("/chat", chatLimiter, chatDailyLimiter, chatRoutes);
app.use("/chatsessions", chatSessionsRoutes); // add chatSessions routes

app.use(notFoundHandler);
app.use(errorHandler);

// Local server
// const PORT = process.env.PORT || 8000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Lambda server
export const handler = serverless(app);