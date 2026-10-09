import crypto from "node:crypto";

// Phase 12 (E12) — Land Ownership Verification foundation (ADR-019 annex, builds on Phase 11).
//
// The FIRST functional ownership workflow on top of the Phase 11 Verification Evidence
// Foundation. It lets a claimant ATTACH supporting land-ownership documents to a claim they own,
// and lets a reviewer classify each document honestly (manual review only) — WITHOUT making any
// legal eligibility determination, without changing any claim lifecycle state / decision / area,
// and without touching the frozen deterministic engine.
//
// This module is PURE (no DB, no Express, no network, no AI). It owns the ownership-specific
// vocabulary, validation, the review-outcome rules and the idempotency fingerprint. Persistence +
// audit live in services/ownershipEvidence.service.js.
//
// Honesty invariants:
//   - Uploading a document is NOT verification. A submission is recorded as PENDING and can only
//     be resolved by an ADMIN review (no self-verification).
//   - VERIFIED is reserved for an AUTHORITATIVE ownership provider (e.g. a future government land
//     registry integration). No authoritative provider is configured in this phase, so VERIFIED is
//     deliberately UNREACHABLE — `resolveOwnershipReviewOutcome` refuses it.
//   - No ownership rule (owner vs. representative, tenancy, succession, …) is invented here: the
//     repository defines none, so this phase records + reviews evidence only.

// --- Frozen ownership vocabulary ---------------------------------------------------------------

// Evidence source on the Phase 11 model. Must match utils/verificationEvidence.js EVIDENCE_SOURCES.
export const OWNERSHIP_SOURCE = "OWNERSHIP";

// Supporting-document categories. A safe, fixed vocabulary (never free text) so review tooling and
// future reporting stay queryable. "other" keeps the flow usable when nothing fits.
export const OWNERSHIP_DOCUMENT_CATEGORIES = [
  "land_record",
  "ownership_deed",
  "lease_agreement",
  "authorization_letter",
  "tax_receipt",
  "identity_proof",
  "other",
];

export const DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY = "other";

// Verification methods. Only human manual review is available today, and it is NOT authoritative.
// A future phase appends authoritative methods (e.g. "gov_land_registry") and only then may
// VERIFIED be produced.
export const OWNERSHIP_VERIFICATION_METHODS = ["manual_review"];
export const OWNERSHIP_AUTHORITATIVE_METHODS = []; // none configured this phase

export const DEFAULT_OWNERSHIP_VERIFICATION_METHOD = "manual_review";

// Status a freshly attached document starts in (evidence-level state; never a claim state).
export const OWNERSHIP_INITIAL_STATUS = "PENDING";

// Outcomes a REVIEW may produce. NOT_CHECKED/PENDING are NOT review outcomes.
export const OWNERSHIP_REVIEW_STATUSES = [
  "AVAILABLE",
  "VERIFIED",
  "INSUFFICIENT",
  "INCONSISTENT",
  "UNAVAILABLE",
];

// Review terminal once reached (a document may be reviewed exactly once).
export const OWNERSHIP_TERMINAL_STATUSES = [...OWNERSHIP_REVIEW_STATUSES];

export const OWNERSHIP_FOUNDATION_VERSION = "1";

// Idempotency: a document's uploadId already uniquely identifies the stored bytes, so the derived
// per-claim idempotency key makes re-registering the same upload a safe no-op.
export const OWNERSHIP_IDEMPOTENCY_PREFIX = "owndoc_";

export const OWNERSHIP_UPLOAD_ID_PATTERN = /^img_[0-9a-fA-F-]{36}$/;

export const OWNERSHIP_REVIEW_REASON_MIN = 10;
export const OWNERSHIP_REVIEW_REASON_MAX = 2000;

const CATEGORY_SET = new Set(OWNERSHIP_DOCUMENT_CATEGORIES);
const REVIEW_STATUS_SET = new Set(OWNERSHIP_REVIEW_STATUSES);
const METHOD_SET = new Set(OWNERSHIP_VERIFICATION_METHODS);

export const isOwnershipDocumentCategory = (value) => CATEGORY_SET.has(value);
export const isOwnershipReviewStatus = (value) => REVIEW_STATUS_SET.has(value);
export const isOwnershipVerificationMethod = (value) => METHOD_SET.has(value);
export const isOwnershipTerminalStatus = (value) => OWNERSHIP_TERMINAL_STATUSES.includes(value);

