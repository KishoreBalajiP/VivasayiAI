import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Progress contract scenarios (plan A6, PRG-10). Pure inputs for services/claimProgress.js
// buildFarmerProgress: one per situation a claim can be in, chosen so that together they reach EVERY
// value of the progress-v1 vocabulary (each stage x status x explanation key, every action, every
// satellite status and reason code, every overall status). tests/progressContract.unit.test.js checks
// that, and that the two generated documents below are current:
//
//   docs/architecture/progress-contract-v1.json   the machine-readable vocabulary
//   docs/architecture/progress-v1.example.json    the builder's output for every scenario (the
//                                                 frontend's fixture; never edited by hand)
//
// Regenerate both after a deliberate change to the builder or its vocabulary:
//   VIVASAYI_SKIP_DOTENV=1 node tests/fixtures/progressScenarios.js --write
//
// Imports are dynamic so this file can set a hermetic environment before config/env.js loads when it
// runs as a script (no database, network or provider is touched either way).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONTRACT_PATH = join(ROOT, "docs", "architecture", "progress-contract-v1.json");
export const EXAMPLE_PATH = join(ROOT, "docs", "architecture", "progress-v1.example.json");

export const NOW = new Date("2026-10-16T09:05:00.000Z");
const at = (iso) => new Date(iso);
const CLAIM_ID = "6710c0ffee0000000000abcd";
const EVENT_3_DAYS_AGO = at("2026-10-13T00:00:00.000Z");
const EVENT_TODAY = at("2026-10-16T00:00:00.000Z");
const SUBMITTED = at("2026-10-16T09:00:00.000Z");
const CREATED = at("2026-10-16T08:50:00.000Z");
const T = (seconds) => new Date(SUBMITTED.getTime() + seconds * 1000);

const claimOf = (over = {}) => ({
  _id: CLAIM_ID,
  state: "submitted",
  eventType: "flood",
  eventDate: EVENT_3_DAYS_AGO,
  submittedAt: SUBMITTED,
  firstSubmittedAt: SUBMITTED,
  decidedAt: null,
  createdAt: CREATED,
  claimantRelationship: "owner",
  parcelId: "parcel-1",
  parcelSnapshot: { parcelId: "parcel-1", name: "Field", crop: "Paddy", parcelAreaAcres: 1 },
  ...over,
});

let jobSeq = 0;
const job = (step, status, over = {}) => ({
  _id: `job${(++jobSeq).toString().padStart(4, "0")}`,
  step,
  status,
  attempts: status === "queued" ? 0 : 1,
  runAt: T(1),
  createdAt: T(1),
  startedAt: status === "queued" ? null : T(5),
  completedAt: status === "succeeded" ? T(9) : null,
  deadAt: status === "dead" ? T(60) : null,
  lastError: status === "dead" ? { code: "PROVIDER_QUOTA", kind: "quota", retryable: true, at: T(60) } : { code: null, kind: null, at: null },
  ...over,
});
const retrying = (step, runAt = at("2026-10-16T09:10:00.000Z")) =>
  job(step, "queued", { attempts: 1, runAt, startedAt: T(5), lastError: { code: "PROVIDER_QUOTA", kind: "quota", retryable: true, at: T(7) } });

const PHOTOS = { count: 2, version: "photos-v1", latestAt: at("2026-10-16T08:55:00.000Z") };
const NO_PHOTOS = { count: 0, version: null, latestAt: null };

const completedAssessment = (over = {}) => ({
  status: "completed",
  evidenceVersion: "photos-v1",
  startedAt: T(5),
  completedAt: T(9),
  policy: { id: "v1.1-safe-ai", hash: "not-shown-to-farmers" },
  verification: { status: "pending" },
  ...over,
});
const heldWith = (blocking, over = {}) =>
  completedAssessment({
    state: null,
    components: { geometry: { outcome: "verified" }, overlap: { outcome: "verified" } },
    hold: { since: T(20), lastEvaluatedAt: T(20), blocking },
    verification: { status: "held" },
    ...over,
  });

