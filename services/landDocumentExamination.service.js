import mongoose from "mongoose";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import logger from "../utils/logger.js";
import ApiError from "../utils/ApiError.js";
import { model } from "./chat.service.js";
import { withAiTimeout, AiTimeoutError, getDefaultTimeoutMs } from "../utils/aiTimeout.js";
import { env } from "../config/env.js";
import ImageRecord from "../models/ImageRecord.js";
import VerificationEvidence from "../models/VerificationEvidence.js";
import LossClaim from "../models/LossClaim.js";
import User from "../models/User.js";
import FarmProfile from "../models/FarmProfile.js";
import { findOwned } from "./claim.service.js";
import * as s3 from "./s3.service.js";
import {
  validateEvidencePayload,
  sanitizeEvidencePayload,
} from "../utils/verificationEvidence.js";
import { isEvidenceStatus } from "../utils/verificationEvidence.js";

// AI land-document examination for the OWNERSHIP evidence surface (Phase 15 Phase 2).
//
// This service REUSES the existing image/AI provider (services/chat.service.js `model`) and the
// existing private S3 pipeline; it does not add a second provider client. It produces a STRICTLY
// validated, sanitized, field-level extraction from a uploaded land document, compares the
// extracted fields with the claim/parcel/claimant context, and persists the result on the
// owning OWNERSHIP VerificationEvidence row. It NEVER changes claim state, approved area, or
// parcel geometry, and never raises confidence to proof of ownership.

const FIELDS = [
  "documentType",
  "issuingAuthority",
  "recordNumber",
  "state",
  "district",
  "taluk",
  "village",
  "surveyNumber",
  "subdivisionNumber",
  "holderNames",
  "parcelExtent",
  "extentUnit",
  "documentDate",
  "additionalIdentifiers",
  "unreadable",
  "language",
  "confidence",
  "imageQuality",
];

const CLEAN_TEXT_MAX = 160;
const MAX_ADDITIONAL = 10;
const MAX_HOLDERS = 8;

const UNSURE_EXTRACTION = Object.freeze({
  documentType: null,
  issuingAuthority: null,
  recordNumber: null,
  state: null,
  district: null,
  taluk: null,
  village: null,
  surveyNumber: null,
  subdivisionNumber: null,
  holderNames: [],
  parcelExtent: null,
  extentUnit: null,
  documentDate: null,
  additionalIdentifiers: [],
  unreadable: true,
  language: null,
  confidence: "unclear",
  imageQuality: "unclear",
  missingFields: FIELDS.slice(0, -2),
});

const SYSTEM_INSTRUCTIONS = `You are Vivasayi AI land-document examination assistant.
Extract structured fields from the supplied land-record/ownership document IMAGE. The document
may be in Tamil or English. Return ONLY a single JSON object with these keys (use null when truly
unknown, never invent):
documentType (string or null), issuingAuthority (string or null), recordNumber (string or null),
state (string or null), district (string or null), taluk (string or null), village (string or null),
surveyNumber (string or null), subdivisionNumber (string or null),
holderNames (array of strings, empty if unknown),
parcelExtent (number or null), extentUnit (string or null, e.g. acre/hectare/sqft),
documentDate (ISO date string or null),
additionalIdentifiers (array of strings),
unreadable (boolean),
language (detected primary language code or null),
confidence (one of high|medium|low|unclear), imageQuality (one of good|poor|unreadable|unclear).
Never include acreage estimates, ownership conclusions, or legal determinations.`;

const cleanText = (value, max = CLEAN_TEXT_MAX) =>
  value == null ? null : String(value).trim().slice(0, max);

const cleanArray = (value, maxCount, maxChars) =>
  Array.isArray(value)
    ? value
        .slice(0, maxCount)
        .map((entry) => cleanText(entry, maxChars))
        .filter(Boolean)
    : [];

