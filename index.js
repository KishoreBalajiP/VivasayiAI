import app from "./app.js";
import { connectDB } from "./config/db.js";
import { env, validateEnv, assertProductionSafety, SERVER_REQUIRED } from "./config/env.js";
import logger from "./utils/logger.js";
import serverless from "serverless-http";
import { handleScheduledWorker } from "./services/verificationWorker.service.js";
import { assertPolicyConfigured } from "./config/verificationPolicy.js";

validateEnv(SERVER_REQUIRED);
// ADR-024: a production process (NODE_ENV=production or Lambda) refuses to boot with any mock mode or
// the dev upload receiver configured.
assertProductionSafety();
// Fail at boot, not at the first claim, when CLAIM_VERIFICATION_POLICY names an unknown policy.
assertPolicyConfigured();

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

// ADR-021/ADR-022: scheduled worker. An EventBridge rule (infra/verification-worker.yaml, DISABLED
// until the owner enables it; see docs/engineering/WORKER_RUNBOOK.md) invokes this handler to run
// queued verification steps and the recovery sweeps without waiting for a request. Each run stops
// 10 s before its timeout and tags its job logs with the invocation's awsRequestId.
export const worker = (event, context) => handleScheduledWorker(event, context);
