import app from "./app.js";
import { connectDB } from "./config/db.js";
import { env, validateEnv, SERVER_REQUIRED } from "./config/env.js";
import logger from "./utils/logger.js";
import serverless from "serverless-http";
import { drainDueJobs } from "./services/verificationWorker.service.js";

validateEnv(SERVER_REQUIRED);

// MongoDB connection
await connectDB();

// Local development: AWS Lambda sets AWS_LAMBDA_FUNCTION_NAME, so outside Lambda `npm run dev` /
// `npm start` actually serve HTTP on PORT. Previously the listen call was commented out, so those
// scripts connected to MongoDB and then idled without accepting requests.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const port = env.port || 8000;
  app.listen(port, () => logger.info({ port }, "Server listening"));
}

// Lambda server
export const handler = serverless(app);

// ADR-021: scheduled worker. Point an EventBridge rule (for example every minute) at this handler
// to run queued verification steps and escalate stale holds without waiting for a request. It is
// optional: the verify and status endpoints also advance the queue.
export const worker = async (_event, context) => {
  const remaining = context && typeof context.getRemainingTimeInMillis === "function" ? context.getRemainingTimeInMillis() : 25000;
  return drainDueJobs({ deadline: Date.now() + Math.max(0, remaining - 5000) });
};
