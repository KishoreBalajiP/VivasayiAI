import { createHash } from "node:crypto";
import LossClaim from "../models/LossClaim.js";
import { computeOverlapAcres } from "./claimSpatial.service.js";
import { geometryBbox } from "../utils/geometryBbox.js";

// ADR-020 — overlap with OTHER farmers' claims. The existing spatial engine only looks at the
// claimant's own claims on their own parcel, so two people claiming the same land were never
// detected. The result is a REVIEW signal, never a verdict: shared boundaries, joint holdings,
// tenancy and cadastral error all produce legitimate overlap, so this never marks a claim a
// duplicate and never rejects anything.
//
// Privacy: `matches` holds other farmers' claim ids and areas. It is for the ADMIN audit trail
// only and must never be copied into a farmer-facing response.

// States in which another claim still "occupies" the land.
const OCCUPYING_STATES = ["verified", "partially_verified", "submitted", "processing", "more_evidence_required"];
const MAX_CANDIDATES = 50;

export const findCrossFarmerOverlap = async ({ claim, cognitoSub, thresholds }) => {
  const box = claim && claim.bbox && Number.isFinite(claim.bbox.minLon) ? claim.bbox : geometryBbox(claim && claim.claimedGeometry);
  const none = { flagged: false, matchCount: 0, maxOverlapAcres: 0, maxShare: 0, matches: [], matchKey: null };
  if (!box || !claim.claimedAreaAcres) return none;

  const candidates = await LossClaim.find({
    cognitoSub: { $ne: cognitoSub },
    _id: { $ne: claim._id },
    state: { $in: OCCUPYING_STATES },
    "bbox.minLon": { $lte: box.maxLon },
    "bbox.maxLon": { $gte: box.minLon },
    "bbox.minLat": { $lte: box.maxLat },
    "bbox.maxLat": { $gte: box.minLat },
  })
    .select("claimedGeometry claimedAreaAcres state")
    .limit(MAX_CANDIDATES)
    .lean();

  const matches = [];
  for (const candidate of candidates) {
    const overlapAcres = computeOverlapAcres({ geometryA: claim.claimedGeometry, geometryB: candidate.claimedGeometry });
    const share = overlapAcres / claim.claimedAreaAcres;
    if (overlapAcres >= thresholds.minOverlapAcres && share >= thresholds.minShare) {
      matches.push({
        claimId: String(candidate._id),
        state: candidate.state,
        overlapAcres: Math.round(overlapAcres * 10000) / 10000,
        share: Math.round(share * 10000) / 10000,
      });
    }
  }
  if (matches.length === 0) return none;

  // Stable identity of THIS set of matches, so the admin audit row is written once per situation.
  const matchKey = createHash("sha1")
    .update(JSON.stringify(matches.map((match) => [match.claimId, match.state]).sort()))
    .digest("hex")
    .slice(0, 24);
  return {
    flagged: true,
    matchCount: matches.length,
    maxOverlapAcres: Math.max(...matches.map((match) => match.overlapAcres)),
    maxShare: Math.max(...matches.map((match) => match.share)),
    matches,
    matchKey,
  };
};

export default { findCrossFarmerOverlap };