const documentRow = (over = {}) => ({
  _id: "doc1",
  source: "OWNERSHIP",
  status: "PENDING",
  idempotencyKey: "owndoc_doc1",
  createdAt: at("2026-10-16T08:58:00.000Z"),
  metadata: { documentCategory: "land_record" },
  result: null,
  ...over,
});
const examinedDocument = () => documentRow({ result: { aiLandDocumentExamination: { reviewRequired: false } } });
const weatherRow = (status) => ({ _id: `wx-${status}`, source: "WEATHER", status, idempotencyKey: `wx_${status}`, createdAt: T(9), metadata: {}, result: null });
const satelliteRow = (status, metadata = {}, result = null) => ({
  _id: `sat-${status}-${metadata.outcome || "legacy"}`,
  source: "SATELLITE",
  status,
  idempotencyKey: `sat2_${status}`,
  createdAt: T(12),
  metadata,
  result,
});
const analysed = (analysisOutcome) => ({
  analyzed: true,
  analysisOutcome,
  deltaNdvi: analysisOutcome === "SUPPORTS_LOSS" ? -0.3 : -0.02,
  before: { series: [{ date: "2026-09-20", ndvi: 0.71 }] },
  after: { series: [{ date: "2026-10-15", ndvi: 0.41 }] },
});
// A dead satellite job's review case would be labelled SATELLITE; it is never read as satellite data.
const satelliteReviewCase = () => ({
  _id: "rv-sat",
  source: "SATELLITE",
  status: "PENDING",
  idempotencyKey: "rv_x_SATELLITE_abc",
  createdAt: T(70),
  metadata: { kind: "review_case", reviewRequired: true, failedStep: "satellite", errorCode: "PROVIDER_QUOTA" },
  result: { reviewReasons: ["automated_step_failed_satellite"] },
});

