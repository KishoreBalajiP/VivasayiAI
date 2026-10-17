import ApiError from "../utils/ApiError.js";
import logger from "../utils/logger.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import { buildVerificationEvidence } from "../utils/verificationEvidence.js";
import { findOwned } from "./claim.service.js";
import { classifyProviderError, logProviderError, toProviderError } from "../utils/providerErrors.js";

// Official land-record verification provider abstraction (Phase 15 Phase 3).
//
// Tamil Nadu / regional official access is not configured in this environment. The service returns
// an explicit `unavailable` result (never VERIFIED) unless an authorized provider is configured.
// A `LAND_RECORD_MODE=mock` seam exists for tests only; it is documented as non-live.

const MODE = () => (process.env.LAND_RECORD_MODE || "live").toLowerCase();
const URL = () => process.env.LAND_RECORD_PROVIDER_URL || null;
const KEY = () => process.env.LAND_RECORD_API_KEY || null;
const TIMEOUT = () => Number(process.env.LAND_RECORD_TIMEOUT_MS) || 8000;

export const getOfficialLandRecordConfig = () => ({
  mode: MODE(),
  configured: Boolean(URL() && KEY()),
  hasCredentials: Boolean(KEY()),
  providerUrl: URL(),
});

export const queryOfficialLandRecord = async ({ state, district, taluk, village, surveyNumber, subdivisionNumber, holderNames, parcelExtentAcres } = {}) => {
  if (MODE() === "mock") {
    const outcome = (process.env.LAND_RECORD_MOCK_OUTCOME || "unavailable").toLowerCase();
    if (outcome === "match") {
      return {
        status: "matched",
        provider: "mock-land-record",
        liveValidated: false,
        record: {
          state: state || "Tamil Nadu",
          district: district || null,
          taluk: taluk || null,
          village: village || null,
          surveyNumber: surveyNumber || null,
          subdivisionNumber: subdivisionNumber || null,
          holderNames: Array.isArray(holderNames) ? holderNames : [],
          parcelExtentAcres: parcelExtentAcres ?? null,
        },
        discrepancies: [],
        referenceId: "mock-record-id",
        observedAt: new Date().toISOString(),
      };
    }
    if (outcome === "mismatch") {
      return {
        status: "mismatch",
        provider: "mock-land-record",
        liveValidated: false,
        record: null,
        discrepancies: ["survey_number_mismatch"],
        referenceId: null,
        observedAt: new Date().toISOString(),
      };
    }
    if (outcome === "not_found") {
      return {
        status: "not_found",
        provider: "mock-land-record",
        liveValidated: false,
        record: null,
        discrepancies: [],
        referenceId: null,
        observedAt: new Date().toISOString(),
      };
    }
    return {
      status: "unavailable",
      provider: "mock-land-record",
      liveValidated: false,
      record: null,
      discrepancies: [],
      referenceId: null,
      observedAt: new Date().toISOString(),
      reason: "Official land-record provider unavailable",
    };
  }

  if (!URL() || !KEY()) {
    return {
      status: "unavailable",
      provider: null,
      liveValidated: false,
      record: null,
      discrepancies: [],
      referenceId: null,
      observedAt: new Date().toISOString(),
      reason: "Official land-record provider is not configured",
    };
  }

  try {
    // Minimal generic adapter: submit identifiers only. Provider-specific response normalization
    // is intentionally conservative: unknown provider schemas are treated as unavailable.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT());
    let response;
    try {
      response = await fetch(URL(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${KEY()}`,
        },
        body: JSON.stringify({
          state,
          district,
          taluk,
          village,
          surveyNumber,
          subdivisionNumber,
          holderNames,
          parcelExtentAcres,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response.ok) {
      logger.warn({ status: response.status }, "Official land-record provider returned non-OK");
      return {
        status: "unavailable",
        provider: "official-land-record",
        liveValidated: false,
        record: null,
        discrepancies: [],
        referenceId: null,
        observedAt: new Date().toISOString(),
        reason: `Official land-record provider error (HTTP ${response.status})`,
        // Provider error kind (utils/providerErrors.js), additive: tells a quota refusal from a defect.
        reasonCode: classifyProviderError({ status: response.status }),
      };
    }
    const data = await response.json();
    // Conservative normalization: only accept explicit matched/unavailable signals.
    const providerStatus = String(data?.status || "").toLowerCase();
    if (providerStatus === "matched") {
      return {
        status: "matched",
        provider: "official-land-record",
        liveValidated: true,
        record: data.record || null,
        discrepancies: [],
        referenceId: data.referenceId || data.id || null,
        observedAt: new Date().toISOString(),
      };
    }
    if (providerStatus === "mismatch") {
      return {
        status: "mismatch",
        provider: "official-land-record",
        liveValidated: true,
        record: data.record || null,
        discrepancies: Array.isArray(data.discrepancies) ? data.discrepancies : ["provider_mismatch"],
        referenceId: data.referenceId || data.id || null,
        observedAt: new Date().toISOString(),
      };
    }
    if (providerStatus === "not_found") {
      return {
        status: "not_found",
        provider: "official-land-record",
        liveValidated: true,
        record: null,
        discrepancies: [],
        referenceId: null,
        observedAt: new Date().toISOString(),
      };
    }
    return {
      status: "unavailable",
      provider: "official-land-record",
      liveValidated: false,
      record: null,
      discrepancies: [],
      referenceId: null,
      observedAt: new Date().toISOString(),
      reason: "Official land-record provider returned unsupported response",
    };
  } catch (error) {
    const providerError = toProviderError(error, { provider: "official-land-record", operation: "landrecord.lookup" });
    logProviderError(logger, providerError);
    return {
      status: "unavailable",
      provider: "official-land-record",
      liveValidated: false,
      record: null,
      discrepancies: [],
      referenceId: null,
      observedAt: new Date().toISOString(),
      reason: "Official land-record provider unavailable",
      reasonCode: providerError.kind,
    };
  }
};

export const verifyOfficialLandRecordForClaim = async ({ claimId, cognitoSub, evidenceId = null, extracted = null } = {}) => {
  const claimDoc = await findOwned(cognitoSub, claimId);
  if (!claimDoc) throw ApiError.notFound("Claim not found");

  // The identifiers sent to the official provider must come from the stored AI examination of a
  // document the claimant attached, never from a request body: a caller-chosen payload would let a
  // claimant pick the values the "official" check runs against. `extracted` is therefore only an
  // internal argument (the automated pipeline passes the stored examination it just read).
  let ext = extracted;
  let sourceEvidenceId = evidenceId;
  if (!ext) {
    const row = await VerificationEvidence.findOne({
      claimId: claimDoc._id,
      source: "OWNERSHIP",
      "result.aiLandDocumentExamination.extracted": { $type: "object" },
    })
      .sort({ createdAt: -1 })
      .lean();
    ext = row?.result?.aiLandDocumentExamination?.extracted ?? null;
    sourceEvidenceId = sourceEvidenceId || (row ? String(row._id) : null);
  }
  if (!ext) {
    throw ApiError.conflict(
      "No examined ownership document is available. Attach a land document and run land-document examination first."
    );
  }

  const result = await queryOfficialLandRecord({
    state: ext.state,
    district: ext.district,
    taluk: ext.taluk,
    village: ext.village,
    surveyNumber: ext.surveyNumber,
    subdivisionNumber: ext.subdivisionNumber,
    holderNames: ext.holderNames,
    parcelExtentAcres: ext.parcelExtent ? ext.parcelExtent : null,
  });

  // Persist an OWNERSHIP-source verification row representing the official check.
  const idempotencyKey = `officialland_${String(claimId)}`;
  let existing = await VerificationEvidence.findOne({ claimId: claimDoc._id, idempotencyKey });
  const payloadResult = {
    officialLandRecord: {
      processedAt: new Date().toISOString(),
      ...result,
      note: result.liveValidated ? null : "Official land-record verification not live-validated",
    },
  };

  if (!existing) {
    try {
      const built = buildVerificationEvidence({
        source: "OWNERSHIP",
        status: result.status === "matched" ? "AVAILABLE" : result.status === "mismatch" ? "INCONSISTENT" : "UNAVAILABLE",
        confidence: result.status === "matched" ? 0.5 : null,
        observedAt: result.observedAt ? new Date(result.observedAt) : null,
        provider: result.provider,
        providerVersion: "phase15-official-landrecord-v1",
        evidenceVersion: idempotencyKey,
        evaluationVersion: "phase15-official-landrecord-v1",
        reference: sourceEvidenceId || null,
        metadata: { checkType: "official_land_record", claimId: String(claimId) },
        result: payloadResult,
      });
      existing = await VerificationEvidence.create({
        claimId: claimDoc._id,
        source: built.source,
        status: built.status,
        confidence: built.confidence,
        observedAt: built.observedAt,
        provider: built.provider,
        providerVersion: built.providerVersion,
        evidenceVersion: built.evidenceVersion,
        evaluationVersion: built.evaluationVersion,
        reference: built.reference,
        metadata: built.metadata,
        result: built.result,
        idempotencyKey,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      existing = await VerificationEvidence.findOne({ claimId: claimDoc._id, idempotencyKey });
    }
  } else {
    await VerificationEvidence.updateOne(
      { _id: existing._id },
      { $set: { result: payloadResult, status: result.status === "matched" ? "AVAILABLE" : result.status === "mismatch" ? "INCONSISTENT" : "UNAVAILABLE" } }
    );
    existing = await VerificationEvidence.findById(existing._id);
  }

  return { claimId: String(claimDoc._id), result, evidenceId: existing ? String(existing._id) : null };
};

export default { getOfficialLandRecordConfig, queryOfficialLandRecord, verifyOfficialLandRecordForClaim };