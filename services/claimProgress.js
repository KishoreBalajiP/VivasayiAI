import { DECISION_STATES } from "./adminOverrideRules.service.js";
import { groupEvidence, isReviewCase, resolveComponents } from "./verificationComponents.js";
import { blockingStepsFor } from "./verificationJobs.service.js";
import { OWNERSHIP_DOCUMENT_CATEGORIES } from "../utils/ownershipEvidence.js";

// ADR-022 (plan A6) — the farmer progress contract `progress-v1`. PURE: no database, no network, no
// clock except the injected `now`. services/claimProgress.service.js loads the rows; this module only
// turns them into what a farmer may see.
//
// What the farmer sees is derived from PERSISTED state only (claim, assessment, job rows, evidence
// rows). Nothing here is a percentage or a guess: a stage is `active` only while its job is running,
// `waiting` only while a retry is really scheduled, and `nextCheckAt` is only ever a real job runAt.
//
// Never in this model: job ids, attempts, error codes or messages, review-case rows, provider
// names, NDVI values, the policy hash, or anything about another farmer's claim.
//
// Every explanation key names its stage and has exactly ONE status (EXPLANATIONS below), so the
// frontend can translate it without knowing these rules. docs/architecture/progress-contract-v1.json
// is generated from the vocabulary exported here (progressContractDocument) and the PRG-10 suite
// checks that the builder emits exactly that vocabulary.

export const PROGRESS_CONTRACT_VERSION = "progress-v1";

export const OVERALL_STATUSES = Object.freeze(["draft", "in_progress", "waiting_for_review", "action_required", "decided", "withdrawn"]);
export const STAGE_IDS = Object.freeze(["received", "photos", "land_documents", "weather", "area_checks", "decision"]);
export const STAGE_STATUSES = Object.freeze(["pending", "active", "complete", "waiting", "blocked", "not_applicable", "failed_technical"]);

// explanationKey -> stage status, per stage.
const EXPLANATIONS = Object.freeze({
  received: {
    "progress.received.waiting_for_submit": "pending",
    "progress.received.complete": "complete",
    "progress.received.not_submitted": "not_applicable",
  },
  photos: {
    "progress.photos.missing": "blocked",
    "progress.photos.waiting_for_submit": "pending",
    "progress.photos.queued": "pending",
    "progress.photos.checking": "active",
    "progress.photos.retrying_technical": "waiting",
    "progress.photos.technical_issue_reviewer": "failed_technical",
    "progress.photos.complete": "complete",
    "progress.photos.not_checked": "not_applicable",
    "progress.photos.claim_withdrawn": "not_applicable",
  },
  land_documents: {
    "progress.land_documents.none_attached": "not_applicable",
    "progress.land_documents.waiting_for_submit": "pending",
    "progress.land_documents.queued": "pending",
    "progress.land_documents.checking": "active",
    "progress.land_documents.retrying_technical": "waiting",
    "progress.land_documents.technical_issue_reviewer": "failed_technical",
    "progress.land_documents.complete": "complete",
    "progress.land_documents.not_checked": "not_applicable",
    "progress.land_documents.claim_withdrawn": "not_applicable",
  },
  // Weather is supporting evidence only: a weather service that could not answer is a finished
  // step ("unavailable, supporting only"), never a technical failure of the claim.
  weather: {
    "progress.weather.waiting_for_submit": "pending",
    "progress.weather.queued": "pending",
    "progress.weather.checking": "active",
    "progress.weather.retrying_technical": "waiting",
    "progress.weather.complete": "complete",
    "progress.weather.unavailable_supporting_only": "complete",
    "progress.weather.not_checked": "not_applicable",
    "progress.weather.claim_withdrawn": "not_applicable",
  },
  area_checks: {
    "progress.area_checks.waiting_for_submit": "pending",
    "progress.area_checks.queued": "pending",
    "progress.area_checks.checking": "active",
    "progress.area_checks.technical_issue_reviewer": "failed_technical",
    "progress.area_checks.complete": "complete",
    "progress.area_checks.not_checked": "not_applicable",
    "progress.area_checks.claim_withdrawn": "not_applicable",
  },
  decision: {
    "progress.decision.waiting_for_submit": "pending",
    "progress.decision.waiting_for_checks": "pending",
    "progress.decision.deciding": "active",
    // Held (no decision yet, the claim stays `submitted`). D2: an AI-only "no damage" reading is
    // confirmed by a person; a technical failure is retried, then checked by a person.
    "progress.decision.ai_no_damage_review": "waiting",
    "progress.decision.held_retrying_checks": "waiting",
    "progress.decision.technical_issue_reviewer": "waiting",
    "progress.decision.waiting_for_reviewer": "waiting",
    "progress.decision.technical_issue": "failed_technical",
    "progress.decision.needs_more_evidence": "blocked",
    "progress.decision.complete": "complete",
    "progress.decision.claim_withdrawn": "not_applicable",
  },
});

