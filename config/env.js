import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, "..", ".env");

// VIVASAYI_SKIP_DOTENV=1 keeps the developer's .env out of a process entirely. Hermetic harnesses
// (e2e backend, golden-fixture capture) set it so a key that exists in .env but not in their own
// environment can never route them to a live provider.
const skipDotenv = process.env.VIVASAYI_SKIP_DOTENV === "1";
if (!skipDotenv) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.warn("dotenv: no .env loaded from", envPath, "— continuing (maybe using real env vars)");
  }
}

function cleanSecret(raw) {
  if (raw === undefined || raw === null) return undefined;
  let s = typeof raw === "string" ? raw : String(raw);
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
  return s;
}

// Verification policy used when CLAIM_VERIFICATION_POLICY is not set (config/verificationPolicy.js).
// "v1.1-safe-ai" since 2026-10-16 (ADR-022, owner decision D2): an AI-only "no damage" reading and
// technical failures hold the claim for a person instead of producing an adverse decision. Set
// CLAIM_VERIFICATION_POLICY=v1-legacy to replay the historical behaviour.
export const DEFAULT_CLAIM_VERIFICATION_POLICY = "v1.1-safe-ai";

// Per-user claim rate limits when the environment does not set them (owner decision D5, ADR-022).
// A normal claim is 1 create + 1 submit (+ up to 2 resubmits) claim writes and, for 10 photos and a
// few land documents, about 25 evidence calls; the old 5/h and 20/h blocked a single normal claim.
// Reads keep their own large bucket so status polling never touches the write budget.
export const RATE_LIMIT_DEFAULTS = Object.freeze({ claimWrites: 15, evidence: 60, reads: 600 });

export const SERVER_REQUIRED = [
  "MONGO_URI",
  "GOOGLE_API_KEY",
  "CHROMA_API_KEY",
  "CHROMA_TENANT",
  "CHROMA_DATABASE",
  "SESSION_JWT_SECRET",
];

export const CHAT_REQUIRED = [
  "GOOGLE_API_KEY",
  "CHROMA_API_KEY",
  "CHROMA_TENANT",
  "CHROMA_DATABASE",
];

export const INGEST_REQUIRED = [
  "MY_AWS_ACCESS_KEY_ID",
  "MY_AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET",
  "COHERE_API_KEY",
  "CHROMA_API_KEY",
  "CHROMA_TENANT",
  "CHROMA_DATABASE",
];

// E3 (D-22 Option 1 / D-23): storage credentials for image uploads. Validated lazily by
// services/s3.service.js on first real use — the server still boots (and text chat still
// works) when E3 storage is not yet provisioned.
export const S3_REQUIRED = [
  "MY_AWS_REGION",
  "MY_AWS_ACCESS_KEY_ID",
  "MY_AWS_SECRET_ACCESS_KEY",
  "S3_BUCKET",
];