// name -> { description, input (buildFarmerProgress arguments other than policy/windows/now) }
export const PROGRESS_SCENARIOS = Object.freeze({
  draft_no_photos: {
    description: "Draft claim without photos or land documents.",
    input: { claim: claimOf({ state: "draft", submittedAt: null, firstSubmittedAt: null, claimantRelationship: null }), photos: NO_PHOTOS },
  },
  draft_ready: {
    description: "Draft with photos and a land document, not submitted yet.",
    input: { claim: claimOf({ state: "draft", submittedAt: null, firstSubmittedAt: null }), photos: PHOTOS, evidenceRows: [documentRow()] },
  },
  submitted_fresh: {
    description: "Just submitted: every planned check is queued.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      jobs: [job("ai_assessment", "queued"), job("satellite", "queued"), job("weather", "queued"), job("engine", "queued")],
    },
  },
  checks_running: {
    description: "Photo, land-document, weather and satellite checks running.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      evidenceRows: [documentRow()],
      jobs: [job("ai_assessment", "running"), job("land_documents", "running"), job("official_land_record", "queued"), job("weather", "running"), job("satellite", "running"), job("engine", "queued")],
    },
  },
  retrying_event_today: {
    description: "Event today: provider retries scheduled and the post-event satellite window not open yet.",
    input: {
      claim: claimOf({ eventDate: EVENT_TODAY }),
      photos: PHOTOS,
      evidenceRows: [documentRow()],
      jobs: [
        retrying("ai_assessment"),
        retrying("land_documents", at("2026-10-16T09:20:00.000Z")),
        job("official_land_record", "queued"),
        retrying("weather", at("2026-10-16T09:15:00.000Z")),
        job("satellite", "queued", { runAt: at("2026-10-18T00:00:00.000Z"), rescheduleCount: 1, resultSummary: { skipped: "post_window_not_open" } }),
        job("engine", "queued"),
      ],
    },
  },
  land_documents_queued: {
    description: "A land document waiting for its first examination.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: completedAssessment(),
      evidenceRows: [documentRow(), weatherRow("AVAILABLE")],
      jobs: [job("ai_assessment", "succeeded"), job("land_documents", "queued"), job("official_land_record", "queued"), job("weather", "succeeded"), job("engine", "queued")],
    },
  },
  held_ai_no_damage: {
    description: "AI reads no damage: held for a reviewer (policy v1.1), never rejected.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: heldWith([{ component: "photos", outcome: "requires_review", action: "hold", reasonCodes: ["ai_no_damage_needs_review"] }]),
      evidenceRows: [
        examinedDocument(),
        weatherRow("AVAILABLE"),
        satelliteRow("AVAILABLE", { outcome: "ANALYSIS_COMPLETE", processingStatus: "executed", analysisExecuted: true }, analysed("SUPPORTS_LOSS")),
      ],
      jobs: [job("ai_assessment", "succeeded"), job("land_documents", "succeeded"), job("official_land_record", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "succeeded")],
    },
  },
  held_technical_retrying: {
    description: "The photo check failed for a technical reason: held while the retry is scheduled.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: heldWith(
        [{ component: "photos", outcome: "unavailable", action: "hold", reasonCodes: ["ai_assessment_unavailable", "provider_quota"] }],
        { status: "failed", completedAt: null, failedAt: T(10) }
      ),
      evidenceRows: [weatherRow("AVAILABLE"), satelliteRow("UNAVAILABLE", { outcome: "QUOTA_EXCEEDED", processingStatus: "failed" })],
      jobs: [
        job("ai_assessment", "queued", { runAt: at("2026-10-16T09:06:00.000Z") }),
        job("weather", "succeeded"),
        job("satellite", "queued", { runAt: at("2026-10-16T10:00:12.000Z"), rescheduleCount: 1 }),
        job("engine", "succeeded"),
      ],
    },
  },
  held_technical_reviewer: {
    description: "The photo check kept failing: its job died and a reviewer will check the claim.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: heldWith(
        [{ component: "photos", outcome: "unavailable", action: "hold", reasonCodes: ["ai_assessment_unavailable", "provider_quota"] }],
        { status: "failed", completedAt: null, failedAt: T(50) }
      ),
      evidenceRows: [satelliteReviewCase()],
      jobs: [job("ai_assessment", "dead"), job("weather", "dead"), job("satellite", "dead"), job("engine", "succeeded")],
    },
  },
  held_waiting_for_reviewer: {
    description: "Held until a reviewer looks at the land document (a required component, policy v2).",
    policyId: "v2-components",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: heldWith([{ component: "claimant_rights", outcome: "pending", action: "hold", reasonCodes: ["document_awaiting_manual_review"] }], {
        policy: { id: "v2-components", hash: "not-shown-to-farmers" },
      }),
      evidenceRows: [documentRow(), weatherRow("AVAILABLE"), satelliteRow("PENDING", { outcome: "IMAGERY_FOUND", processingStatus: "disabled" })],
      jobs: [
        job("ai_assessment", "succeeded"),
        job("land_documents", "dead"),
        job("official_land_record", "succeeded"),
        job("weather", "succeeded"),
        job("satellite", "dead", { createdAt: T(30) }),
        job("engine", "succeeded"),
      ],
    },
  },
  engine_dead: {
    description: "The decision step itself kept failing (a reviewer is notified).",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: completedAssessment(),
      evidenceRows: [weatherRow("AVAILABLE"), satelliteRow("INSUFFICIENT", { outcome: "CLOUD_OBSCURED", processingStatus: null })],
      jobs: [job("ai_assessment", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "dead")],
    },
  },
  deciding: {
    description: "The engine holds the claim's decision lock (state processing).",
    input: {
      claim: claimOf({ state: "processing" }),
      photos: PHOTOS,
      assessment: completedAssessment(),
      evidenceRows: [weatherRow("AVAILABLE"), satelliteRow("INSUFFICIENT", { outcome: "INSUFFICIENT_TEMPORAL_COVERAGE" })],
      jobs: [job("ai_assessment", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "running")],
    },
  },
  engine_running: {
    description: "The engine step is running on a submitted claim.",
    input: {
      claim: claimOf(),
      photos: PHOTOS,
      assessment: completedAssessment(),
      evidenceRows: [weatherRow("AVAILABLE"), satelliteRow("INSUFFICIENT", { outcome: "INCONCLUSIVE", processingStatus: "inconclusive" })],
      jobs: [job("ai_assessment", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "running")],
    },
  },
  more_evidence_required: {
    description: "The engine asked for more evidence; a new photo was added and the claim can be resubmitted.",
    input: {
      claim: claimOf({ state: "more_evidence_required", decidedAt: T(30), claimantRelationship: "tenant" }),
      photos: { count: 3, version: "photos-v2", latestAt: T(40) },
      assessment: completedAssessment({ state: "more_evidence_required", decidedAt: T(30), components: {}, rules: {} }),
      evidenceRows: [
        weatherRow("AVAILABLE"),
        satelliteRow("AVAILABLE", { outcome: "ANALYSIS_COMPLETE", processingStatus: "executed", analysisExecuted: true }, analysed("NO_CHANGE")),
      ],
      jobs: [job("ai_assessment", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "succeeded")],
    },
  },
  more_evidence_no_photos_limit_reached: {
    description: "More evidence needed, no photos at all, and the resubmission limit already reached.",
    input: {
      claim: claimOf({ state: "more_evidence_required", decidedAt: T(30) }),
      photos: NO_PHOTOS,
      assessment: { state: "more_evidence_required", decidedAt: T(30), components: {}, rules: {}, verification: { status: "completed" } },
      evidenceRows: [examinedDocument(), weatherRow("AVAILABLE"), satelliteRow("UNAVAILABLE", { outcome: "IMAGERY_UNAVAILABLE" })],
      jobs: [job("land_documents", "succeeded"), job("official_land_record", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "succeeded")],
      resubmitAllowed: false,
    },
  },
  submitted_without_photos: {
    description: "Submitted without photos (satellite switched off in this environment).",
    input: { claim: claimOf(), photos: NO_PHOTOS, jobs: [job("weather", "queued"), job("engine", "queued")], satelliteEnabled: false },
  },
  decided_verified: {
    description: "Decided verified; weather was unavailable (supporting only).",
    input: {
      claim: claimOf({ state: "verified", decidedAt: T(40) }),
      photos: PHOTOS,
      assessment: completedAssessment({ state: "verified", decidedAt: T(40), components: { geometry: {}, overlap: {} }, rules: {}, verification: { status: "completed", completedAt: T(40) } }),
      evidenceRows: [examinedDocument(), weatherRow("UNAVAILABLE"), satelliteRow("NOT_CHECKED", { outcome: "INVALID_INPUT" })],
      jobs: [job("ai_assessment", "succeeded"), job("land_documents", "succeeded"), job("official_land_record", "succeeded"), job("weather", "succeeded"), job("satellite", "succeeded"), job("engine", "succeeded")],
    },
  },
  decided_by_reviewer: {
    description: "A reviewer decided the claim before the automated checks completed.",
    input: {
      claim: claimOf({ state: "rejected", decidedAt: T(40) }),
      photos: PHOTOS,
      assessment: { status: "failed", failedAt: T(10), state: "rejected", decidedAt: T(40), decidedBy: "admin", verification: { status: "completed" } },
      evidenceRows: [documentRow(), satelliteRow("NOT_CHECKED", { outcome: "CONFIG_DISABLED" })],
      jobs: [job("ai_assessment", "cancelled"), job("land_documents", "cancelled"), job("official_land_record", "cancelled"), job("engine", "cancelled")],
    },
  },
  withdrawn_after_submit: {
    description: "Withdrawn by the farmer after submitting.",
    input: {
      claim: claimOf({ state: "withdrawn" }),
      photos: PHOTOS,
      evidenceRows: [documentRow()],
      jobs: [job("ai_assessment", "cancelled"), job("weather", "succeeded"), job("satellite", "cancelled"), job("engine", "cancelled")],
    },
  },
  withdrawn_draft: {
    description: "Withdrawn before it was ever submitted.",
    input: { claim: claimOf({ state: "withdrawn", submittedAt: null, firstSubmittedAt: null }), photos: NO_PHOTOS },
  },
});