export const ACTION_CODES = Object.freeze(["submit_claim", "add_photos", "upload_land_documents", "resubmit_with_evidence"]);
const ACTION_STAGE = Object.freeze({
  submit_claim: "received",
  add_photos: "photos",
  upload_land_documents: "land_documents",
  resubmit_with_evidence: "decision",
});
const ACTION_PARAMS = Object.freeze({ upload_land_documents: ["categoryGroups"] });

// Satellite is SUPPORTING evidence only (owner decision D1): it never blocks or changes a decision,
// so its status is reported beside the stages, never as one. Each reason code has one status.
export const SATELLITE_STATUSES = Object.freeze(["pending", "processing", "passed", "not_supported", "inconclusive", "unavailable", "failed"]);
const SATELLITE_REASONS = Object.freeze({
  claim_withdrawn: "unavailable",
  checking_imagery: "processing",
  technical_issue: "failed",
  not_enabled: "unavailable",
  waiting_for_post_event_imagery: "pending",
  queued: "pending",
  not_started: "pending",
  area_not_supported: "not_supported",
  analysis_not_enabled: "unavailable",
  provider_unavailable: "unavailable",
  no_imagery_for_window: "inconclusive",
  cloud_cover: "inconclusive",
  not_enough_images: "inconclusive",
  analysis_inconclusive: "inconclusive",
  vegetation_drop_consistent_with_damage: "passed",
  no_clear_vegetation_change: "inconclusive",
});
// Set when an earlier satellite result is still shown but the latest re-check failed (critique D6).
export const SATELLITE_NOTE_CODES = Object.freeze(["latest_check_failed"]);

// Keys that must never appear anywhere in a farmer progress object.
export const FORBIDDEN_FARMER_KEYS = Object.freeze([
  "jobId",
  "attempts",
  "maxAttempts",
  "attemptLog",
  "lastError",
  "leaseOwner",
  "errorCode",
  "errorKind",
  "failedStep",
  "reviewCases",
  "deltaNdvi",
  "provider",
  "policyHash",
  "hash",
  "cognitoSub",
]);

export const explanationStatus = (stageId, key) => (EXPLANATIONS[stageId] ? EXPLANATIONS[stageId][key] || null : null);
export const satelliteReasonStatus = (reasonCode) => SATELLITE_REASONS[reasonCode] || null;

// The machine-readable vocabulary (docs/architecture/progress-contract-v1.json is this, written out).
export const progressContractDocument = () => ({
  contractVersion: PROGRESS_CONTRACT_VERSION,
  $comment:
    "Generated from services/claimProgress.js (progressContractDocument). Every value the progress-v1 builder can emit, and nothing else; the PRG-10 suite checks both directions. Unknown values must get generic copy in a client, never be rendered raw.",
  overallStatuses: [...OVERALL_STATUSES],
  decisionValues: [...DECISION_STATES],
  stageIds: [...STAGE_IDS],
  stageStatuses: [...STAGE_STATUSES],
  stages: Object.fromEntries(
    STAGE_IDS.map((id) => [id, Object.entries(EXPLANATIONS[id]).map(([explanationKey, status]) => ({ status, explanationKey }))])
  ),
  actions: ACTION_CODES.map((code) => ({
    code,
    stage: ACTION_STAGE[code],
    explanationKey: `action.${code}`,
    params: ACTION_PARAMS[code] ? [...ACTION_PARAMS[code]] : [],
  })),
  documentCategories: [...OWNERSHIP_DOCUMENT_CATEGORIES],
  satellite: {
    statuses: [...SATELLITE_STATUSES],
    reasonCodes: Object.entries(SATELLITE_REASONS).map(([reasonCode, status]) => ({ status, reasonCode })),
    noteCodes: [...SATELLITE_NOTE_CODES],
    supportingOnly: true,
  },
  forbiddenFarmerKeys: [...FORBIDDEN_FARMER_KEYS],
});

