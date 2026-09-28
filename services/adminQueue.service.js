// Phase 10 (E9-S10) — Admin review-queue helpers (pure, unit-testable in isolation).
//
// The admin queue is READ-ONLY and shows only claims a human may need to look at:
//   • engine decision states that warrant review — rejected, out_of_limit, duplicate_area,
//     more_evidence_required (normal VERIFIED claims are NOT in the queue — the verification
//     engine is the primary decision-maker, P7/ADR-019);
//   • AI-failure cases (claim stuck in `processing` with a failed assessment);
//   • any claim with an active farmer appeal (farmers appeal ONLY eligible engine decisions).
//
// Everything here is deterministic and DB-free: filter normalization, claim-match construction,
// default sorting, and row serialization. The Mongo aggregation logic that consumes these
// helpers lives in services/admin.service.js.

export const QUEUE_STATES = [
  "rejected",
  "out_of_limit",
  "duplicate_area",
  "more_evidence_required",
];

export const QUEUE_STATE_SET = new Set(QUEUE_STATES);

export const isQueueState = (state) => QUEUE_STATE_SET.has(state);

export const QUEUE_DEFAULT_LIMIT = 20;
export const QUEUE_MAX_LIMIT = 100;
export const QUEUE_DEFAULT_PAGE = 1;

// Normalize raw (?page=, ?limit=, ?status=, …) strings into a safe filter object. Non-numeric
// page/limit fall back to defaults; status/search strings are trimmed and capped. Deterministic.
export const normalizeQueueFilters = (raw = {}) => {
  const toBool = (value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  };
  const toPositiveInt = (value, fallback, max) => {
    const n = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
  };
  return {
    status: typeof raw.status === "string" ? raw.status.trim().slice(0, 120) || null : null,
    eventType: typeof raw.eventType === "string" ? raw.eventType.trim().slice(0, 40) || null : null,
    search: typeof raw.search === "string" ? raw.search.trim().slice(0, 200) || null : null,
    withAppeal: toBool(raw.withAppeal),
    aiFailed: toBool(raw.aiFailed),
    page: toPositiveInt(raw.page, QUEUE_DEFAULT_PAGE, 10000),
    limit: toPositiveInt(raw.limit, QUEUE_DEFAULT_LIMIT, QUEUE_MAX_LIMIT),
  };
};

// Build the claim-level `$match` fragment (pure). The AI-failure leg needs the assessment
// $lookup, so the full pipeline (in admin.service.js) ORs this with an aiFailed leg.
export const buildQueueClaimMatch = (filters) => {
  const match = {};
  const { status, eventType, search } = filters;
  if (status) match.state = status;
  if (eventType) match.eventType = eventType;
  if (search) {
    const re = new RegExp(escapeRegExp(search), "i");
    match.$or = [
      { "parcelSnapshot.name": re },
      { "parcelSnapshot.crop": re },
      { "parcelSnapshot.parcelId": re },
      { "parcelId": re },
      { "eventType": re },
    ];
  }
  return match;
};

export const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Pure regex used by the aggregation $addFields stage to flag AI-failed claims.
export const aiFailedExpression = {
  $or: [
    { $eq: ["$assessment.status", "failed"] },
    { $eq: ["$assessment.verification.status", "failed"] },
  ],
};

// Deterministic queue sort: recently decided first, then most recently created.
export const compareQueueRows = (a, b) => {
  const at = a.decidedAt ? new Date(a.decidedAt).getTime() : 0;
  const bt = b.decidedAt ? new Date(b.decidedAt).getTime() : 0;
  if (at !== bt) return bt - at;
  return (new Date(b.createdAt)?.getTime() || 0) - (new Date(a.createdAt)?.getTime() || 0);
};

// Pure: builds the final `$match` for the queue pipeline against the $addFields-computed flags
// (hasActiveAppeal, aiFailed). Contract for the aggregation in admin.service.js:
//   - default queue   = engine-review states (rejected/out_of_limit/duplicate_area/
//                       more_evidence_required) UNION AI-failed claims (stuck in processing);
//   - status filter   = narrow to one engine state (drops the default UNION);
//   - aiFailed=true   = show only AI-failed claims;
//   - aiFailed=false  = exclude AI failures (engine-review states only);
//   - withAppeal      = true/false narrows to active-appeal presence;
//   - eventType/search = additive claim-level filters (AND).
// The return value is a Mongo query document (pure, DB-free, unit-testable).
export const buildPostMatch = (filters) => {
  const legs = [];
  if (filters.aiFailed === true && !filters.status) {
    legs.push({ $and: [{ aiFailed: true }] });
  } else if (filters.aiFailed === true && filters.status) {
    legs.push({ state: filters.status }, { $and: [{ aiFailed: true }] });
  } else if (filters.status) {
    legs.push({ state: filters.status });
  } else if (filters.aiFailed === false) {
    legs.push({ state: { $in: QUEUE_STATES } });
  } else {
    legs.push({ state: { $in: QUEUE_STATES } });
    legs.push({ $and: [{ aiFailed: true }] });
  }

  let match = { $or: legs };
  const clauses = [];
  if (filters.withAppeal === true) clauses.push({ hasActiveAppeal: true });
  else if (filters.withAppeal === false) clauses.push({ hasActiveAppeal: { $ne: true } });
  if (filters.eventType) clauses.push({ eventType: filters.eventType });
  if (filters.search) {
    const re = new RegExp(escapeRegExp(filters.search), "i");
    clauses.push({
      $or: [
        { "parcelSnapshot.name": re },
        { "parcelSnapshot.crop": re },
        { "parcelSnapshot.parcelId": re },
        { "parcelId": re },
        { "eventType": re },
      ],
    });
  }
  if (clauses.length) match = { $and: [match, ...clauses] };
  return match;
};

// Pure serialization of a queue row (one claim + its optional assessment + active appeal).
// Never exposes cognitoSub, profileId, idempotencyKeys, s3Keys or raw AI audit internals.
export const serializeQueueEntry = (row) => {
  const claim = row.claim ?? row;
  const assessment = row.assessment ?? null;
  const appeal = row.appeal ?? null;
  return {
    id: String(claim._id ?? claim.id ?? ""),
    parcelId: claim.parcelId ?? null,
    parcelName: claim.parcelSnapshot?.name ?? null,
    parcelCrop: claim.parcelSnapshot?.crop ?? null,
    parcelAreaAcres: claim.parcelSnapshot?.parcelAreaAcres ?? null,
    eventType: claim.eventType ?? null,
    eventDate: claim.eventDate ?? null,
    claimedAreaAcres: claim.claimedAreaAcres ?? null,
    state: claim.state ?? null,
    decidedAt: claim.decidedAt ?? null,
    submittedAt: claim.submittedAt ?? null,
    createdAt: claim.createdAt ?? null,
    hasAppeal: Boolean(appeal),
    appealId: appeal ? String(appeal._id) : null,
    appealStatus: appeal?.status ?? null,
    appealReason: appeal?.reason ?? null,
    assessment: assessment
      ? {
          status: assessment.status ?? null,
          aiFailed: (assessment.status ?? assessment.verification?.status ?? "") === "failed",
          aiUncertain: Boolean(assessment.aiAggregate?.uncertain),
          reason: assessment.reason ?? null,
          decidedBy: assessment.decidedBy ?? null,
        }
      : null,
  };
};

export default {
  QUEUE_STATES,
  QUEUE_STATE_SET,
  isQueueState,
  normalizeQueueFilters,
  buildQueueClaimMatch,
  aiFailedExpression,
  buildPostMatch,
  compareQueueRows,
  serializeQueueEntry,
};