// The response example the frontend parses first (GET /claims/:id/progress).
export const RESPONSE_EXAMPLE = "retrying_event_today";

const modules = async () => {
  const [{ buildFarmerProgress, progressContractDocument }, { resolvePolicy }, { buildClaimWindows }] = await Promise.all([
    import("../../services/claimProgress.js"),
    import("../../config/verificationPolicy.js"),
    import("../../services/satelliteVerification.service.js"),
  ]);
  return { buildFarmerProgress, progressContractDocument, resolvePolicy, buildClaimWindows };
};

export const buildScenarioProgress = async (name) => {
  const scenario = PROGRESS_SCENARIOS[name];
  if (!scenario) throw new Error(`unknown progress scenario ${name}`);
  const { buildFarmerProgress, resolvePolicy, buildClaimWindows } = await modules();
  const policy = resolvePolicy(scenario.policyId || "v1.1-safe-ai");
  const { input } = scenario;
  return buildFarmerProgress({
    jobs: [],
    evidenceRows: [],
    assessment: null,
    satelliteEnabled: true,
    automationEnabled: true,
    resubmitAllowed: true,
    latestAuditAt: null,
    ...input,
    policy,
    windows: buildClaimWindows({ eventDate: input.claim.eventDate, policy, now: NOW }),
    now: NOW,
  });
};

