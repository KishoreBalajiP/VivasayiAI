import crypto from "node:crypto";
import ApiError from "./ApiError.js";

// Phase 11 (E11-S11) — Verification Evidence Foundation (ADR-019 annex).
//
// A canonical, source-neutral abstraction that lets the EXISTING deterministic claim system
// represent evidence from MULTIPLE sources in one consistent, auditable shape — without changing
// the verification engine, the claim statuses, the AI-only field contract, or any current
// outcome. OWNERSHIP and SATELLITE are representable from day one but NON-OPERATIVE: no decision
// logic may consume them until their dedicated phases (Phase 12 / Phase 13+).
//
// This module is PURE (no DB, no Express, no network, no AI). It owns the frozen vocabularies,
// input validation, safe metadata normalization, and a read-only projection of the evidence the
// system ALREADY produces (GEOMETRY / AI_IMAGE / WEATHER). Persistence + audit live in
// services/verificationEvidence.service.js.
//
// Invariants (mirror the existing architecture):
//   - Evidence "status" is an EVIDENCE-LEVEL state. It is NEVER a claim lifecycle state
//     (models/LossClaim.js CLAIM_STATES) and must never be copied into `claim.state`.
//   - The AI never produces area/polygon/boundary/compensation/status (P4). GEOMETRY is the only
//     area authority; this foundation never derives acreage from any other source.
//   - Metadata is source-neutral and safe: storage internals, credentials, prompts, and raw
//     document/image content are structurally refused (see FORBIDDEN_METADATA_KEYS).

// --- Frozen evidence-source vocabulary (exactly these five; no extras) ---
export const EVIDENCE_SOURCES = ["GEOMETRY", "AI_IMAGE", "WEATHER", "OWNERSHIP", "SATELLITE"];

// --- Frozen evidence-state vocabulary (evidence-level ONLY — never claim states) ---
export const EVIDENCE_STATUSES = [
  "NOT_CHECKED",
  "PENDING",
  "AVAILABLE",
  "VERIFIED",
  "INSUFFICIENT",
  "INCONSISTENT",
  "UNAVAILABLE",
];

// Sources the deterministic engine may consume TODAY. OWNERSHIP / SATELLITE are deliberately
// excluded — they are stored/represented only, and cannot affect a decision this phase.
export const OPERATIVE_EVIDENCE_SOURCES = ["GEOMETRY", "AI_IMAGE", "WEATHER"];
export const FUTURE_EVIDENCE_SOURCES = ["OWNERSHIP", "SATELLITE"];

// Version of the foundation itself (distinct from the verification engine version and from any
// provider/model version). Bump only when the canonical representation changes incompatibly.
export const EVIDENCE_FOUNDATION_VERSION = "1";

const SOURCE_SET = new Set(EVIDENCE_SOURCES);
const STATUS_SET = new Set(EVIDENCE_STATUSES);
const OPERATIVE_SET = new Set(OPERATIVE_EVIDENCE_SOURCES);

export const isEvidenceSource = (value) => SOURCE_SET.has(value);
export const isEvidenceStatus = (value) => STATUS_SET.has(value);
export const isOperativeEvidenceSource = (value) => OPERATIVE_SET.has(value);

// Max printable lengths (characters) for the identifier-style metadata fields.
const MAX_SOURCE_FIELD = 128;
const MAX_REFERENCE_FIELD = 256;
const MAX_METADATA_JSON = 4096;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_STRING = 512;
const MAX_METADATA_ARRAY = 64;

// Keys that can NEVER appear anywhere in evidence metadata/result:
//   - storage internals       : s3Key, s3Bucket, bucket, key, objectKey
//   - ownership/identity      : cognitoSub, ownerSub, email, phone
//   - credentials/secrets     : token, accessToken, refreshToken, secret, password, apiKey,
//                               authorization, credential, signature
//   - provider prompt / model  : prompt, systemInstruction, request
//   - raw content             : buffer, image, imageBytes, body, content, rawPayload, base64
//   - signed URLs             : signedUrl, url, presignedUrl
const FORBIDDEN_METADATA_KEYS = new Set([
  "s3key",
  "s3bucket",
  "bucket",
  "objectkey",
  "cognitosub",
  "ownersub",
  "email",
  "phone",
  "token",
  "accesstoken",
  "refreshtoken",
  "secret",
  "password",
  "apikey",
  "authorization",
  "credential",
  "signature",
  "prompt",
  "systeminstruction",
  "request",
  "buffer",
  "image",
  "imagebytes",
  "body",
  "content",
  "rawpayload",
  "base64",
  "signedurl",
  "presignedurl",
  "url",
]);

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasForbiddenKey = (value, depth = 0) => {
  if (depth > MAX_METADATA_DEPTH) return true; // over-deep is unsafe by definition
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenKey(entry, depth + 1));
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_METADATA_KEYS.has(String(key).toLowerCase())) return true;
      if (hasForbiddenKey(entry, depth + 1)) return true;
    }
  }
  return false;
};

