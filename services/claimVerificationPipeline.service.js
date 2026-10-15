import logger from "../utils/logger.js";
import { enqueuePlan, drain } from "./verificationJobs.service.js";

// Automated claim-verification orchestration (Phase 15), reworked under ADR-021.
//
// The previous version ran every step inside a fire-and-forget promise after the HTTP response. On
// AWS Lambda the container is frozen once the response is sent, so that work could simply never
// finish, and its "already running" guard was per-process memory. Submit now only ENQUEUES the work
// as durable job rows (services/verificationJobs.service.js); the steps run when someone drains the
// queue: the verify call, a status read, or the scheduled worker.

export const triggerAutomatedVerification = (claimId, cognitoSub) => {
  enqueuePlan({ claimId, cognitoSub }).catch((error) => {
    logger.error({ err: error?.message, claimId: String(claimId) }, "Could not enqueue automated verification");
  });
};

// Run the claim's due jobs now (bounded by `deadline`, an epoch-ms time).
export const runAutomatedVerification = async ({ claimId, deadline = null } = {}) => {
  const results = await drain({ claimId, deadline });
  return { claimId: String(claimId), results };
};

export default { triggerAutomatedVerification, runAutomatedVerification };