const pickEnum = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const extractJson = (text) => {
  if (!text || !String(text).trim()) return null;
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

const normalizeExtraction = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const extracted = {
    documentType: cleanText(raw.documentType),
    issuingAuthority: cleanText(raw.issuingAuthority),
    recordNumber: cleanText(raw.recordNumber),
    state: cleanText(raw.state),
    district: cleanText(raw.district),
    taluk: cleanText(raw.taluk),
    village: cleanText(raw.village),
    surveyNumber: cleanText(raw.surveyNumber),
    subdivisionNumber: cleanText(raw.subdivisionNumber),
    holderNames: cleanArray(raw.holderNames, MAX_HOLDERS, CLEAN_TEXT_MAX),
    parcelExtent: toNumberOrNull(raw.parcelExtent),
    extentUnit: cleanText(raw.extentUnit, 40),
    documentDate: cleanText(raw.documentDate, 40),
    additionalIdentifiers: cleanArray(raw.additionalIdentifiers, MAX_ADDITIONAL, CLEAN_TEXT_MAX),
    unreadable: raw.unreadable === true,
    language: cleanText(raw.language, 12),
    confidence: pickEnum(raw.confidence, ["high", "medium", "low", "unclear"], "unclear"),
    imageQuality: pickEnum(raw.imageQuality, ["good", "poor", "unreadable", "unclear"], "unclear"),
  };

  // Field-level missing info.
  const missingFields = [];
  for (const key of [
    "documentType",
    "issuingAuthority",
    "recordNumber",
    "state",
    "district",
    "village",
    "surveyNumber",
    "holderNames",
  ]) {
    const value = extracted[key];
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
      missingFields.push(key);
    }
  }

  return { ...extracted, missingFields };
};

// Convert the extracted extent into acres when the unit is recognisable so it can be compared
// with the claim parcel. Returns null when no safe conversion is available.
const extentToAcres = (extent, unit) => {
  if (typeof extent !== "number" || !unit) return null;
  const u = String(unit).toLowerCase().trim();
  if (u.includes("acre")) return extent;
  if (u.includes("hectare") || u === "ha") return extent * 2.47105;
  if (u.includes("sq") && u.includes("m")) return extent / 4046.86;
  if (u.includes("cent")) return extent / 100;
  return null;
};

const compareContext = ({ extracted, claim, profile, user, parcel }) => {
  const discrepancies = [];
  const holderMatchesClaimant =
    Array.isArray(extracted.holderNames) &&
    extracted.holderNames.length > 0 &&
    user &&
    user.name
      ? extracted.holderNames.some(
          (name) => String(name).toLowerCase() === String(user.name).toLowerCase()
        )
      : null;

  if (holderMatchesClaimant === false) {
    discrepancies.push("holder_name_mismatch");
  }

  // Extent vs parcel/claim area.
  const converted = extentToAcres(extracted.parcelExtent, extracted.extentUnit);
  const claimArea = claim ? Number(claim.claimedAreaAcres) : null;
  const parcelArea = parcel ? Number(parcel.calculatedAreaAcres) : null;
  const referenceArea = Number.isFinite(parcelArea) ? parcelArea : claimArea;
  let extentMatchesParcel = null;
  if (typeof converted === "number" && Number.isFinite(referenceArea) && referenceArea > 0) {
    const delta = Math.abs(converted - referenceArea) / referenceArea;
    extentMatchesParcel = delta <= 0.15; // tolerance, documented uncertainty
    if (!extentMatchesParcel) discrepancies.push("area_discrepancy");
  }

  // If a survey number is extracted, flag it as needing external verification rather than
  // "confirmed". No authoritative provider is wired this phase.
  const requiresExternalVerification = Boolean(extracted.surveyNumber);

  return {
    holderMatchesClaimant,
    extentMatchesParcel,
    convertedExtentAcres: converted,
    referenceAreaAcres: Number.isFinite(referenceArea) ? referenceArea : null,
    discrepancies,
    requiresExternalVerification,
    claimantName: user && user.name ? user.name : null,
    parcelId: claim ? claim.parcelId : null,
  };
};

const safeResultPayload = (value) => {
  const checked = validateEvidencePayload(value, "Land-document examination result");
  if (!checked.ok) throw ApiError.badRequest(checked.reason);
  return sanitizeEvidencePayload(value) || {};
};

