import ClaimAssessment from "../models/ClaimAssessment.js";
import LossClaim from "../models/LossClaim.js";
import logger from "../utils/logger.js";
import { drain, enqueue } from "./verificationJobs.service.js";
import { resolvePolicy } from "../config/verificationPolicy.js";

// ADR-021 — entry point for a scheduled invocation (for example an EventBridge rule on the Lambda).
// Kept free of the top-level database connection in index.js so it can be tested directly.

// A claim held longer than the policy allows gets an explicit review case, so a person knows it is
// waiting. It is never decided or rejected automatically.
export const sweepStaleHolds = async ({ now = new Date() } = {}) => {
  const policy = resolvePolicy();
  if (!policy.maxHoldHours) return { checked: 0, escalated: 0 };

  const cutoff = new Date(now.getTime() - policy.maxHoldHours * 60 * 60 * 1000);
  const stale = await ClaimAssessment.find({ "verification.status": "held", "hold.since": { $lte: cutoff } })
    .select("claimId")
    .limit(100)
    .lean();

  const { createReviewCase } = await import("./manualReview.service.js");
  let escalated = 0;
  for (const row of stale) {
    const claim = await LossClaim.findById(row.claimId).lean();
    if (!claim || claim.state !== "submitted") continue;
    await createReviewCase({
      claimId: claim._id,
      cognitoSub: claim.cognitoSub,
      source: "OWNERSHIP",
      reasons: ["hold_exceeded_maximum_duration"],
      metadata: { component: "manual_review", maxHoldHours: policy.maxHoldHours },
    }).then(() => { escalated += 1; }).catch((error) => logger.warn({ err: error?.message }, "stale hold escalation failed"));
  }
  return { checked: stale.length, escalated };
};

export const drainDueJobs = async ({ deadline, now = () => new Date() } = {}) => {
  const results = await drain({ deadline, maxJobs: 25, now });
  const sweep = await sweepStaleHolds({ now: now() });
  return { processed: results.length, results, sweep };
};

// Ask for a fresh decision, for example after a reviewer resolved a document or a review case.
export const requestReevaluation = async ({ claimId, cognitoSub }) =>
  enqueue({ claimId, cognitoSub, step: "engine" }).catch((error) => {
    logger.warn({ err: error?.message }, "could not enqueue re-evaluation");
    return null;
  });

export default { drainDueJobs, sweepStaleHolds, requestReevaluation };