export const env = Object.freeze({
  port: Number(process.env.PORT) || 8000,
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  authRateLimitWindowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 60000,
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  chatRateLimitWindowMs: Number(process.env.CHAT_RATE_LIMIT_WINDOW_MS) || 60000,
  chatRateLimitMax: Number(process.env.CHAT_RATE_LIMIT_MAX) || 30,
  chatDailyRateLimitWindowMs: Number(process.env.CHAT_DAILY_RATE_LIMIT_WINDOW_MS) || 86400000,
  chatDailyRateLimitMax: Number(process.env.CHAT_DAILY_RATE_LIMIT_MAX) || 300,
  sessionMutationRateLimitWindowMs: Number(process.env.SESSION_MUTATION_RATE_LIMIT_WINDOW_MS) || 60000,
  sessionMutationRateLimitMax: Number(process.env.SESSION_MUTATION_RATE_LIMIT_MAX) || 30,
  messageMaxLength: Number(process.env.MESSAGE_MAX_LENGTH) || 2000,
  // F-49 (ADR-019 — Agricultural Loss / Affected-Area Claim, Phase 2): claim window + claim
  // and evidence rate limits (15_Security §5), evidence image cap (P9), geometry tolerance
  // (P5) and resubmission limits/cooldown (P6) — server-authoritative, keyed to .env.example.
  claimWindowDays: Number(process.env.CLAIM_WINDOW_DAYS) || 30,
  claimRateLimitWindowMs: Number(process.env.CLAIM_RATE_LIMIT_WINDOW_MS) || 3600000,
  claimRateLimitMax: Number(process.env.CLAIM_RATE_LIMIT_MAX) || RATE_LIMIT_DEFAULTS.claimWrites,
  // Reads (GET claim/verification/appeal) have their own bucket so polling can never exhaust the
  // strict write budget above. 600/hour allows a status poll about every 6 seconds.
  claimReadRateLimitWindowMs: Number(process.env.CLAIM_READ_RATE_LIMIT_WINDOW_MS) || 3600000,
  claimReadRateLimitMax: Number(process.env.CLAIM_READ_RATE_LIMIT_MAX) || RATE_LIMIT_DEFAULTS.reads,
  evidenceRateLimitWindowMs: Number(process.env.EVIDENCE_RATE_LIMIT_WINDOW_MS) || 3600000,
  evidenceRateLimitMax: Number(process.env.EVIDENCE_RATE_LIMIT_MAX) || RATE_LIMIT_DEFAULTS.evidence,
  claimEvidenceMaxImages: Number(process.env.CLAIM_EVIDENCE_MAX_IMAGES) || 10,
  claimOverlapToleranceM: Number(process.env.CLAIM_OVERLAP_TOLERANCE_M) || 1.0,
  claimAreaOverageFraction: Number(process.env.CLAIM_AREA_OVERAGE_FRACTION) || 0.05,
  claimMaxResubmissions: Number(process.env.CLAIM_MAX_RESUBMISSIONS) || 2,
  claimResubmitCooldownMs: Number(process.env.CLAIM_RESUBMIT_COOLDOWN_MS) || 86400000,
  // Phase 10 (E9-S10) — admin operations. Admin endpoints are rate-limited per admin identity
  // (15_Security §5). `adminOverrideApproverAcreThreshold` optionally requires a SECOND admin
  // approval for overrides affecting more than the configured acreage (0 = disabled).
  adminRateLimitWindowMs: Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS) || 60000,
  adminRateLimitMax: Number(process.env.ADMIN_RATE_LIMIT_MAX) || 120,
  adminOverrideApproverAcreThreshold: Number(process.env.ADMIN_OVERRIDE_APPROVER_ACRE_THRESHOLD) || 0,
  // E3-S1 (D-22 Option 1): multipart image upload — per-user rate limit and in-memory size cap.
  uploadRateLimitWindowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS) || 60000,
  uploadRateLimitMax: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 10,
  imageUploadMaxBytes: Number(process.env.IMAGE_UPLOAD_MAX_BYTES) || 5 * 1024 * 1024,
  // E3 (D-22 Option 1): normalization bound — the stored image's longest edge is capped at
  // this (configurable default pending product tuning; never enlarges).
  imageMaxDimension: Number(process.env.IMAGE_MAX_DIMENSION) || 2048,
  // E3: object-key namespace inside S3_BUCKET for farmer uploads (kept separate from the
  // dataset/ingestion keys so ingestion scripts never pick up uploads).
  uploadStoragePrefix: process.env.UPLOAD_STORAGE_PREFIX || "uploads",
  // E3: short-lived presigned GET URL lifetime for authorized chat-image retrieval
  // (GET /upload/:uploadId/view). Seconds; intentionally short so a leaked URL grants
  // bounded access. Never persisted — minted on demand per history reconstruction.
  imageViewUrlTtlSeconds: Number(process.env.IMAGE_VIEW_URL_TTL_SECONDS) || 300,
  // E3 dev/test-only seams (documented in .env.example; server-side config, never client-
  // controlled): "mock" swaps S3/AI for deterministic in-memory/fake implementations.
  imageStorageMode: process.env.IMAGE_STORAGE_MODE || "live",
  imageAiMode: process.env.IMAGE_AI_MODE || "live",
  // ADR-024 (plan A8) dev/e2e-only seams. None of them can be active in production: index.js and
  // scripts/worker.js call assertProductionSafety() at boot, which refuses every one of them when
  // NODE_ENV=production or on Lambda.
  //   IMAGE_STORAGE_MOCK_DIR    the mock bucket lives in files under this directory instead of
  //                             process memory, so a separate worker process sees the API's uploads.
  //   DEV_STORAGE_RECEIVER      "true" mounts /__dev/storage (routes/devStorage.js): a signed PUT/GET
  //                             stand-in for S3 presigned URLs (see isDevStorageReceiverEnabled()).
  //   DEV_STORAGE_PUBLIC_BASE_URL  the origin the browser reaches the receiver at (the API itself).
  imageStorageMockDir: process.env.IMAGE_STORAGE_MOCK_DIR || null,
  devStorageReceiver: process.env.DEV_STORAGE_RECEIVER === "true",
  devStoragePublicBaseUrl: process.env.DEV_STORAGE_PUBLIC_BASE_URL || null,
  // live | mock | off. The selectors that pick a mock OUTCOME (WEATHER_MOCK_OUTCOME,
  // SATELLITE_MOCK_OUTCOME) are read on every call so the e2e control server can switch them; the
  // services also read the mode on every call (weatherMode() / satelliteMode() below).
  weatherMode: process.env.WEATHER_MODE || "live",
  satelliteMode: process.env.SATELLITE_MODE || "live",
  sessionCookieName: process.env.SESSION_COOKIE_NAME || "session",
  // E1-S3: backend-issued session tokens (ADR-013, D-34). HMAC HS256 signing secret.
  sessionJwtSecret: process.env.SESSION_JWT_SECRET || undefined,
  accessTokenTtlMs: Number(process.env.ACCESS_TOKEN_TTL_MS) || 15 * 60 * 1000,
  refreshTokenTtlMs: Number(process.env.REFRESH_TOKEN_TTL_MS) || 30 * 24 * 60 * 60 * 1000,
  // Verification policy id (config/verificationPolicy.js). "v1-legacy" reproduces the historical
  // decisions exactly; "v2-components" adds the required-component gate (ADR-020); "v1.1-safe-ai"
  // holds instead of deciding on an AI-only "no damage" reading or a technical failure (ADR-022).
  claimVerificationPolicy: process.env.CLAIM_VERIFICATION_POLICY || DEFAULT_CLAIM_VERIFICATION_POLICY,
  // ADR-021: wall-clock budget (ms) the verify call spends running queued steps before it decides.
  // Must stay under the API Gateway limit (29 s); the AI timeout alone defaults to 25 s.
  claimVerificationRequestBudgetMs: Number(process.env.CLAIM_VERIFICATION_REQUEST_BUDGET_MS) || 22000,
  // When true, GET /claims/:id/verification also runs ONE due step (a status poll then makes
  // progress even with no scheduled worker). Off by default in tests.
  claimVerificationDrainOnRead: (process.env.CLAIM_VERIFICATION_DRAIN_ON_READ || "true").toLowerCase() === "true",
  // ADR-022: the time budget (ms) of that one step. A step starts only with at least its
  // MIN_BUDGET_MS left (services/verificationJobs.service.js; the photo check needs 15 s), measured a
  // moment after this deadline is set. The default therefore clears the photo check's 15 s by a clear
  // margin: every poll may run it, so polls move the queue while no worker is deployed (plan risk R1),
  // and a poll can take up to about 20 s. A budget at exactly 15000 would run it or not depending on
  // whether the clock ticked in between. Below 15000 a poll never runs the photo check; it runs the
  // next shorter due step instead (weather, the engine). Keep it under API Gateway's 29 s.
  claimVerificationReadDrainBudgetMs: Number(process.env.CLAIM_VERIFICATION_READ_DRAIN_BUDGET_MS) || 20000,
  claimAutomatedVerificationEnabled: (process.env.CLAIM_AUTOMATED_VERIFICATION_ENABLED || "true").toLowerCase() === "true",
  mongoUri: process.env.MONGO_URI,
  cognitoClientId: process.env.COGNITO_CLIENT_ID,
  // When set, id tokens must come from THIS user pool (otherwise any Cognito pool is accepted and the
  // audience check alone binds the token to this app).
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID,
  cognitoClientSecret: process.env.COGNITO_CLIENT_SECRET,
  cognitoDomain: process.env.COGNITO_DOMAIN,
  cognitoRedirectUri: process.env.COGNITO_REDIRECT_URI,
  googleApiKey: cleanSecret(process.env.GOOGLE_API_KEY),
  modelProvider: process.env.MODEL_PROVIDER,
  modelName: process.env.MODEL_NAME,
  awsRegion: process.env.MY_AWS_REGION,
  awsAccessKeyId: process.env.MY_AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.MY_AWS_SECRET_ACCESS_KEY,
  s3Bucket: process.env.S3_BUCKET,
  cohereApiKey: process.env.COHERE_API_KEY,
  chromaApiKey: process.env.CHROMA_API_KEY,
  chromaTenant: process.env.CHROMA_TENANT,
  chromaDatabase: process.env.CHROMA_DATABASE,

  // Weather service (E2-S1). All durations in milliseconds.
  weatherCacheTtlMs: Number(process.env.WEATHER_CACHE_TTL_MS) || 30 * 60 * 1000,
  weatherFetchTimeoutMs: Number(process.env.WEATHER_FETCH_TIMEOUT_MS) || 5000,
  weatherStaleAfterMs: Number(process.env.WEATHER_STALE_AFTER_MS) || 60 * 60 * 1000,
  openMeteoBase:
    process.env.OPEN_METEO_BASE_URL || "https://api.open-meteo.com/v1",
  openMeteoArchiveBase: process.env.OPEN_METEO_ARCHIVE_BASE_URL || "https://archive-api.open-meteo.com/v1",
  openMeteoGeocodingBase:
    process.env.OPEN_METEO_GEOCODING_BASE_URL ||
    "https://geocoding-api.open-meteo.com/v1",
});