export const buildAllScenarioProgress = async () => {
  const out = {};
  for (const name of Object.keys(PROGRESS_SCENARIOS)) out[name] = await buildScenarioProgress(name);
  return out;
};

export const contractDocument = async () => (await modules()).progressContractDocument();

export const exampleDocument = async () => {
  const all = await buildAllScenarioProgress();
  return {
    $comment:
      "Generated by tests/fixtures/progressScenarios.js from services/claimProgress.js (buildFarmerProgress); never edit by hand. `response` is a GET /claims/:id/progress body; `examples` holds the builder output for every scenario (fixed clock `now`). Vocabulary: docs/architecture/progress-contract-v1.json.",
    contractVersion: "progress-v1",
    now: NOW.toISOString(),
    response: { statusCode: 200, message: "Claim progress fetched", data: { progress: all[RESPONSE_EXAMPLE] } },
    examples: Object.fromEntries(Object.entries(PROGRESS_SCENARIOS).map(([name, scenario]) => [name, { description: scenario.description, progress: all[name] }])),
  };
};

export const writeGeneratedDocuments = async () => {
  writeFileSync(CONTRACT_PATH, `${JSON.stringify(await contractDocument(), null, 2)}\n`);
  writeFileSync(EXAMPLE_PATH, `${JSON.stringify(await exampleDocument(), null, 2)}\n`);
  return [CONTRACT_PATH, EXAMPLE_PATH];
};

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (!process.argv.includes("--write")) {
    console.error("Usage: VIVASAYI_SKIP_DOTENV=1 node tests/fixtures/progressScenarios.js --write");
    process.exit(64);
  }
  // Hermetic: no .env, placeholder AI settings (the services validate them at import), no database.
  process.env.VIVASAYI_SKIP_DOTENV = "1";
  for (const key of ["GOOGLE_API_KEY", "CHROMA_API_KEY", "CHROMA_TENANT", "CHROMA_DATABASE"]) process.env[key] = process.env[key] || "placeholder";
  process.env.LOG_LEVEL = "silent";
  const written = await writeGeneratedDocuments();
  console.log(written.map((path) => path.slice(ROOT.length + 1)).join("\n"));
  process.exit(0);
}