const normalizeCategory = (value) => {
  if (value === null || value === undefined || value === "") return DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY;
  return typeof value === "string" ? value.trim() : value;
};

export const validateOwnershipDocumentCategory = (value) => {
  const category = normalizeCategory(value);
  return isOwnershipDocumentCategory(category)
    ? { ok: true }
    : { ok: false, reason: "Unknown ownership document category" };
};

export const validateOwnershipUploadId = (uploadId) => {
  if (typeof uploadId !== "string" || !OWNERSHIP_UPLOAD_ID_PATTERN.test(uploadId.trim())) {
    return { ok: false, reason: "Invalid ownership document reference" };
  }
  return { ok: true };
};

export const validateOwnershipReviewReason = (reason) => {
  if (typeof reason !== "string") return { ok: false, reason: "A review reason is required" };
  const trimmed = reason.trim();
  if (trimmed.length < OWNERSHIP_REVIEW_REASON_MIN) {
    return { ok: false, reason: `Review reason must be at least ${OWNERSHIP_REVIEW_REASON_MIN} characters` };
  }
  if (trimmed.length > OWNERSHIP_REVIEW_REASON_MAX) {
    return { ok: false, reason: `Review reason exceeds ${OWNERSHIP_REVIEW_REASON_MAX} characters` };
  }
  return { ok: true };
};

// Deterministic, per-claim idempotency key derived from the (globally unique) uploadId. Fits the
// Phase 11 idempotencyKey contract: 64-char max, [A-Za-z0-9_-] only.
export const deriveOwnershipIdempotencyKey = (uploadId) =>
  `${OWNERSHIP_IDEMPOTENCY_PREFIX}${String(uploadId).trim()}`;

// Stable fingerprint of the attached document set identity (used as the Phase 11 evidenceVersion).
export const ownershipEvidenceFingerprint = ({ uploadId, mediaType = null, size = null } = {}) => {
  try {
    const canonical = JSON.stringify({
      uploadId: uploadId ?? null,
      mediaType: mediaType ?? null,
      size: typeof size === "number" ? size : null,
    });
    return crypto.createHash("sha1").update(canonical).digest("hex");
  } catch {
    return null;
  }
};

// Pure decision for a REVIEW transition. Returns { ok, reason } or { ok, method, authoritative }.
// Deliberately refuses VERIFIED while no authoritative method exists — an honest, explicit guard.
export const resolveOwnershipReviewOutcome = ({
  status,
  method = DEFAULT_OWNERSHIP_VERIFICATION_METHOD,
} = {}) => {
  if (!isOwnershipVerificationMethod(method)) {
    return { ok: false, reason: "Unknown ownership verification method" };
  }
  if (!isOwnershipReviewStatus(status)) {
    return { ok: false, reason: "Unsupported ownership review outcome" };
  }
  const authoritative = OWNERSHIP_AUTHORITATIVE_METHODS.includes(method);
  if (status === "VERIFIED" && !authoritative) {
    return {
      ok: false,
      reason: "Authoritative ownership verification is not configured; VERIFIED is unavailable",
    };
  }
  return { ok: true, method, authoritative };
};

export default {
  OWNERSHIP_SOURCE,
  OWNERSHIP_DOCUMENT_CATEGORIES,
  DEFAULT_OWNERSHIP_DOCUMENT_CATEGORY,
  OWNERSHIP_VERIFICATION_METHODS,
  OWNERSHIP_AUTHORITATIVE_METHODS,
  DEFAULT_OWNERSHIP_VERIFICATION_METHOD,
  OWNERSHIP_INITIAL_STATUS,
  OWNERSHIP_REVIEW_STATUSES,
  OWNERSHIP_TERMINAL_STATUSES,
  OWNERSHIP_FOUNDATION_VERSION,
  OWNERSHIP_IDEMPOTENCY_PREFIX,
  OWNERSHIP_UPLOAD_ID_PATTERN,
  OWNERSHIP_REVIEW_REASON_MIN,
  OWNERSHIP_REVIEW_REASON_MAX,
  isOwnershipDocumentCategory,
  isOwnershipReviewStatus,
  isOwnershipVerificationMethod,
  isOwnershipTerminalStatus,
  validateOwnershipDocumentCategory,
  validateOwnershipUploadId,
  validateOwnershipReviewReason,
  deriveOwnershipIdempotencyKey,
  ownershipEvidenceFingerprint,
  resolveOwnershipReviewOutcome,
};
