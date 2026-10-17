# Environment variables

**Checked against the code on 2026-10-17** (backend working tree on `develop` after `6dbe6b8`, uncommitted; frontend working tree on `develop` after `56f26eb`, uncommitted). The list was produced from a grep of every `process.env.X`, `process.env["X"]`, `source.X` / `env.X` (functions that take an environment object) and `import.meta.env.X` in both repositories, excluding `node_modules`, and then checked line by line. Values in `.env` files were not read. `.env.example` (backend) and `.env.example` (frontend) hold placeholders for most of these keys.

How to read the tables:
- **Default** is what the code uses when the variable is unset.
- **Scope:** `prod` = read by the deployed API or worker; `dev` = local tooling and scripts; `test` = tests and the hermetic e2e harness only.
- **Secret:** `yes` means it must never be printed, logged or committed. Copy it the way [WORKER_RUNBOOK.md §3](WORKER_RUNBOOK.md#3-copy-the-apis-environment-secrets-never-echoed) does.
- **Read:** `boot` = read once when the module is imported (a change needs a restart); `call` = read on every use.

Two parsing rules apply to many keys:
- Numeric keys parsed as `Number(value) || default` **cannot be set to 0**: `0` falls back to the default. This applies to every numeric key in `config/env.js` and to the `CLAIM_ASSESSMENT_*`, `LAND_RECORD_TIMEOUT_MS`, `GEMINI_TIMEOUT_MS` and `WORKER_MAX_JOBS` keys.
- Boolean keys compare the lower-cased string with `"true"`: anything else is false. `CLAIM_VERIFICATION_DRAIN_ON_READ` and `CLAIM_AUTOMATED_VERIFICATION_ENABLED` default to true when unset.

## 1. Required at boot

`validateEnv(SERVER_REQUIRED)` in `index.js` refuses to start the API without these (`config/env.js:41`). The worker CLI requires `MONGO_URI`, the four chat keys and `COHERE_API_KEY` (`scripts/worker.js:105`).

| Variable | Purpose | Scope | Secret |
|---|---|---|---|
| `MONGO_URI` | MongoDB connection string | prod, dev | yes (contains the password) |
| `GOOGLE_API_KEY` | Gemini key for chat, photo assessment and land-document reading | prod | yes |
| `CHROMA_API_KEY` | Chroma Cloud key (knowledge retrieval) | prod | yes |
| `CHROMA_TENANT` | Chroma Cloud tenant | prod | no |
| `CHROMA_DATABASE` | Chroma Cloud database | prod | no |
| `SESSION_JWT_SECRET` | HS256 secret for backend session tokens; also signs dev-receiver URLs | prod | yes |

## 2. Application settings (`config/env.js`, read at boot)

All of these are read once into the frozen `env` object when `config/env.js` is imported. `config/env.js` also loads `.env` from the repo root unless `VIVASAYI_SKIP_DOTENV=1`.

### Server, auth and AI

| Variable | Default | Scope | Secret | Notes |
|---|---|---|---|---|
| `PORT` | `8000` | dev | no | Ignored on Lambda (`AWS_LAMBDA_FUNCTION_NAME` set) |
| `CORS_ORIGINS` | `http://localhost:5173` | prod | no | Comma-separated allow-list |
| `SESSION_COOKIE_NAME` | `session` | prod | no | |
| `ACCESS_TOKEN_TTL_MS` | 900 000 (15 min) | prod | no | |
| `REFRESH_TOKEN_TTL_MS` | 2 592 000 000 (30 days) | prod | no | |
| `MESSAGE_MAX_LENGTH` | `2000` | prod | no | Chat message cap |
| `COGNITO_CLIENT_ID` | none | prod | no | Must match the frontend's `VITE_COGNITO_CLIENT_ID` |
| `COGNITO_USER_POOL_ID` | none | prod | no | When set, id tokens must come from this pool |
| `COGNITO_CLIENT_SECRET` | none | prod | yes | |
| `COGNITO_DOMAIN` | none | prod | no | |
| `COGNITO_REDIRECT_URI` | none | prod | no | |
| `MODEL_PROVIDER` | `gemini` (via `src/ai/AIConfig.js`) | prod | no | |
| `MODEL_NAME` | `gemini-2.5-flash` (via `src/ai/AIConfig.js`) | prod | no | |
| `COHERE_API_KEY` | none | prod | yes | Query and document embeddings |
| `MY_AWS_REGION` | none | prod | no | S3 region |
| `MY_AWS_ACCESS_KEY_ID` | none | prod | yes | S3 access key |
| `MY_AWS_SECRET_ACCESS_KEY` | none | prod | yes | |
| `S3_BUCKET` | none | prod | no | Uploads, claim evidence and knowledge CSVs |
| `UPLOAD_STORAGE_PREFIX` | `uploads` | prod | no | Key prefix for farmer uploads |

### Rate limits (per user, in memory per container)

| Variable | Default | Notes |
|---|---|---|
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX` | 60 000 / 10 | per IP |
| `CHAT_RATE_LIMIT_WINDOW_MS` / `CHAT_RATE_LIMIT_MAX` | 60 000 / 30 | |
| `CHAT_DAILY_RATE_LIMIT_WINDOW_MS` / `CHAT_DAILY_RATE_LIMIT_MAX` | 86 400 000 / 300 | |
| `SESSION_MUTATION_RATE_LIMIT_WINDOW_MS` / `SESSION_MUTATION_RATE_LIMIT_MAX` | 60 000 / 30 | |
| `CLAIM_RATE_LIMIT_WINDOW_MS` / `CLAIM_RATE_LIMIT_MAX` | 3 600 000 / **15** | claim writes (`RATE_LIMIT_DEFAULTS.claimWrites`, since 2026-10-16; was 5) |
| `EVIDENCE_RATE_LIMIT_WINDOW_MS` / `EVIDENCE_RATE_LIMIT_MAX` | 3 600 000 / **60** | photo presign/complete/delete and land-document attach (`RATE_LIMIT_DEFAULTS.evidence`; was 20) |
| `CLAIM_READ_RATE_LIMIT_WINDOW_MS` / `CLAIM_READ_RATE_LIMIT_MAX` | 3 600 000 / 600 | claim reads, including `/progress` (`RATE_LIMIT_DEFAULTS.reads`) |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` / `UPLOAD_RATE_LIMIT_MAX` | 60 000 / 10 | generic `/upload` (chat images, land-document files) |
| `ADMIN_RATE_LIMIT_WINDOW_MS` / `ADMIN_RATE_LIMIT_MAX` | 60 000 / 120 | per admin |

All rate-limit keys are scope `prod`, not secret.

### Claims and verification

| Variable | Default | Scope | Notes |
|---|---|---|---|
| `CLAIM_VERIFICATION_POLICY` | **`v1.1-safe-ai`** (`DEFAULT_CLAIM_VERIFICATION_POLICY`, since 2026-10-16, ADR-022) | prod | `v1-legacy`, `v2-components` or `v1.1-safe-ai`; an unknown id stops the boot (`assertPolicyConfigured`) |
| `CLAIM_AUTOMATED_VERIFICATION_ENABLED` | `true` | prod | Off: no plans are written, nothing drains, the reconcile sweep does nothing |
| `CLAIM_VERIFICATION_DRAIN_ON_READ` | `true` | prod | An owner's `GET /progress` or `GET /verification` runs one due job |
| `CLAIM_VERIFICATION_READ_DRAIN_BUDGET_MS` | 20 000 | prod | Budget of that one job. Below 15 000 a poll never runs the photo check |
| `CLAIM_VERIFICATION_REQUEST_BUDGET_MS` | 22 000 | prod | `POST /verify` drain budget; keep under API Gateway's 29 s |
| `CLAIM_WINDOW_DAYS` | 30 | prod | |
| `CLAIM_AREA_OVERAGE_FRACTION` | 0.05 | prod | |
| `CLAIM_OVERLAP_TOLERANCE_M` | 1.0 | prod | |
| `CLAIM_EVIDENCE_MAX_IMAGES` | 10 | prod | |
| `CLAIM_MAX_RESUBMISSIONS` | 2 | prod | |
| `CLAIM_RESUBMIT_COOLDOWN_MS` | 86 400 000 | prod | `0` is not possible (falls back to the default) |
| `ADMIN_OVERRIDE_APPROVER_ACRE_THRESHOLD` | 0 (off) | prod | A second admin approver above this acreage |

### Images and weather

| Variable | Default | Scope | Notes |
|---|---|---|---|
| `IMAGE_UPLOAD_MAX_BYTES` | 5 242 880 | prod | |
| `IMAGE_MAX_DIMENSION` | 2048 | prod | Longest edge after normalisation |
| `IMAGE_VIEW_URL_TTL_SECONDS` | 300 | prod | Signed GET URL lifetime |
| `WEATHER_CACHE_TTL_MS` | 1 800 000 | prod | |
| `WEATHER_FETCH_TIMEOUT_MS` | 5000 | prod | |
| `WEATHER_STALE_AFTER_MS` | 3 600 000 | prod | |
| `OPEN_METEO_BASE_URL` | `https://api.open-meteo.com/v1` | prod | |
| `OPEN_METEO_ARCHIVE_BASE_URL` | `https://archive-api.open-meteo.com/v1` | prod | Rainfall around the event |
| `OPEN_METEO_GEOCODING_BASE_URL` | `https://geocoding-api.open-meteo.com/v1` | prod | |

## 3. Read on every call (services)

| Variable | Default | Scope | Secret | Where |
|---|---|---|---|---|
| `VERIFICATION_LEASE_MS` | 60 000 | prod | no | `services/verificationJobs.service.js:158` |
| `VERIFICATION_HEARTBEAT_MS` | lease / 3 (capped at lease / 2) | prod | no | line 163 |
| `VERIFICATION_RETRY_SCHEDULE_MS` | `60000,300000,900000,3600000,3600000,10800000` | prod | no | line 164 (CSV) |
| `VERIFICATION_MAX_ATTEMPTS` | `ai_assessment` 7, `land_documents` 7, others 5 | prod | no | line 165 (JSON object) |
| `VERIFICATION_DEAD_RECOVERY_AFTER_MS` | 21 600 000 (6 h) | prod | no | line 166 |
| `CLAIM_ASSESSMENT_PER_IMAGE_TIMEOUT_MS` | 25 000 | prod | no | `services/claimAssessment.service.js:170` |
| `CLAIM_ASSESSMENT_STALE_MS` | 600 000 | prod | no | line 171; legacy `processing` rows without a slot lease |
| `CLAIM_ASSESSMENT_TIMEOUT_MS` | 25 000 | prod | no | line 355; the in-request budget |
| `GEMINI_TIMEOUT_MS` | 25 000 | prod | no | `utils/aiTimeout.js:22` (a snapshot is also taken at import for logs) |
| `LAND_RECORD_MODE` | `live` | prod, test | no | `services/officialLandRecord.service.js:14`; `mock` is refused in production |
| `LAND_RECORD_PROVIDER_URL` | none | prod | no | No authorised provider exists; unset gives `unavailable` |
| `LAND_RECORD_API_KEY` | none | prod | yes | |
| `LAND_RECORD_TIMEOUT_MS` | 8000 | prod | no | |
| `RAG_COLLECTION` | `farming-documents` | prod, dev | no | `config/ragConfig.js:18`; the production chat collection |
| `RAG_MAX_ROWS_PER_FILE` | 0 (no cap) | dev | no | `config/ragConfig.js:25`; ingestion only |
| `WORKER_MAX_JOBS` | 25 | prod, dev | no | Lambda handler (`services/verificationWorker.service.js:269`) and `scripts/worker.js` |

### Satellite (`resolveSatelliteConfig`, read on every run)

`services/satellite/config.js:92`. Each key has a `SATELLITE_POC_*` alias from the proof of concept (in parentheses), read only when the main key is unset.

| Variable | Default | Scope | Secret | Notes |
|---|---|---|---|---|
| `SATELLITE_ENABLED` (`SATELLITE_POC_ENABLED`) | `true` | prod | no | Anonymous discovery runs when true |
| `SATELLITE_PROCESSING_ENABLED` | `false` | prod | no | NDVI processing needs this **and** credentials |
| `CDSE_CLIENT_ID` (`SENTINEL_HUB_CLIENT_ID`) | none | prod | yes | Copernicus Data Space OAuth client |
| `CDSE_CLIENT_SECRET` (`SENTINEL_HUB_CLIENT_SECRET`) | none | prod | yes | |
| `SATELLITE_PROVIDER` (`SATELLITE_POC_PROVIDER`) | `cdse-sentinel` | prod | no | |
| `SATELLITE_REQUEST_TIMEOUT_MS` (`SATELLITE_POC_TIMEOUT_MS`) | 8000 | prod | no | |
| `SATELLITE_MAX_RETRIES` (`SATELLITE_POC_MAX_RETRIES`) | 1 | prod | no | |
| `SATELLITE_MAX_SCENES` (`SATELLITE_POC_MAX_SCENES`) | 10 | prod | no | Per discovery request, one request per window |
| `SATELLITE_CLOUD_MAX` (`SATELLITE_POC_CLOUD_MAX`) | 0.3 | prod | no | Scene cloud limit for discovery quality |
| `SATELLITE_PROCESSING_SCENE_CLOUD_MAX` | 0.9 | prod | no | Scene cloud limit for parcel statistics (raised after the live study) |
| `SATELLITE_MAX_WINDOW_DAYS` (`SATELLITE_POC_MAX_WINDOW_DAYS`) | 120 | prod | no | |
| `SATELLITE_STAC_URL` (`SATELLITE_POC_STAC_URL`) | `https://catalogue.dataspace.copernicus.eu/stac` | prod | no | |
| `SATELLITE_TOKEN_URL` (`SATELLITE_POC_TOKEN_URL`) | CDSE identity token endpoint | prod | no | |
| `SATELLITE_STATISTICS_URL` (`SATELLITE_POC_STATISTICS_URL`) | `https://sh.dataspace.copernicus.eu/api/v1/statistics` | prod | no | |

`poc/satellite/config.js` (the historical proof of concept, not used by the app) also reads `SATELLITE_POC_ALLOW_PUBLIC_FALLBACK` and `SATELLITE_POC_FALLBACK_STAC_URL`.

## 4. Read at module load outside `config/env.js`

| Variable | Default | Scope | Where |
|---|---|---|---|
| `VIVASAYI_SKIP_DOTENV` | unset (`.env` is loaded) | dev, test | `config/env.js:12`. `1` keeps `.env` out of the process. Set by `vitest.config.js`, the e2e harness and the acceptance runner |
| `NODE_ENV` | `development` for the logger | prod | `utils/logger.js:48` (boot); also read on each call by `assertProductionSafety` and `isDevStorageReceiverEnabled` |
| `LOG_LEVEL` | `info` in production, `debug` otherwise | prod, dev | `utils/logger.js:54` |
| `AWS_LAMBDA_FUNCTION_NAME` | set by AWS Lambda | prod | `index.js:22` (no `listen` on Lambda), `utils/logger.js:55`, and per call in the production guards. Never set it by hand |
| `AI_MAX_RETRIES` | 1 | prod | `utils/aiTimeout.js:71`, used when `services/chat.service.js` builds the shared model at import |
| `MAX_OUTPUT_TOKENS` | 2048 | prod | `src/ai/AIConfig.js` |
| `CHAT_HISTORY_MESSAGES` | 6 | prod | `src/ai/AIConfig.js` |
| `MAX_INPUT_TOKENS` | 8192 | prod | `src/ai/AIConfig.js` |
| `RESERVED_OUTPUT_TOKENS` | 512 | prod | `src/ai/AIConfig.js` |
| `RAG_TOP_K` | 3 | prod | `src/ai/AIConfig.js` |
| `EMBEDDING_MODEL` | `embed-english-v3.0` | prod | `src/ai/AIConfig.js` |

## 5. Dev and test seams (refused in production)

`assertProductionSafety()` (`config/env.js:248`, called by `index.js` after `validateEnv` and by `scripts/worker.js`) stops the process when `NODE_ENV=production` or `AWS_LAMBDA_FUNCTION_NAME` is set and any of these is active (ADR-024). Names only are reported, never values.

| Variable | Default | Refused in production when | Read |
|---|---|---|---|
| `IMAGE_STORAGE_MODE` | `live` | `mock` | boot |
| `IMAGE_AI_MODE` | `live` | `mock` | boot |
| `LAND_RECORD_MODE` | `live` | `mock` | call |
| `WEATHER_MODE` | `live` (`live`, `mock`, `off`; unknown values mean `live`) | `mock` | call (`weatherMode()`) |
| `SATELLITE_MODE` | `live` (`live`, `mock`, `off`) | `mock` | call (`satelliteMode()`) |
| `DEV_STORAGE_RECEIVER` | `false` | `true` | boot (`app.js` mounts `/__dev/storage` only when `isDevStorageReceiverEnabled()`) |
| `IMAGE_STORAGE_MOCK_DIR` | unset | any value | boot |

Related test-only selectors, read on every call: `LAND_RECORD_MOCK_OUTCOME` (default `unavailable`), `WEATHER_MOCK_OUTCOME` (`available`), `SATELLITE_MOCK_OUTCOME` (`imagery_found`). `DEV_STORAGE_PUBLIC_BASE_URL` (unset) is the origin the browser reaches the dev receiver at. The receiver is enabled only when **all** of these hold: `IMAGE_STORAGE_MODE=mock`, `NODE_ENV` is not `production`, `AWS_LAMBDA_FUNCTION_NAME` is unset, and `DEV_STORAGE_RECEIVER=true`.

## 6. Worker CLI (`scripts/worker.js`)

| Variable | Default | Scope | Notes |
|---|---|---|---|
| `WORKER_ALLOW_REMOTE_DB` | unset | dev | `true` lets the CLI connect to a database that is not on this machine (Atlas or any remote host). Use only deliberately, for one command |
| `WORKER_POLL_INTERVAL_MS` | 5000 | dev | Sleep when a batch found nothing |
| `WORKER_BATCH_BUDGET_MS` | 240 000 | dev | Deadline of one batch |
| `WORKER_MAX_JOBS` | 25 | dev, prod | Jobs per batch (also the Lambda handler) |
| `WORKER_SWEEP_INTERVAL_MS` | 60 000 | dev | Minimum time between sweeps in the loop |

## 7. Scripts, migration, e2e harness and acceptance tooling

| Variable | Default | Scope | Secret | Used by |
|---|---|---|---|---|
| `MIGRATION_ALLOW_REMOTE_APPLY` | unset | dev | no | `scripts/migrations/2026-10-verification-automation.js`: `--apply` against any database that is not on this machine (Atlas or a remote `mongodb://` host) needs `true` (lines 39-44). `scripts/migrations/2026-10-verification-components.js` needs it for any write (without `--dry-run`) to such a database. Both guards were tightened on 2026-10-17 after audit B (B-D1, B-D2) |
| `RAG_INGEST_PREFIX` | `""` | dev | no | `rag/ingest.js`: only ingest keys under this prefix |
| `E2E_CONTROL_TOKEN` | random per run | test | yes | `scripts/e2e/hermeticBackend.js`: bearer token of the control server (at least 16 characters if set) |
| `E2E_SESSION_JWT_SECRET` | random per run | test | yes | harness session secret (at least 32 characters if set) |
| `E2E_MONGO_URI` | unset | test | no | `--mongo=local`; must be a loopback URI |
| `E2E_SCENARIO_FILE`, `E2E_NETWORK_VIOLATIONS_FILE` | set by the harness | test | no | shared with the process-mode worker preload |
| `E2E_FAKE_TIMEOUT_MS` | from `scripts/e2e/e2e.env` (6000) | test | no | how long the fake Gemini stalls in the timeout scenario |
| `WORKER_FIXTURE_SLOW_STEP`, `WORKER_FIXTURE_SLOW_MS` | unset / 60 000 | test | no | `tests/fixtures/slowWorkerBootstrap.js`: makes one step sleep so `tests/worker.crashRecovery.test.js` can kill the worker mid-step |
| `MONGOMS_SYSTEM_BINARY` | auto-detected (`/opt/homebrew/bin/mongod`, `/usr/local/bin/mongod`) | test | no | mongodb-memory-server binary; also recorded by the acceptance runner |
| `VIVASAYI_FRONTEND_DIR` | `../VivasayiAI-Frontend` | dev | no | `scripts/acceptance/collect.js` |
| `PLAYWRIGHT_BROWSERS_PATH`, `LOCALAPPDATA` | unset | dev | no | `scripts/acceptance/collect.js`, environment fingerprint only |
| `ACCEPTANCE_LOG_LEVEL` | unset | dev | no | `scripts/live/localAcceptance.js` |

The live evaluation scripts in `scripts/live/` read the same provider keys as the app (`MONGO_URI`, `MY_AWS_*`, `S3_BUCKET`, `GOOGLE_API_KEY`, and so on) plus `LOG_LEVEL`, and set `CLAIM_AUTOMATED_VERIFICATION_ENABLED`, `CLAIM_VERIFICATION_DRAIN_ON_READ` and `IMAGE_STORAGE_MODE` for their own process. `scripts/eval/*` read `VIVASAYI_SKIP_DOTENV`, `GEMINI_TIMEOUT_MS` and the claim rule knobs to reproduce historical values.

The committed harness environment is `scripts/e2e/e2e.env`. It sets the mock modes, `CLAIM_VERIFICATION_POLICY=v1.1-safe-ai`, `CLAIM_VERIFICATION_DRAIN_ON_READ=false`, short retry schedules, CORS for port 15173 and blank live credentials.

## 8. Frontend (`VivasayiAI-Frontend`)

Vite inlines `VITE_*` values into the bundle **at build time**. Everything here is public: never put a secret in a `VITE_*` variable.

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `''` (same origin) | Backend base URL, for example `http://localhost:8000`. There is no localhost fallback |
| `VITE_COGNITO_DOMAIN` | `''` | Cognito Hosted UI domain |
| `VITE_COGNITO_CLIENT_ID` | `''` | Must equal the backend `COGNITO_CLIENT_ID` |
| `VITE_COGNITO_REDIRECT_URI` | `window.location.origin` | Must be registered in Cognito |
| `VITE_MAP_TILE_URL` | public OpenStreetMap tiles | Empty string shows "map not configured" |
| `VITE_GEOCODER_URL` | public Nominatim search | Empty string falls back to the public default |

Frontend tooling: `VIVASAYI_BACKEND_DIR` (`scripts/check-contract-sync.mjs`, default `../VivasayiAI`), `E2E_JSON_OUT` (set by the backend acceptance runner for Playwright's JSON report, `e2e/lib/env.ts`), `E2E_NETWORK_VIOLATIONS_OUT` (where the global teardown writes the backend guard's violation list; default next to the JSON report) and `E2E_CONTROL_TOKEN` (`playwright.config.ts:37-38`: generated per run when unset or shorter than 16 characters, and passed to both harness processes). `VITE_MAP_TILE_URL` and `VITE_GEOCODER_URL` are declared in `src/vite-env.d.ts` and read in `src/config/map.ts`; the e2e run points them at the harness control server (`e2e/lib/env.ts:31-32`).

## 9. Keeping this list current

Re-run the grep after any change that reads a new variable, and add the key to `.env.example` with a placeholder. The grep used for this document (run from a repository root):

```bash
grep -rnoE "process\.env(\.[A-Z_][A-Z0-9_]*|\[\"[A-Z_][A-Z0-9_]*\"\])" --include='*.js' --exclude-dir=node_modules . | sort -u
grep -rnoE "\b(env|source|environment)\.[A-Z][A-Z0-9_]{3,}" --include='*.js' --exclude-dir=node_modules --exclude-dir=tests . | sort -u
```

`services/satellite/config.js` reads its keys through `pickEnv(env, [...names])`; read that file directly.