// Recursively drop nothing (validation happens first); this produces the stored, plain, JSON-safe
// shape and caps string/array sizes so a caller can never persist an oversized blob.
export const sanitizeEvidencePayload = (value, depth = 0) => {
  if (value === null || value === undefined) return null;
  if (depth > MAX_METADATA_DEPTH) return null;
  if (typeof value === "string") {
    return value.length > MAX_METADATA_STRING ? value.slice(0, MAX_METADATA_STRING) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ARRAY).map((entry) => sanitizeEvidencePayload(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeEvidencePayload(entry, depth + 1);
    }
    return out;
  }
  return null; // functions/symbols/etc. are never storable
};

// Pure validation of the source-neutral metadata/result payload. Returns { ok, reason }.
export const validateEvidencePayload = (value, label = "Evidence metadata") => {
  if (value === null || value === undefined) return { ok: true };
  if (!isPlainObject(value)) return { ok: false, reason: `${label} must be an object` };
  if (hasForbiddenKey(value)) {
    return { ok: false, reason: `${label} contains a disallowed field` };
  }
  let size;
  try {
    size = JSON.stringify(value).length;
  } catch {
    return { ok: false, reason: `${label} is not serializable` };
  }
  if (size > MAX_METADATA_JSON) return { ok: false, reason: `${label} is too large` };
  return { ok: true };
};

export const validateEvidenceSource = (source) =>
  isEvidenceSource(source) ? { ok: true } : { ok: false, reason: "Unknown evidence source" };

export const validateEvidenceStatus = (status) =>
  isEvidenceStatus(status) ? { ok: true } : { ok: false, reason: "Unknown evidence status" };

export const validateEvidenceConfidence = (confidence) => {
  if (confidence === null || confidence === undefined) return { ok: true };
  if (typeof confidence !== "number" || Number.isNaN(confidence)) {
    return { ok: false, reason: "Evidence confidence must be a number" };
  }
  if (confidence < 0 || confidence > 1) {
    return { ok: false, reason: "Evidence confidence must be between 0 and 1" };
  }
  return { ok: true };
};

const validateOptionalString = (value, label, max) => {
  if (value === null || value === undefined || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, reason: `${label} must be a string` };
  if (value.trim().length > max) return { ok: false, reason: `${label} is too long` };
  return { ok: true };
};

const validateObservedAt = (value) => {
  if (value === null || value === undefined) return { ok: true };
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(time)) return { ok: false, reason: "observedAt must be a valid date" };
  return { ok: true };
};

const toDateOrNull = (value) => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
};

// Canonical, validated evidence record (plain object). Throws ApiError.badRequest on any invalid
// input so every caller (service, future phases) shares one validation boundary. `operative` is a
// DERIVED, non-persisted convenience flag documenting whether the engine may consume the source.
export const buildVerificationEvidence = ({
  source,
  status = "NOT_CHECKED",
  confidence = null,
  observedAt = null,
  provider = null,
  providerVersion = null,
  evidenceVersion = null,
  evaluationVersion = null,
  reference = null,
  metadata = null,
  result = null,
} = {}) => {
  const checks = [
    validateEvidenceSource(source),
    validateEvidenceStatus(status),
    validateEvidenceConfidence(confidence),
    validateObservedAt(observedAt),
    validateOptionalString(provider, "Evidence provider", MAX_SOURCE_FIELD),
    validateOptionalString(providerVersion, "Evidence provider version", MAX_SOURCE_FIELD),
    validateOptionalString(evidenceVersion, "Evidence version", MAX_SOURCE_FIELD),
    validateOptionalString(evaluationVersion, "Evaluation version", MAX_SOURCE_FIELD),
    validateOptionalString(reference, "Evidence reference", MAX_REFERENCE_FIELD),
    validateEvidencePayload(metadata, "Evidence metadata"),
    validateEvidencePayload(result, "Evidence result"),
  ];
  const failed = checks.find((check) => !check.ok);
  if (failed) throw ApiError.badRequest(failed.reason);

  return {
    source,
    status,
    confidence: confidence === undefined ? null : confidence,
    observedAt: toDateOrNull(observedAt),
    provider: provider || null,
    providerVersion: providerVersion || null,
    evidenceVersion: evidenceVersion || null,
    evaluationVersion: evaluationVersion || null,
    reference: reference || null,
    metadata: sanitizeEvidencePayload(metadata) || {},
    result: sanitizeEvidencePayload(result),
    operative: isOperativeEvidenceSource(source),
  };
};

// --- Read-only projection of evidence the system ALREADY produces ---------------------------
//
// Unifies the existing GEOMETRY (server-computed parcel/claim geometry), AI_IMAGE (Phase 4
// ClaimAssessment observations) and WEATHER (supporting-only correlation) representations into
// the canonical shape. This NEVER persists, NEVER fabricates a record that has no backing data,
// and NEVER influences a decision. Existing claims therefore keep working with zero migration.

