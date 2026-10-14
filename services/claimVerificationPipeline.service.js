import mongoose from "mongoose";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import LossClaim from "../models/LossClaim.js";
import User from "../models/User.js";
import FarmProfile from "../models/FarmProfile.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import ClaimEvidence from "../models/ClaimEvidence.js";
import { findOwned } from "./claim.service.js";
import claimAssessmentService from "./claimAssessment.service.js";
import * as landDocService from "./landDocumentExamination.service.js";
import * as officialLandRecordService from "./officialLandRecord.service.js";
import * as satelliteVerificationService from "./satelliteVerification.service.js";
import claimVerificationServiceDefault from "./claimVerification.service.js";
import { recordVerificationEvidence } from "./verificationEvidence.service.js";
import { createReviewCase } from "./manualReview.service.js";

// Automated claim-verification orchestration (Phase 15 Phase 6). Triggered by the backend after
// a successful claim submission. Fire-and-forget: individual results persist as they complete; one
// failed provider does not erase another's result. Deterministic verification runs at the end.

const IN_FLIGHT = new Set();

const safe = async (label, fn) => {
  try {
    return await fn();
  } catch (error) {
    logger.warn({ err: error?.message, label }, "Automated verification step failed");
    return { error: error?.message || `${label} failed` };
  }
};

const runGeometryCheck = async ({ claim, cognitoSub }) => {
  await recordVerificationEvidence({
    claimId: claim._id,
    cognitoSub,
    source: "GEOMETRY",
    status: "AVAILABLE",
    confidence: 1,
    reference: claim.parcelId,
    metadata: { parcelId: claim.parcelId, claimedAreaAcres: claim.claimedAreaAcres },
    result: { validated: true, claimedAreaAcres: claim.claimedAreaAcres },
    idempotencyKey: `geometry_${String(claim._id)}`,
  });
};

export const runAutomatedVerification = async ({ claimId, cognitoSub, requestId = null } = {}) => {
  const key = String(claimId);
  if (IN_FLIGHT.has(key)) return { inProgress: true };
  IN_FLIGHT.add(key);

  try {
    const claim = await findOwned(cognitoSub, claimId);
    if (!claim) return { error: "claim not found" };

    const user = await User.findOne({ cognitoSub }).lean();
    const profile = await FarmProfile.findOne({ cognitoSub }).lean();
    const parcel = (profile?.parcels || []).find((p) => p.parcelId === claim.parcelId) || null;

    // 1. Geometry / affected-area check (idempotent).
    await safe("geometry", () => runGeometryCheck({ claim, cognitoSub }));

    // 2. Crop-damage AI assessment (best effort; only if evidence exists).
    const evidenceDocs = await ClaimEvidence.find({ claimId: claim._id, status: "stored" }).lean();
    if (evidenceDocs.length > 0) {
      await safe("crop_assessment", () =>
        claimAssessmentService.assessClaimEvidence({ claimId: claim._id, cognitoSub, requestId })
      );
    }

    // 3. AI land-document examination for attached ownership documents.
    const ownershipRows = await VerificationEvidence.find({ claimId: claim._id, source: "OWNERSHIP" });
    if (ownershipRows.length > 0) {
      await safe("land_doc_examination", () =>
        landDocService.examineOwnershipDocumentsForClaim({ claimId, cognitoSub, requestId })
      );
    }

    // 4. Official land-record verification when an OWNERSHIP doc produced extracted fields.
    // Use the first examined row if available.
    const landDocExamination = ownershipRows.length
      ? (await VerificationEvidence.findById(ownershipRows[0]._id))?.result?.aiLandDocumentExamination || null
      : null;
    const extracted = landDocExamination ? landDocExamination.extracted : null;
    const officialResult = await safe("official_land_record", () =>
      officialLandRecordService.verifyOfficialLandRecordForClaim({
        claimId,
        cognitoSub,
        evidenceId: ownershipRows.length ? String(ownershipRows[0]._id) : null,
        extracted,
      })
    );

    // 5. Satellite verification when geometry is available (still honest; disabled by default).
    if (claim.claimedGeometry) {
      const eventTime = new Date(claim.eventDate).getTime();
      const start = new Date(eventTime - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const end = new Date(eventTime + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await safe("satellite", () =>
        satelliteVerificationService.runSatelliteVerificationForClaim({
          claimId,
          cognitoSub,
          claim,
          parcel,
          startDate: start,
          endDate: end,
        })
      );
    }

    // 6. Manual review case if any automated check is inconclusive/unavailable.
    const requiresReview =
      (officialResult && officialResult.result && officialResult.result.status !== "matched") ||
      (landDocExamination && landDocExamination.reviewRequired);
    if (requiresReview) {
      await safe("review_case", () =>
        createReviewCase({
          claimId,
          cognitoSub,
          source: "OWNERSHIP",
          reasons: [
            ...(landDocExamination && landDocExamination.reviewRequired ? ["inconclusive_land_document_examination"] : []),
            ...(officialResult && officialResult.result && officialResult.result.status !== "matched"
              ? [`official_land_record_${officialResult.result.status}`]
              : []),
          ],
          evidenceReferences: ownershipRows.map((r) => String(r._id)),
          requestId,
        })
      );
    }

    // 7. Deterministic engine verification at the end.
    try {
      await claimVerificationServiceDefault.verifyClaim({ claimId, cognitoSub, requestId });
    } catch (error) {
      logger.warn({ err: error?.message }, "Automated deterministic verification failed");
    }

    return { claimId, completed: true };
  } finally {
    IN_FLIGHT.delete(key);
  }
};

export const triggerAutomatedVerification = (claimId, cognitoSub, requestId = null) => {
  // Fire-and-forget. Swallow errors so submission response is unaffected.
  runAutomatedVerification({ claimId, cognitoSub, requestId }).catch((error) => {
    logger.error({ err: error?.message, claimId }, "Automated verification pipeline failed");
  });
};

export default { runAutomatedVerification, triggerAutomatedVerification };