export const examineOwnershipDocument = async ({ claimId, cognitoSub, evidenceId, requestId = null } = {}) => {
  if (!claimId || !mongoose.isValidObjectId(String(claimId))) {
    throw ApiError.badRequest("Valid claim id is required");
  }
  if (!evidenceId || !mongoose.isValidObjectId(String(evidenceId))) {
    throw ApiError.badRequest("Valid evidence id is required");
  }
  if (!cognitoSub) throw ApiError.unauthorized("Authentication required");

  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const row = await VerificationEvidence.findOne({
    _id: evidenceId,
    claimId: claim._id,
    source: "OWNERSHIP",
  });
  if (!row) throw ApiError.notFound("Ownership evidence not found");

  const image = await ImageRecord.findOne({ uploadId: row.reference, cognitoSub });
  if (!image || image.status !== "stored") {
    throw ApiError.notFound("Ownership document not found");
  }

  const fetched = await s3.getObject(image.s3Key);
  if (!fetched || !fetched.buffer) {
    throw ApiError.internal("Unable to read ownership document");
  }

  let normalized;
  if (env.imageAiMode === "mock") {
    normalized = normalizeExtraction({
      documentType: "land_record",
      issuingAuthority: "Mock Revenue Department",
      recordNumber: "MR-12345",
      state: "Tamil Nadu",
      district: "Thanjavur",
      taluk: "Thanjavur",
      village: "Example Village",
      surveyNumber: "123/1",
      subdivisionNumber: "2",
      holderNames: [claim.parcelSnapshot?.name ? claim.parcelSnapshot.name : "Farmer"],
      parcelExtent: claim.claimedAreaAcres,
      extentUnit: "acre",
      documentDate: new Date().toISOString().slice(0, 10),
      additionalIdentifiers: [],
      unreadable: false,
      language: "ta",
      confidence: "medium",
      imageQuality: "good",
    });
  } else {
    try {
      const messages = [
        new SystemMessage(SYSTEM_INSTRUCTIONS),
        new HumanMessage({
          content: [
            { type: "text", text: "Examine the attached land/ownership document and return JSON." },
            {
              type: "image_url",
              image_url: { url: `data:${fetched.mediaType || image.mediaType};base64,${fetched.buffer.toString("base64")}` },
            },
          ],
        }),
      ];
      const result = await withAiTimeout(
        () => model.generate([messages]),
        "landdoc.examine",
        getDefaultTimeoutMs()
      ).catch((err) => {
        if (err instanceof AiTimeoutError) throw ApiError.internal("AI service did not respond in time");
        throw err;
      });
      const text = result.generations?.[0]?.[0]?.text || "";
      const parsed = extractJson(text);
      if (!parsed) {
        normalized = normalizeExtraction({ unreadable: true, confidence: "unclear", imageQuality: "unreadable" });
      } else {
        normalized = normalizeExtraction(parsed);
      }
    } catch (error) {
      logger.error({ err: error }, "Land document examination failed");
      throw ApiError.internal("Failed to examine land document");
    }
  }

  const user = await User.findOne({ cognitoSub }).lean();
  const profile = await FarmProfile.findOne({ cognitoSub }).lean();
  const parcel = (profile?.parcels || []).find((p) => p.parcelId === claim.parcelId) || null;

  const comparison = compareContext({ extracted: normalized, claim, profile, user, parcel });

  // Field-level uncertainty preserved: missingFields from extraction plus discrepancies.
  const processedAt = new Date().toISOString();
  const examination = {
    processedAt,
    provider: env.imageAiMode === "mock" ? "mock-landdoc" : (env.modelProvider || "google-genai"),
    model: env.modelName || null,
    extracted: normalized,
    comparison,
    reviewRequired:
      normalized.unreadable ||
      (normalized.confidence === "low" || normalized.confidence === "unclear") ||
      comparison.discrepancies.length > 0 ||
      normalized.missingFields.length > 4,
  };

  const resultValue = safeResultPayload({
    ...(row.result || {}),
    aiLandDocumentExamination: examination,
  });

  // Persist on the ownership row without changing its manual-review status.
  await VerificationEvidence.updateOne(
    { _id: row._id },
    {
      $set: {
        result: resultValue,
        // Keep status unchanged for manual workflow; update metadata provenance.
        metadata: sanitizeEvidencePayload({
          ...(row.metadata || {}),
          landDocumentExaminedAt: processedAt,
          landDocumentExaminationAvailable: true,
        }),
      },
    }
  );

  return {
    evidenceId: String(row._id),
    uploadId: row.reference,
    examination,
  };
};

export const examineOwnershipDocumentsForClaim = async ({ claimId, cognitoSub, requestId = null } = {}) => {
  const claim = await findOwned(cognitoSub, claimId);
  if (!claim) throw ApiError.notFound("Claim not found");

  const rows = await VerificationEvidence.find({ claimId: claim._id, source: "OWNERSHIP" }).sort({ createdAt: 1 });
  const results = [];
  for (const row of rows) {
    try {
      results.push(await examineOwnershipDocument({ claimId, cognitoSub, evidenceId: String(row._id), requestId }));
    } catch (error) {
      results.push({ evidenceId: String(row._id), error: error.message || "examination failed" });
    }
  }
  return { claimId: String(claim._id), count: rows.length, results };
};

export default { examineOwnershipDocument, examineOwnershipDocumentsForClaim };