export const GEOMETRY_EVIDENCE_PROVIDER = "server-geometry";

const geometryFingerprint = (geometry, areaAcres) => {
  try {
    const canonical = JSON.stringify({
      geometry: geometry || null,
      areaAcres: typeof areaAcres === "number" ? areaAcres : null,
    });
    return crypto.createHash("sha1").update(canonical).digest("hex");
  } catch {
    return null;
  }
};

const mapAssessmentStatus = (assessment) => {
  if (!assessment) return "NOT_CHECKED";
  switch (assessment.status) {
    case "completed":
      return "AVAILABLE";
    case "processing":
    case "pending":
      return "PENDING";
    case "failed":
      return "UNAVAILABLE";
    default:
      return "NOT_CHECKED";
  }
};

// Build the canonical, read-only representation of an existing claim's evidence. Pure: callers
// pass already-loaded documents. Returns [] fields only when a backing source exists.
export const projectExistingEvidence = ({ claim, assessment = null, evidenceDocs = [], weatherCorrelation = null } = {}) => {
  const records = [];
  if (!claim) return records;

  const doc = typeof claim.toObject === "function" ? claim.toObject() : claim;
  const claimId = doc._id ? String(doc._id) : null;

  // GEOMETRY — always present on a persisted claim (server-validated + server-computed area).
  if (doc.claimedGeometry) {
    records.push({
      claimId,
      source: "GEOMETRY",
      status: "AVAILABLE",
      confidence: null,
      observedAt: null,
      provider: GEOMETRY_EVIDENCE_PROVIDER,
      providerVersion: EVIDENCE_FOUNDATION_VERSION,
      evidenceVersion: geometryFingerprint(doc.claimedGeometry, doc.claimedAreaAcres),
      evaluationVersion: null,
      reference: doc.parcelId || null,
      metadata: {
        parcelId: doc.parcelId || null,
        claimedAreaAcres: typeof doc.claimedAreaAcres === "number" ? doc.claimedAreaAcres : null,
      },
      result: null,
      operative: true,
      derived: true,
    });
  }

  // AI_IMAGE — one canonical record per STORED evidence image (mirrors Phase 4 exactly).
  const stored = (evidenceDocs || []).filter((entry) => entry && entry.status === "stored");
  const observationsByUpload = new Map(
    (assessment && Array.isArray(assessment.aiImageAssessments) ? assessment.aiImageAssessments : [])
      .map((entry) => [entry.uploadId, entry.observation])
  );
  for (const evidence of stored) {
    const observation = observationsByUpload.get(evidence.uploadId) || null;
    records.push({
      claimId,
      source: "AI_IMAGE",
      status: mapAssessmentStatus(assessment),
      confidence: null,
      observedAt: evidence.uploadedAt || null,
      provider: assessment ? assessment.model || null : null,
      providerVersion: assessment ? assessment.version || null : null,
      evidenceVersion: assessment ? assessment.evidenceVersion || null : null,
      evaluationVersion: null,
      reference: evidence.uploadId || null,
      metadata: {
        mediaType: evidence.mediaType || null,
        width: typeof evidence.width === "number" ? evidence.width : null,
        height: typeof evidence.height === "number" ? evidence.height : null,
      },
      result: observation
        ? {
            damageDetected: observation.damageDetected ?? null,
            damageType: observation.damageType ?? null,
            severity: observation.severity ?? null,
            imageQuality: observation.imageQuality ?? null,
          }
        : null,
      operative: true,
      derived: true,
    });
  }

  // WEATHER — supporting-only correlation; a record exists only when a correlation exists.
  if (weatherCorrelation && typeof weatherCorrelation === "object") {
    records.push({
      claimId,
      source: "WEATHER",
      status: weatherCorrelation.eventMatch === false ? "INSUFFICIENT" : "AVAILABLE",
      confidence: null,
      observedAt: null,
      provider: weatherCorrelation.source || null,
      providerVersion: null,
      evidenceVersion: null,
      evaluationVersion: null,
      reference: null,
      metadata: {
        precipitationMm: weatherCorrelation.precipitationMm ?? null,
        weatherCode: weatherCorrelation.weatherCode ?? null,
      },
      result: { eventMatch: weatherCorrelation.eventMatch ?? null },
      operative: true,
      derived: true,
    });
  }

  return records;
};

export default {
  EVIDENCE_SOURCES,
  EVIDENCE_STATUSES,
  OPERATIVE_EVIDENCE_SOURCES,
  FUTURE_EVIDENCE_SOURCES,
  EVIDENCE_FOUNDATION_VERSION,
  isEvidenceSource,
  isEvidenceStatus,
  isOperativeEvidenceSource,
  validateEvidenceSource,
  validateEvidenceStatus,
  validateEvidenceConfidence,
  validateEvidencePayload,
  sanitizeEvidencePayload,
  buildVerificationEvidence,
  projectExistingEvidence,
};