// ---- ADR-024 (plan A8): dev/e2e seams and the production guard ------------------------------------

const lower = (value) => String(value ?? "").trim().toLowerCase();
const SEAM_MODES = new Set(["live", "mock", "off"]);
// An unknown value is "live", the production behaviour: a typo can never switch a seam on.
const seamMode = (value) => (SEAM_MODES.has(lower(value)) ? lower(value) : "live");

// Read on every call (like LAND_RECORD_MODE), so a test or the e2e control server can switch them.
export const weatherMode = (source = process.env) => seamMode(source.WEATHER_MODE);
export const satelliteMode = (source = process.env) => seamMode(source.SATELLITE_MODE);

const isLambda = (source) => Boolean(source.AWS_LAMBDA_FUNCTION_NAME);
const isProductionRuntime = (source) => source.NODE_ENV === "production" || isLambda(source);

// The dev upload receiver (routes/devStorage.js) exists only when ALL of these hold: mock storage, not
// production, not Lambda, and DEV_STORAGE_RECEIVER=true. app.js imports the route module only then.
export const isDevStorageReceiverEnabled = (source = process.env) =>
  lower(source.IMAGE_STORAGE_MODE) === "mock" &&
  source.NODE_ENV !== "production" &&
  !isLambda(source) &&
  source.DEV_STORAGE_RECEIVER === "true";