// ---- helpers ------------------------------------------------------------------------------------

const ACTIVE_JOB = new Set(["queued", "running"]);
const DECISION_STATE_SET = new Set(DECISION_STATES);
const DECISION_INPUT_STEPS = ["ai_assessment", "land_documents", "official_land_record"];

const ms = (value) => {
  if (value === null || value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};
const iso = (value) => {
  const time = ms(value);
  return time === null ? null : new Date(time).toISOString();
};
const plain = (doc) => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc);

// "missing_document_category:land_record|ownership_deed" -> [["land_record", "ownership_deed"]]
// (critique A4). Unknown categories are dropped, so a client only ever sees the fixed vocabulary.
export const parseCategoryGroups = (reasonCodes = []) =>
  (Array.isArray(reasonCodes) ? reasonCodes : [])
    .filter((code) => typeof code === "string" && code.startsWith("missing_document_category:"))
    .map((code) =>
      code
        .slice("missing_document_category:".length)
        .split("|")
        .map((category) => category.trim())
        .filter((category) => OWNERSHIP_DOCUMENT_CATEGORIES.includes(category))
    )
    .filter((group) => group.length > 0);

// The jobs that speak to the CURRENT submission round: every job created since the latest
// (re)submission, plus any job still active (a satellite job from an earlier round can still be
// waiting for its post-event window). A draft has no round yet, so every job counts.
export const currentRoundJobs = (jobs = [], claim = {}) => {
  const roundStart = ms(claim.submittedAt);
  return jobs.map(plain).filter((job) => ACTIVE_JOB.has(job.status) || roundStart === null || (ms(job.createdAt) ?? 0) >= roundStart);
};

// The job that describes a step now: a running one, else a queued one, else the newest.
export const latestJobFor = (jobs, step) => {
  const forStep = jobs.filter((job) => job.step === step);
  if (forStep.length === 0) return null;
  const byNewest = [...forStep].sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0));
  return byNewest.find((job) => job.status === "running") || byNewest.find((job) => job.status === "queued") || byNewest[0];
};

const failedBefore = (job) => Boolean(job && job.lastError && (job.lastError.code || job.lastError.kind));
// Only a real, future runAt is a "next check"; a due job has no time to wait for.
const futureRunAt = (job, nowMs) => (job && job.status === "queued" && (ms(job.runAt) ?? 0) > nowMs ? iso(job.runAt) : null);

const stageOf = (id, explanationKey, { blocking = true, startedAt = null, completedAt = null, nextCheckAt = null, action = null } = {}) => {
  const status = explanationStatus(id, explanationKey);
  if (!status) throw new Error(`progress-v1: ${explanationKey} is not a ${id} explanation`);
  return {
    id,
    status,
    blocking: Boolean(blocking),
    startedAt: iso(startedAt),
    completedAt: status === "complete" || status === "blocked" ? iso(completedAt) : null,
    nextCheckAt: nextCheckAt || null,
    explanationKey,
    actionRequired: action ? { code: action.code, required: Boolean(action.required) } : null,
  };
};

// ---- satellite (truth table; first match wins, the catch-all is `unavailable`, never `passed`) ----

