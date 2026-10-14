import * as satelliteAdapter from "./satellite/satelliteAdapter.js";
import { recordVerificationEvidence } from "./verificationEvidence.service.js";
import ApiError from "../utils/ApiError.js";

// Satellite verification for Phase 15: run existing adapter (honest, never fabricates), then persist
// a non-operative SATELLITE VerificationEvidence row. Does not touch claim state.

export const runSatelliteVerificationForClaim = async ({ claimId, cognitoSub, claim, parcel, startDate, endDate } = {}) => {
  const run = await satelliteAdapter.runSatelliteAnalysis({
    aoi: parcel && parcel.geometry ? parcel.geometry : claim?.claimedGeometry,
    window: { start: startDate, end: endDate },
    requestProcessing: true,
    correlationId: String(claimId),
  });

  const result = await recordVerificationEvidence({
    claimId,
    cognitoSub,
    source: "SATELLITE",
    status: run.evidenceStatus || "UNAVAILABLE",
    confidence: null,
    observedAt: run.observedAt ? new Date(run.observedAt) : null,
    provider: run.provider || null,
    providerVersion: run.providerVersion || null,
    evidenceVersion: run.evidence ? run.evidence.evidenceVersion : null,
    evaluationVersion: "satellite-adapter-ndvi-v1",
    reference: run.aoi && run.aoi.fingerprint ? run.aoi.fingerprint : null,
    metadata: (run.evidence && run.evidence.metadata) || {},
    result: (run.evidence && run.evidence.result) || null,
    idempotencyKey: `satellite_${String(claimId)}`,
  });

  return { run, persisted: result };
};

export default { runSatelliteVerificationForClaim };