// Every setting that replaces a real provider or storage with a stand-in. None may be on in production.
export const PRODUCTION_FORBIDDEN_SEAMS = Object.freeze([
  { key: "IMAGE_STORAGE_MODE", forbidden: (value) => lower(value) === "mock" },
  { key: "IMAGE_AI_MODE", forbidden: (value) => lower(value) === "mock" },
  { key: "LAND_RECORD_MODE", forbidden: (value) => lower(value) === "mock" },
  { key: "WEATHER_MODE", forbidden: (value) => lower(value) === "mock" },
  { key: "SATELLITE_MODE", forbidden: (value) => lower(value) === "mock" },
  { key: "DEV_STORAGE_RECEIVER", forbidden: (value) => lower(value) === "true" },
  { key: "IMAGE_STORAGE_MOCK_DIR", forbidden: (value) => String(value ?? "").trim() !== "" },
]);

// Which dev/test seams are set in a production runtime (NODE_ENV=production or Lambda). Names only,
// never values. [] outside production, where the seams are allowed.
export const productionSafetyViolations = (source = process.env) => {
  if (!isProductionRuntime(source)) return [];
  return PRODUCTION_FORBIDDEN_SEAMS.filter(({ key, forbidden }) => forbidden(source[key])).map(({ key }) => key);
};

// Boot guard (index.js after validateEnv, scripts/worker.js): a production process refuses to start
// with any mock mode or the dev upload receiver configured, so a stand-in can never answer for S3, the
// AI model, the land-record service, weather or satellite in production.
export const assertProductionSafety = (source = process.env) => {
  const violations = productionSafetyViolations(source);
  if (violations.length > 0) {
    throw new Error(
      `Refusing to start: dev/test seam(s) ${violations.join(", ")} must not be set when NODE_ENV=production or on Lambda. ` +
        "See .env.example and docs/engineering/WORKER_RUNBOOK.md."
    );
  }
  return true;
};

export function validateEnv(required = SERVER_REQUIRED) {
  const missing = required.filter((key) => {
    const value = process.env[key];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "See .env.example and docs/engineering/14_Deployment.md §4."
    );
  }
}