const NOT_SUPPORTED_OUTCOMES = new Set(["INVALID_INPUT", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_PRODUCT", "UNSUPPORTED_PROCESSING"]);
const PROVIDER_ERROR_OUTCOMES = new Set(["AUTH_REQUIRED", "QUOTA_EXCEEDED", "PROVIDER_ERROR", "TIMEOUT", "MALFORMED_RESPONSE"]);
const ANALYSIS_NOT_RUN = new Set(["disabled", "credentials_required", "not_attempted"]);
const INCONCLUSIVE_REASON = Object.freeze({
  IMAGERY_UNAVAILABLE: "no_imagery_for_window",
  CLOUD_OBSCURED: "cloud_cover",
  INSUFFICIENT_TEMPORAL_COVERAGE: "not_enough_images",
  INCONCLUSIVE: "analysis_inconclusive",
});

// What one recorded satellite row means to a farmer. `metadata.outcome` (adapter outcome) is
// recorded since ADR-022; older rows are read from their evidence status alone.
export const satelliteRowDisplay = (row) => {
  const metadata = (row && row.metadata) || {};
  const outcome = metadata.outcome || null;
  const processing = metadata.processingStatus || null;
  const status = row ? row.status : null;
  if (outcome === "CONFIG_DISABLED" || (!outcome && status === "NOT_CHECKED" && !processing)) return "not_enabled";
  if (NOT_SUPPORTED_OUTCOMES.has(outcome)) return "area_not_supported";
  if ((outcome === "IMAGERY_FOUND" || (!outcome && status === "PENDING")) && ANALYSIS_NOT_RUN.has(processing)) return "analysis_not_enabled";
  if (PROVIDER_ERROR_OUTCOMES.has(outcome) || (!outcome && status === "UNAVAILABLE")) return "provider_unavailable";
  if (INCONCLUSIVE_REASON[outcome]) return INCONCLUSIVE_REASON[outcome];
  if (!outcome && status === "INSUFFICIENT") return "analysis_inconclusive";
  if (status === "AVAILABLE" && (!outcome || outcome === "ANALYSIS_COMPLETE")) {
    const analysis = row.result && row.result.analysisOutcome;
    if (analysis === "SUPPORTS_LOSS") return "vegetation_drop_consistent_with_damage";
    // Satellite cannot disprove damage: no visible change is "no clear result", never a failure.
    if (analysis === "NO_CHANGE") return "no_clear_vegetation_change";
    return "analysis_inconclusive";
  }
  return "provider_unavailable";
};

const imageryDatesOf = (row) => {
  const result = row && row.result;
  if (!result || !result.analyzed) return null;
  const dates = (side) => (side && Array.isArray(side.series) ? side.series.map((item) => item && item.date).filter((date) => typeof date === "string") : []);
  return { preEvent: dates(result.before), postEvent: dates(result.after) };
};

const observedWindowsOf = (windows) => {
  if (!windows) return null;
  const open = Boolean(windows.postWindowOpen);
  return {
    preEvent: windows.preWindow ? { start: windows.preWindow.start, end: windows.preWindow.end } : null,
    postEvent: windows.postWindow
      ? {
          start: windows.postWindow.start,
          // Not open yet: there is no end. (The raw window's end is "today", which is before its start.)
          end: open ? windows.postWindow.end : null,
          open,
          complete: Boolean(windows.postWindowComplete),
        }
      : null,
  };
};

export const buildSatelliteDisplay = ({
  claim = {},
  rows = [],
  job = null,
  windows = null,
  satelliteEnabled = true,
  automationEnabled = true,
  now = new Date(),
} = {}) => {
  const nowMs = ms(now);
  const satelliteRows = groupEvidence(rows.map(plain)).satelliteRows; // newest first, review cases excluded
  const row = satelliteRows[0] || null;
  const latestJob = job ? plain(job) : null;
  const display = (reasonCode, extra = {}) => ({
    status: SATELLITE_REASONS[reasonCode],
    reasonCode,
    supportingOnly: true,
    noteCode: null,
    observedWindows: observedWindowsOf(windows),
    imageryDates: row ? imageryDatesOf(row) : null,
    nextCheckAt: null,
    updatedAt: row
      ? iso(row.updatedAt || row.createdAt)
      : latestJob
        ? iso(latestJob.deadAt || latestJob.completedAt || latestJob.startedAt || null)
        : null,
    ...extra,
  });

  if (claim.state === "withdrawn") return display("claim_withdrawn", { nextCheckAt: null });
  if (latestJob && latestJob.status === "running") return display("checking_imagery");
  if (latestJob && latestJob.status === "dead") {
    // An earlier result stays what it was; the failed re-check is noted, never shown as "failed".
    if (row) return display(satelliteRowDisplay(row), { noteCode: "latest_check_failed" });
    return display("technical_issue");
  }
  const next = futureRunAt(latestJob, nowMs);
  if (!row) {
    if (!satelliteEnabled) return display("not_enabled");
    if (claim.state === "draft") return display("not_started");
    const notOpen = windows && !windows.postWindowOpen;
    const skippedForWindow = latestJob && latestJob.resultSummary && latestJob.resultSummary.skipped === "post_window_not_open";
    if (next && (notOpen || skippedForWindow)) return display("waiting_for_post_event_imagery", { nextCheckAt: next });
    if (notOpen) return display("waiting_for_post_event_imagery");
    if (latestJob && latestJob.status === "queued") return display("queued", { nextCheckAt: next });
    if (latestJob && latestJob.resultSummary && latestJob.resultSummary.skipped === "no_geometry") return display("area_not_supported");
    if (!latestJob) return automationEnabled ? display("not_started") : display("not_enabled");
    // A finished job that recorded nothing (or a cancelled one): never "passed".
    return display("provider_unavailable");
  }
  // A recorded result is shown; a queued re-check (post window still growing, or a transient
  // provider failure) only adds when the next look is due.
  return display(satelliteRowDisplay(row), { nextCheckAt: next });
};

// ---- stages ---------------------------------------------------------------------------------------

const assessmentSlotLive = (assessment, nowMs) =>
  Boolean(assessment && assessment.status === "processing" && (ms(assessment.slotLeaseUntil) ?? 0) > nowMs);

const isHeld = (assessment) =>
  Boolean(assessment && !assessment.state && assessment.verification && assessment.verification.status === "held");

const holdReasonCodes = (assessment) =>
  (assessment && assessment.hold && Array.isArray(assessment.hold.blocking) ? assessment.hold.blocking : []).flatMap((item) =>
    Array.isArray(item.reasonCodes) ? item.reasonCodes : item.reasonCode ? [item.reasonCode] : []
  );

const isDocumentRow = (row) => row.source === "OWNERSHIP" && String(row.idempotencyKey || "").startsWith("owndoc_") && !isReviewCase(row);

// A stage reads only the evidence a farmer can still change while the claim is open for it.
const OPEN_FOR_EVIDENCE = new Set(["draft", "submitted", "more_evidence_required"]);

// Meaningful timestamps only (critique D5): when something HAPPENED to the claim, never a lease
// renewal, a put-back or another bookkeeping write. Every value used here only ever moves forward,
// so `lastUpdatedAt` never goes back in time (a client drops a response that looks older).
const meaningfulTimes = ({ claim, assessment, jobs, evidenceRows, photos, latestAuditAt }) => {
  const times = [claim.createdAt, claim.submittedAt, claim.firstSubmittedAt, claim.decidedAt, latestAuditAt];
  if (assessment) {
    times.push(assessment.startedAt, assessment.completedAt, assessment.failedAt, assessment.decidedAt);
    if (assessment.hold) times.push(assessment.hold.since);
    if (assessment.verification) times.push(assessment.verification.completedAt, assessment.verification.failedAt);
  }
  for (const job of jobs) times.push(job.startedAt, job.completedAt, job.deadAt, job.cancelledAt, job.lastError ? job.lastError.at : null);
  for (const row of evidenceRows) times.push(row.createdAt, row.updatedAt);
  if (photos) times.push(photos.latestAt);
  const values = times.map(ms).filter((value) => value !== null);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
};

// The farmer progress object (contract progress-v1). Inputs are plain rows; see
// services/claimProgress.service.js for how they are loaded.
//   photos: { count, version, latestAt } — the claim's stored photos and their evidence version
//   resubmitAllowed: the claim may still be resubmitted (P6 limit)
export const buildFarmerProgress = ({
  claim: rawClaim,
  assessment: rawAssessment = null,
  jobs: rawJobs = [],
  evidenceRows: rawRows = [],
  photos = { count: 0, version: null, latestAt: null },
  policy,
  windows = null,
  satelliteEnabled = true,
  automationEnabled = true,
  resubmitAllowed = true,
  latestAuditAt = null,
  now = new Date(),
} = {}) => {
  const claim = plain(rawClaim);
  const assessment = rawAssessment ? plain(rawAssessment) : null;
  const evidenceRows = rawRows.map(plain);
  const allJobs = rawJobs.map(plain);
  const jobs = currentRoundJobs(allJobs, claim);
  const nowMs = ms(now);
  const state = claim.state;
  const decided = DECISION_STATE_SET.has(state) && state !== "more_evidence_required";
  const photoCount = Number(photos && photos.count) || 0;
  const engineWaits = new Set(blockingStepsFor("engine", policy));

  const job = (step) => latestJobFor(jobs, step);
  const aiJob = job("ai_assessment");
  const landJobs = [job("land_documents"), job("official_land_record")].filter(Boolean);
  const weatherJob = job("weather");
  const engineJob = job("engine");
  const satelliteJob = job("satellite");

  // Actions the farmer can take. The claimant-rights action reuses the component resolver, so the
  // farmer is asked for exactly the categories the decision logic is missing.
  const actions = [];
  const addAction = (code, required, params = {}) => {
    const action = { code, stage: ACTION_STAGE[code], required: Boolean(required), explanationKey: `action.${code}`, params };
    actions.push(action);
    return action;
  };
  const submitAction = state === "draft" ? addAction("submit_claim", true) : null;
  const photoAction = OPEN_FOR_EVIDENCE.has(state) && photoCount === 0 ? addAction("add_photos", true) : null;
  let landAction = null;
  if (OPEN_FOR_EVIDENCE.has(state)) {
    const components = resolveComponents({ claim, assessment, spatial: null, evidenceRows, evidenceCount: photoCount, policy });
    const rights = components.claimant_rights;
    if (rights && rights.actionableBy === "farmer") {
      landAction = addAction("upload_land_documents", rights.required, { categoryGroups: parseCategoryGroups(rights.reasonCodes) });
    }
  }
  const resubmitAction = state === "more_evidence_required" && resubmitAllowed ? addAction("resubmit_with_evidence", true) : null;

  const withdrawn = state === "withdrawn";
  const submittedAt = claim.firstSubmittedAt || claim.submittedAt || null;

  // received
  const received = state === "draft"
    ? stageOf("received", "progress.received.waiting_for_submit", { action: submitAction })
    : withdrawn && !claim.submittedAt
      ? stageOf("received", "progress.received.not_submitted")
      : stageOf("received", "progress.received.complete", { startedAt: submittedAt, completedAt: submittedAt });

  // photos
  const photosStage = (() => {
    const blocking = engineWaits.has("ai_assessment");
    const at = { blocking, startedAt: (aiJob && aiJob.startedAt) || (assessment && assessment.startedAt) || null };
    if (withdrawn) return stageOf("photos", "progress.photos.claim_withdrawn", { blocking: false });
    if (photoCount === 0) {
      return OPEN_FOR_EVIDENCE.has(state)
        ? stageOf("photos", "progress.photos.missing", { blocking, action: photoAction })
        : stageOf("photos", "progress.photos.not_checked", { blocking: false });
    }
    const completedForCurrent = Boolean(assessment && assessment.status === "completed" && photos.version && assessment.evidenceVersion === photos.version);
    const completedAt = (aiJob && aiJob.completedAt) || (assessment && assessment.completedAt) || null;
    if (state === "draft") return stageOf("photos", "progress.photos.waiting_for_submit", { blocking });
    if (aiJob && aiJob.status === "running") return stageOf("photos", "progress.photos.checking", at);
    if (aiJob && aiJob.status === "queued") {
      const retrying = failedBefore(aiJob) || Boolean(assessment && assessment.status === "failed");
      return stageOf("photos", retrying ? "progress.photos.retrying_technical" : "progress.photos.queued", { ...at, nextCheckAt: futureRunAt(aiJob, nowMs) });
    }
    if (assessmentSlotLive(assessment, nowMs)) return stageOf("photos", "progress.photos.checking", at);
    if (completedForCurrent) return stageOf("photos", "progress.photos.complete", { ...at, completedAt });
    if (decided || state === "processing") {
      return assessment && assessment.status === "completed"
        ? stageOf("photos", "progress.photos.complete", { ...at, completedAt })
        : stageOf("photos", "progress.photos.not_checked", { blocking: false });
    }
    // New photos on a claim that needs more evidence are checked once it is resubmitted.
    if (state === "more_evidence_required") return stageOf("photos", "progress.photos.waiting_for_submit", { blocking });
    if ((aiJob && aiJob.status === "dead") || (assessment && assessment.status === "failed")) {
      return stageOf("photos", "progress.photos.technical_issue_reviewer", at);
    }
    return stageOf("photos", "progress.photos.queued", at);
  })();

  // land documents
  const documents = evidenceRows.filter(isDocumentRow);
  const landStage = (() => {
    const blocking = documents.length > 0 && (engineWaits.has("land_documents") || engineWaits.has("official_land_record"));
    if (withdrawn) return stageOf("land_documents", "progress.land_documents.claim_withdrawn", { blocking: false });
    if (documents.length === 0) return stageOf("land_documents", "progress.land_documents.none_attached", { blocking: false, action: landAction });
    const at = { blocking, action: landAction, startedAt: landJobs.map((entry) => entry.startedAt).filter(Boolean).sort()[0] || null };
    const allExamined = documents.every((row) => row.result && row.result.aiLandDocumentExamination);
    const completedAt = landJobs.map((entry) => entry.completedAt).filter(Boolean).sort().pop() || null;
    if (state === "draft") return stageOf("land_documents", "progress.land_documents.waiting_for_submit", { blocking, action: landAction });
    const queued = landJobs.filter((entry) => entry.status === "queued");
    const nextCheckAt = queued.map((entry) => futureRunAt(entry, nowMs)).filter(Boolean).sort()[0] || null;
    if (landJobs.some((entry) => entry.status === "running")) return stageOf("land_documents", "progress.land_documents.checking", at);
    if (landJobs.some((entry) => entry.status === "dead")) return stageOf("land_documents", "progress.land_documents.technical_issue_reviewer", at);
    if (queued.some(failedBefore)) return stageOf("land_documents", "progress.land_documents.retrying_technical", { ...at, nextCheckAt });
    if (queued.length > 0) return stageOf("land_documents", "progress.land_documents.queued", { ...at, nextCheckAt });
    const landJob = job("land_documents");
    if (allExamined || (landJob && landJob.status === "succeeded")) return stageOf("land_documents", "progress.land_documents.complete", { ...at, completedAt });
    if (decided || state === "processing") return stageOf("land_documents", "progress.land_documents.not_checked", { blocking: false });
    if (state === "more_evidence_required") return stageOf("land_documents", "progress.land_documents.waiting_for_submit", { blocking, action: landAction });
    return stageOf("land_documents", "progress.land_documents.queued", at);
  })();

  // weather (supporting only)
  const weatherRow = groupEvidence(evidenceRows).weatherRows[0] || null;
  const weatherStage = (() => {
    const blocking = engineWaits.has("weather");
    if (withdrawn) return stageOf("weather", "progress.weather.claim_withdrawn", { blocking: false });
    if (state === "draft") return stageOf("weather", "progress.weather.waiting_for_submit", { blocking });
    const at = { blocking, startedAt: (weatherJob && weatherJob.startedAt) || null };
    const completedAt = (weatherJob && weatherJob.completedAt) || (weatherRow && weatherRow.createdAt) || null;
    if (weatherJob && weatherJob.status === "running") return stageOf("weather", "progress.weather.checking", at);
    if (weatherJob && weatherJob.status === "queued") {
      return stageOf("weather", failedBefore(weatherJob) ? "progress.weather.retrying_technical" : "progress.weather.queued", { ...at, nextCheckAt: futureRunAt(weatherJob, nowMs) });
    }
    if (weatherRow) {
      const unavailable = weatherRow.status === "UNAVAILABLE" || weatherRow.status === "NOT_CHECKED";
      return stageOf("weather", unavailable ? "progress.weather.unavailable_supporting_only" : "progress.weather.complete", { ...at, completedAt });
    }
    if (weatherJob && (weatherJob.status === "dead" || weatherJob.status === "succeeded")) {
      return stageOf("weather", "progress.weather.unavailable_supporting_only", { ...at, completedAt: weatherJob.completedAt || weatherJob.deadAt });
    }
    if (decided || state === "processing" || state === "more_evidence_required") return stageOf("weather", "progress.weather.not_checked", { blocking: false });
    return stageOf("weather", "progress.weather.queued", at);
  })();

  // area checks (inside the parcel, area limits, overlaps): computed by the engine
  const held = state === "submitted" && isHeld(assessment);
  const evaluated = Boolean(assessment && (assessment.components || assessment.rules));
  const areaStage = (() => {
    const at = { startedAt: (engineJob && engineJob.startedAt) || null };
    const completedAt = (assessment && (assessment.decidedAt || (assessment.hold && assessment.hold.since))) || claim.decidedAt || null;
    if (withdrawn) return stageOf("area_checks", "progress.area_checks.claim_withdrawn", { blocking: false });
    if (state === "draft") return stageOf("area_checks", "progress.area_checks.waiting_for_submit");
    if (state === "processing" || (engineJob && engineJob.status === "running")) return stageOf("area_checks", "progress.area_checks.checking", at);
    if (DECISION_STATE_SET.has(state)) {
      return evaluated ? stageOf("area_checks", "progress.area_checks.complete", { ...at, completedAt }) : stageOf("area_checks", "progress.area_checks.not_checked", { blocking: false });
    }
    if (held && evaluated) return stageOf("area_checks", "progress.area_checks.complete", { ...at, completedAt });
    if (engineJob && engineJob.status === "dead") return stageOf("area_checks", "progress.area_checks.technical_issue_reviewer", at);
    return stageOf("area_checks", "progress.area_checks.queued", at);
  })();

  // decision
  const decisionStage = (() => {
    const decidedAt = claim.decidedAt || (assessment && assessment.decidedAt) || null;
    const at = { startedAt: (engineJob && engineJob.startedAt) || null };
    if (withdrawn) return stageOf("decision", "progress.decision.claim_withdrawn", { blocking: false });
    if (state === "draft") return stageOf("decision", "progress.decision.waiting_for_submit");
    if (state === "more_evidence_required") {
      return stageOf("decision", "progress.decision.needs_more_evidence", { ...at, completedAt: decidedAt, action: resubmitAction });
    }
    if (decided) return stageOf("decision", "progress.decision.complete", { ...at, completedAt: decidedAt });
    if (state === "processing") return stageOf("decision", "progress.decision.deciding", at);
    if (held) {
      const reasons = holdReasonCodes(assessment);
      if (reasons.includes("ai_no_damage_needs_review")) return stageOf("decision", "progress.decision.ai_no_damage_review", at);
      const retrying = DECISION_INPUT_STEPS.some((step) => {
        const entry = job(step);
        return entry && ACTIVE_JOB.has(entry.status);
      });
      if (retrying) return stageOf("decision", "progress.decision.held_retrying_checks", at);
      if (reasons.some((code) => code.startsWith("ai_assessment_unavailable") || code === "ai_assessment_failed")) {
        return stageOf("decision", "progress.decision.technical_issue_reviewer", at);
      }
      return stageOf("decision", "progress.decision.waiting_for_reviewer", at);
    }
    if (engineJob && engineJob.status === "dead") return stageOf("decision", "progress.decision.technical_issue", at);
    if (engineJob && engineJob.status === "running") return stageOf("decision", "progress.decision.deciding", at);
    return stageOf("decision", "progress.decision.waiting_for_checks", at);
  })();

  const stages = [received, photosStage, landStage, weatherStage, areaStage, decisionStage];

  const REVIEW_KEYS = new Set([
    "progress.decision.ai_no_damage_review",
    "progress.decision.technical_issue_reviewer",
    "progress.decision.waiting_for_reviewer",
  ]);
  const overallStatus = (() => {
    if (state === "draft") return "draft";
    if (withdrawn) return "withdrawn";
    if (state === "more_evidence_required") return "action_required";
    if (decided) return "decided";
    if (state === "processing") return "in_progress";
    if (stages.some((stage) => stage.blocking && stage.status === "blocked")) return "action_required";
    if (REVIEW_KEYS.has(decisionStage.explanationKey) || decisionStage.status === "failed_technical") return "waiting_for_review";
    return "in_progress";
  })();

  const nextCheckAt =
    stages
      .filter((stage) => stage.blocking && stage.nextCheckAt)
      .map((stage) => stage.nextCheckAt)
      .sort()[0] || null;

  return {
    contractVersion: PROGRESS_CONTRACT_VERSION,
    claimId: String(claim._id),
    claimState: state,
    overallStatus,
    // A decision state (including more_evidence_required) is the decision; anything else is none yet.
    decision: DECISION_STATE_SET.has(state) ? state : null,
    policyId: (assessment && assessment.policy && assessment.policy.id) || (policy && policy.id) || null,
    submittedAt: iso(claim.submittedAt),
    lastUpdatedAt: meaningfulTimes({ claim, assessment, jobs, evidenceRows, photos, latestAuditAt }),
    nextCheckAt,
    stages,
    satellite: buildSatelliteDisplay({ claim, rows: evidenceRows, job: satelliteJob, windows, satelliteEnabled, automationEnabled, now }),
    actionRequired: actions,
  };
};

export default {
  PROGRESS_CONTRACT_VERSION,
  buildFarmerProgress,
  buildSatelliteDisplay,
  satelliteRowDisplay,
  parseCategoryGroups,
  progressContractDocument,
};
