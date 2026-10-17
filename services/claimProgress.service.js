import mongoose from "mongoose";
import ApiError from "../utils/ApiError.js";
import ClaimAssessment from "../models/ClaimAssessment.js";
import ClaimAudit from "../models/ClaimAudit.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import VerificationJob from "../models/VerificationJob.js";
import { env } from "../config/env.js";
import { resolvePolicy } from "../config/verificationPolicy.js";
import { resolveSatelliteConfig } from "./satellite/config.js";
import { buildClaimWindows } from "./satelliteVerification.service.js";
import { computeEvidenceVersion } from "./claimAssessment.service.js";
import { findOwned } from "./claim.service.js";
import { buildFarmerProgress } from "./claimProgress.js";

// ADR-022 (plan A6) — loads what the farmer progress contract needs and hands it to the pure builder
// in services/claimProgress.js. Read-only: nothing here changes a claim, a job or an evidence row.

// Satellite runs at all? Only flags are read from its configuration, never a credential. A later
// SATELLITE_MODE=off (hermetic harness) is honoured too.
const satelliteEnabled = () => resolveSatelliteConfig().enabled && String(process.env.SATELLITE_MODE || "").toLowerCase() !== "off";

const latestTime = (docs) => {
  const values = docs
    .flatMap((doc) => [doc.createdAt, doc.updatedAt, doc.uploadedAt])
    .map((value) => (value ? new Date(value).getTime() : null))
    .filter((value) => value !== null && !Number.isNaN(value));
  return values.length ? new Date(Math.max(...values)) : null;
};

// The progress of a claim document already loaded (and already authorised by the caller).
export const buildProgressForClaim = async ({ claim, now = new Date() }) => {
  const claimId = claim._id;
  const policy = resolvePolicy();
  const [assessment, jobs, evidenceRows, photoDocs, latestAudit, resubmits] = await Promise.all([
    ClaimAssessment.findOne({ claimId }).lean(),
    VerificationJob.find({ claimId }).sort({ createdAt: 1, _id: 1 }).lean(),
    VerificationEvidence.find({ claimId }).sort({ createdAt: 1 }).lean(),
    ClaimEvidence.find({ claimId }).select("uploadId status createdAt updatedAt uploadedAt").lean(),
    ClaimAudit.findOne({ claimId }).sort({ createdAt: -1, _id: -1 }).select("createdAt").lean(),
    claim.state === "more_evidence_required" ? ClaimAudit.countDocuments({ claimId, action: "resubmitted" }) : Promise.resolve(0),
  ]);
  const stored = photoDocs.filter((doc) => doc.status === "stored");
  let windows = null;
  try {
    windows = claim.eventDate ? buildClaimWindows({ eventDate: claim.eventDate, policy, now }) : null;
  } catch {
    windows = null;
  }
  return buildFarmerProgress({
    claim: typeof claim.toObject === "function" ? claim.toObject() : claim,
    assessment,
    jobs,
    evidenceRows,
    photos: { count: stored.length, version: stored.length ? computeEvidenceVersion(stored) : null, latestAt: latestTime(photoDocs) },
    policy,
    windows,
    satelliteEnabled: satelliteEnabled(),
    automationEnabled: env.claimAutomatedVerificationEnabled,
    resubmitAllowed: resubmits < env.claimMaxResubmissions,
    latestAuditAt: latestAudit ? latestAudit.createdAt : null,
    now,
  });
};

// Owner-scoped: another farmer's (or an unknown) claim is a 404, exactly like every claim read.
export const getClaimProgressForUser = async ({ claimId, cognitoSub, now = new Date() } = {}) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) throw ApiError.badRequest("Valid claim id is required");
  if (!cognitoSub || typeof cognitoSub !== "string") throw ApiError.unauthorized("Authentication required");
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");
  return buildProgressForClaim({ claim, now });
};

export default { buildProgressForClaim, getClaimProgressForUser };
