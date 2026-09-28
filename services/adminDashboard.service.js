// Phase 10 (E9-S10) — Operations dashboard metrics (pure, unit-testable in isolation).
//
// Deterministic aggregation over claim/assessment rows. NO third-party analytics are used — every
// number here is computed server-side from the normal claim/assessment/appeal collections
// (08_API_Documentation §10.12). Row shape matches what admin.service.js passes in (claim with
// decidedAt/submittedAt/state, optional assessment with aiAggregate/status, optional appeal).
//
// Metrics (15_Security / E9-S10 dashboard contract):
//   total           — claims in the reviewed period with a decision (decidedAt present)
//   verified        — state === "verified"
//   partial         — state === "partially_verified"
//   rejected        — state === "rejected"
//   outOfLimit      — state === "out_of_limit"
//   duplicate       — state === "duplicate_area"
//   moreEvidence    — state === "more_evidence_required"
//   averageVerificationTimeMs — mean (decidedAt - submittedAt) over decided claims with both
//   aiUncertaintyRate — fraction of AI-assessed claims whose aiAggregate.uncertain is true
//   aiFailedCount  — assessments stuck in "failed" (or verification.status "failed")
//   appealCount     — active + resolved appeals observed in the period
//   pendingHumanReview — queue-sized backlog (decision states needing review + AI failures)

export const DASHBOARD_METRIC_KEYS = [
  "total",
  "verified",
  "partial",
  "rejected",
  "outOfLimit",
  "duplicate",
  "moreEvidence",
  "pendingHumanReview",
  "averageVerificationTimeMs",
  "aiUncertaintyRate",
  "aiFailedCount",
  "appealCount",
];

const round2 = (value) => Math.round(value * 100) / 100;

export const computeDashboardMetrics = ({ claims = [], appeals = [] } = {}) => {
  const decided = claims.filter((claim) => Boolean(claim?.decidedAt));
  const statusCount = (state) =>
    decided.reduce((acc, claim) => (claim.state === state ? acc + 1 : acc), 0);

  const verified = statusCount("verified");
  const partial = statusCount("partially_verified");
  const rejected = statusCount("rejected");
  const outOfLimit = statusCount("out_of_limit");
  const duplicate = statusCount("duplicate_area");
  const moreEvidence = statusCount("more_evidence_required");

  // Mean verification latency over claims that carry both timestamps.
  let averageVerificationTimeMs = null;
  const latencies = decided
    .filter((claim) => claim?.submittedAt && claim?.decidedAt)
    .map((claim) => new Date(claim.decidedAt).getTime() - new Date(claim.submittedAt).getTime());
  if (latencies.length > 0) {
    averageVerificationTimeMs =
      Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 100) / 100;
  }

  // AI uncertainty rate over claims that have an AI aggregate observation.
  const withAi = claims.filter((claim) => Boolean(claim?.assessment?.aiAggregate));
  const aiUncertainCount = withAi.filter((claim) => Boolean(claim.assessment.aiAggregate.uncertain)).length;
  const aiUncertaintyRate = withAi.length > 0 ? round2(aiUncertainCount / withAi.length) : null;

  const aiFailedCount = claims.filter(
    (claim) =>
      claim?.assessment &&
      (claim.assessment.status === "failed" || claim.assessment.verification?.status === "failed")
  ).length;

  // Claims still needing a human look: engine-review decision states + AI failures.
  const pendingHumanReview = claims.filter((claim) => {
    const hasAppeal = Boolean(claim?.appeal);
    const aiFailed =
      Boolean(claim?.assessment) &&
      (claim.assessment.status === "failed" || claim.assessment.verification?.status === "failed");
    return aiFailed || hasAppeal || ["rejected", "out_of_limit", "duplicate_area", "more_evidence_required"].includes(claim.state);
  }).length;

  const appealCount = Array.isArray(appeals) ? appeals.length : 0;

  return {
    total: decided.length,
    verified,
    partial,
    rejected,
    outOfLimit,
    duplicate,
    moreEvidence,
    pendingHumanReview,
    averageVerificationTimeMs,
    aiUncertaintyRate,
    aiFailedCount,
    appealCount,
  };
};

export const isEmptyDashboard = (metrics) =>
  metrics.total === 0 &&
  metrics.pendingHumanReview === 0 &&
  metrics.appealCount === 0 &&
  metrics.aiFailedCount === 0;

export default {
  DASHBOARD_METRIC_KEYS,
  computeDashboardMetrics,
  isEmptyDashboard,
};