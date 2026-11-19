// Re-runs the existing 192-scenario claim evaluation (scripts/eval/fusion.eval.js) and counts the
// report's four categories directly from each decision. Uses the repo's own scenario builder, decision
// function and design-rule label; changes nothing and writes only inside evaluation/.
// Run from the repository root:
//   VIVASAYI_SKIP_DOTENV=1 node evaluation/claim_eval.mjs [--policy=v2-components] [--out=evaluation/claim_results.json]
import { writeFileSync } from "node:fs";
import { buildScenarios, decide, PHOTOS, RIGHTS } from "../scripts/eval/fusion.eval.js";
import { resolvePolicy } from "../config/verificationPolicy.js";

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${fallback}`).split("=")[1];
const policyId = arg("policy", "v2-components");
const out = arg("out", "evaluation/claim_results.json");

// Same label as fusion.eval.js shouldApprove (the design rule).
const shouldApprove = (s) => s.inside && !s.duplicate && !s.cross && PHOTOS[s.photos].supports && RIGHTS[s.rights].acceptable;

const policy = resolvePolicy(policyId);
const rows = buildScenarios().map((s) => ({ ...s, truthApprove: shouldApprove(s), ...decide({ policy, ...s }) }));
const valid = rows.filter((r) => r.truthApprove);
const inflated = rows.filter((r) => !r.truthApprove);
const counts = {
  scenarios: rows.length,
  validClaims: valid.length,
  invalidOrInflatedClaims: inflated.length,
  validApproved: valid.filter((r) => r.approved).length,
  validNotApproved: valid.filter((r) => !r.approved).length,
  inflatedStopped: inflated.filter((r) => !r.approved && r.disposition !== "hold").length,
  heldForOfficerReview: rows.filter((r) => r.disposition === "hold").length,
  heldThatWereInflated: inflated.filter((r) => r.disposition === "hold").length,
  inflatedWronglyApproved: inflated.filter((r) => r.approved).length,
};
counts.correctAutomaticDecisions = counts.validApproved + counts.inflatedStopped;
counts.accuracyAsInReport = `${counts.correctAutomaticDecisions}/${counts.scenarios} = ${((100 * counts.correctAutomaticDecisions) / counts.scenarios).toFixed(1)}%`;
const outcomes = rows.reduce((acc, r) => ({ ...acc, [`${r.outcome}/${r.disposition}`]: (acc[`${r.outcome}/${r.disposition}`] || 0) + 1 }), {});

const result = { policy: policyId, groundTruth: "design rule from scripts/eval/fusion.eval.js (author-defined), NOT real claims", counts, outcomeDispositionCounts: outcomes, createdAt: new Date().toISOString() };
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
