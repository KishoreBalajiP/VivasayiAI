# 19 — CHANGELOG

> **Metadata**
> - **Title:** 19 — CHANGELOG
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Everyone / Docs
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [05_Product_Roadmap](../product/05_Product_Roadmap.md) · [17_Backlog](17_Backlog.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** A structured, human-readable history of what shipped, derived from git. It supports releases, onboarding, and audit. **Generated 2026-08-07** from both repository histories. Format follows [Keep a Changelog](https://keepachangelog.com/)-style grouping; versions are assigned retroactively (no tags exist yet).

**Repos:** `tn-farming-assistant` (backend) · `tn-farming-assistant-frontend` (frontend). **Notable:** the current work is a **documentation system** (Phase 0) — it is tracked below as `[0.1.0]`.

> **Versioning note:** the release-level versions below (backend 1.0.0–1.4.0, frontend 1.0.0–1.6.0) are **retroactive release-history labels** derived from git; no git tags exist yet. They intentionally differ from the `version` fields in `package.json` (backend `1.0.0`, frontend `0.0.0`), which are package metadata, not release history. When release tagging begins (Phase 1, see [14_Deployment](../engineering/14_Deployment.md)), this file aligns to actual tags.

---

## [Unreleased] — Phase 0 (in progress)

### Added (Phase 1/2 — E3-S2 backend, image-based agricultural diagnosis)
- **E3 storage + vision + reasoning pipeline (D-22 Option 1, synchronous).** `POST /upload` now runs the full approved path — validate (existing transport/magic bytes) → **normalize** (sharp: strict decode guard, dimension cap `IMAGE_MAX_DIMENSION`=2048 default, EXIF-strip re-encode, orientation applied) → **private S3 store** (owner-scoped server-generated keys under `uploads/<cognitoSub>/<uploadId>/`, reusing `rag/ingest.js` S3 pattern; lazy config validation so servers without storage still boot) → **`ImageRecord` metadata document** (metadata only, never binary; `stored → processing → completed | failed` state machine, `s3Key` never exposed to clients, best-effort S3 rollback if the DB write fails after the object write). Response now includes `status: "stored"` and a `processed { mediaType, size, width, height }` block.
- **`POST /chat` image diagnosis.** Adding `uploadId` (from `POST /upload`) to the existing `POST /chat` body runs the diagnosis pipeline: owned `ImageRecord` lookup (foreign/unknown → 404) → S3 fetch → **vision observation** (existing `ChatGoogleGenerativeAI` Gemini 2.5 Flash, multimodal `image_url` part; structured JSON observation with explicit uncertainty — never fabricated; API errors → sanitized 500, unparseable output → conservative `unclear`) → context assembly + RAG (both degrade gracefully, as in text chat) → **farmer reasoning** (`buildImageDiagnosisPrompt`: language rule, history, farm context, observation JSON, RAG block) → **persistence**. Response mirrors the text-chat envelope plus `uploadId` and `image { status, processed, vision }` (structured observation card). `language` is honored (`ta`/`en`, else inferred from message, then farm-profile language, then English) — `messages[0].imageId` links the turn; chat titles/message flow unchanged.
- **New/changed files:** `models/ImageRecord.js`, `services/s3.service.js`, `services/imageProcess.service.js`, `services/vision.service.js`, `services/chatImage.service.js`, `services/upload.service.js` (rewritten), `src/ai/ImageDiagnosisTemplates.js`, `src/ai/PromptBuilder.js` (+`buildImageDiagnosisPrompt`), `controllers/upload.controller.js`, `controllers/chat.controller.js`, `middlewares/upload.js` (exposes buffer), `models/ChatSession.js` (optional `imageId`, `text` required only for plain turns), `config/env.js` (+`S3_REQUIRED`, `IMAGE_MAX_DIMENSION`, `UPLOAD_STORAGE_PREFIX`, `IMAGE_STORAGE_MODE`, `IMAGE_AI_MODE`), `utils/validation.schemas.js` (optional `uploadId`; `message` required unless an image is attached — exact prior error message preserved), `.env.example`. New dep: `sharp`.
- **Verification:** `t213-verify.mjs` updated to the storage contract (61 assertions); new **deterministic** `t214-verify.mjs` (70 assertions, mock S3/AI seams documented in `.env.example` — in-memory S3 + canned vision/analysis; covers validation, decode-safety, metadata-only persistence, ownership/404, en/ta diagnostics, language inference, session continuation + foreign isolation, dimension cap, EXIF stripping, re-analysis, text-chat unaffected); new **live provider E2E** `t215-verify.mjs` (18 assertions — real S3 + real Gemini; cleans up S3 objects/sessions). Full regression t201–t214: **571 passed, 0 failed**. Docs updated (17_Backlog, 08_API_Documentation, 07_Database_Design, 15_Security, 09_AI_Architecture, ARCHITECTURE_DECISIONS_PENDING).
- **Remaining product decisions (not changed by this work):** D-23 (S3 retention/lifecycle/signed-URL retrieval — private bucket + prefix used; bucket choice, 90-day lifecycle, presigned URLs pending approval), D-24 (EXIF/consent — EXIF stripped at upload as the approved normalize-side-effect), D-38 (privacy/consent framework). E3-S3/E3-S4 remain frontend stories.

### Added (Phase 1 — E3-S1, multipart image upload transport)
- **E3-S1: multipart image upload transport** — added `POST /upload` behind `requireAuth`; multer 2.3 with custom capped-memory storage, magic-byte sniffing (JPEG/PNG/WEBP only), per-user rate limit, safe server-generated `uploadId`, sanitized 400/413/429 responses; binary never persisted (extended to full storage pipeline in E3-S2 above). Test: `t213-verify.mjs`.

### Added
- Complete documentation system under `docs/` in the backend (Product) repository: product, architecture, engineering, business, planning, decisions. `docs/README.md` is the hub. (2026-08-07)
- Consolidated historical project docs into `docs/planning/todo.md` and `docs/architecture/CHAT_CONTEXT_GUIDE.md`.

### Added (Phase 1 — T-201, E2-S1)
- Weather proxy endpoint `GET /weather?district=<name>`: cache-first Open-Meteo (current + 1-day forecast) with Mongo TTL cache, stale-on-failure, and degrade-to-`unknown` semantics (D-15..D-18). New files: `config/weather.js`, `models/WeatherCache.js`, `services/weather.service.js`, `controllers/weather.controller.js`, `routes/weather.js`; updated `config/env.js`, `.env.example`, `index.js`, `utils/validation.schemas.js`, `docs/architecture/08_API_Documentation.md`. Verification: `t201-verify.mjs`, `t201-live.mjs`.

### Added (Phase 1 — T-202, E2-S2)
- Seeded the `districts` reference collection server-side from the frontend `tamilnaduDistricts.ts` config: `District` model (`name` unique, `lat`, `lon`, `regionType`; `soilType`/`crops` reserved-but-empty, D-19, never fabricated) + idempotent seed script `scripts/seedDistricts.js` (`npm run seed:districts`) + `config/districts.js` (server-side single source of truth, 07_Database_Design §8). New files: `models/District.js`, `config/districts.js`, `scripts/seedDistricts.js`, `t202-verify.mjs`; updated `package.json`. **Note:** the source config carries 37 districts (docs reference 38; Mayiladuthurai's 38th counterpart is not yet in the frontend config) — all 37 are seeded, with the discrepancy flagged for resolution.

### Added (Phase 1 — T-203, E2-S3)
- Context assembly layer (Context Engine first slice, F-20/ADR-014/D-01/D-03): assemble weather (E2-S1 `getWeather`, cache-first) + soil/region (E2-S2 `districts` collection) + crop (detected from the message) + farm profile (degrades to `unknown` until E2-S4) into a labelled plain-text "Context" block injected into the system prompt. Missing domains degrade to explicit `unknown` markers and never 5xx. Removed the dead `{{...}}` placeholders from `src/ai/SystemInstructions.js`. New file: `services/context.service.js`; updated `src/ai/PromptBuilder.js`, `services/chat.service.js`, `utils/validation.schemas.js` (optional `district` on `POST /chat`), `docs/architecture/08_API_Documentation.md`. Verification: `t203-verify.mjs`.

### Added (Phase 2 — E2-S4, farm profile MVP)
- Farm profile MVP (F-21, D-10 Option 1): `profiles` collection + CRUD API keyed by `userEmail` (upsert `POST /profile`, `GET /profile/:email`, `DELETE /profile/:email`), storing onboarding district + crops + acres (soil/phone deliberately excluded per APP-10/D-19/E6). The Context Engine now auto-loads the profile for the caller (D-14): its district and first crop drive weather/soil/crop context, the `Farm profile: known` line renders district/crops/acres at the top of the Context block, and a missing profile gracefully degrades to `unknown`. New files: `models/FarmProfile.js`, `services/farmProfile.service.js`, `controllers/farmProfile.controller.js`, `routes/farmProfile.js`; updated `index.js`, `services/context.service.js`, `services/chat.service.js`, `src/ai/SystemInstructions.js`, `utils/validation.schemas.js`, `docs/architecture/08_API_Documentation.md`. Verification: `t204-verify.mjs`.

### Deferred (Phase 2 — E2-S5, RAG metadata filters)
- **Not implemented — deferred by product decision.** E2-S5 ("ChromaDB filter by district/crop/season at query time", Dep: E2-S3) is blocked on missing authoritative data: `rag/ingest.js` stores only `source`/`chunk_index`/`filename` per chunk — no `district`/`crop`/`season` tags exist to filter on (09_AI_Architecture §3 defect; D-28 states tags require the curated content-store migration, out of scope; `season` is domain 6 of the full F-46 engine, unimplemented). Filters would either return zero chunks or require inventing classification of generic CSVs (prohibited). Revisit after the D-28 curated, sourced content store with per-item district/crop/season tags ships.

### Added (Phase 1 — E1-S2, verified authentication)
- Replaced the unverified `jwt.decode` with real server-side Cognito ID-token verification (SEC-01). `verifyToken` is now async and verifies: signature against the user pool's JWKS (derived from the token's `iss` constrained to the AWS Cognito issuer family, fetched over HTTPS with a bounded timeout), _RS256-only_ algorithm, audience (= Cognito app client id), and expiry. Fails closed (`null`) on any signature/issuer/audience/expiry/algorithm/malformed/key-fetch failure — no fallback to unverified decoding. JWKS keys are cached per-issuer (60-min TTL) and only refetched on cache miss or unknown `kid` (rotation). New file: `utils/jwks.js`; updated `utils/token.js`, `services/auth.service.js` (awaits verification), `middlewares/auth.js` (awaits verification). Security: no tokens/headers/secrets logged. Verification: `t205-verify.mjs`.

### Added (Phase 1 — E1-S3, session JWT issuance)
- The backend now issues its own **short-lived session JWT** (access, ~15 min) **plus a refresh JWT** (~30 days) at `POST /auth/google` instead of returning the raw Cognito `id_token` for the client to store (ADR-013 Option 2, D-34; SEC-06 direction). `User` gains a stable immutable `cognitoSub` (unique, sparse; email kept for display only per 07_Database_Design §6) and is upserted by `cognitoSub`, backfilling legacy email-keyed records. Session access JWT is HMAC-HS256-signed (`SESSION_JWT_SECRET`, required at boot), carries `sub`=cognitoSub + email/name + `tokenType:"access"`, pinned issuer/audience, and expires; `verifyAccessToken` fails closed (HS256-only, issuer/audience/tokenType pinned, signature + expiry) and `requireAuth` now verifies the session token. Refresh-token rotation/revocation and the `POST /auth/refresh` endpoint are deferred to later stories. Tokens are returned in the JSON body (httpOnly-cookie transport is D-34/E1-S12). Files: `config/env.js`/`.env.example` (`SESSION_JWT_SECRET`, `ACCESS_TOKEN_TTL_MS`, `REFRESH_TOKEN_TTL_MS`), `models/User.js`, `utils/token.js`, `services/auth.service.js`, `controllers/auth.controller.js`, `middlewares/auth.js`, `docs/architecture/08_API_Documentation.md`, `docs/architecture/07_Database_Design.md`. Security: no tokens/headers/secrets logged. Verification: `t206-verify.mjs`.

### Added (Phase 1 — E1-S4, `requireAuth` middleware)
- Wired the `requireAuth` middleware (E1-S3) to all protected application routes — `/chat`, `/chatsessions`, `/weather`, `/profile` — so they now require a valid session `Bearer` token (SEC-02); requests without a valid token get `401`. `/auth`, `/health`, and the root `/` liveness probe stay public. Identity is populated from the verified token only (`req.user`); no fallback to body/query identity. Ownership/keying by `userEmail` is intentionally left unchanged and moves to `cognitoSub` scoping in E1-S5 (D-35) — no collections or DB identity were migrated. Files: `index.js` (import + `app.use(requireAuth)`). Security: fail-closed `401` on missing/invalid/malformed/wrong-key tokens; public set limited to auth/health/root. Verification: `t207-verify.mjs` (regressed E1-S2/S3 + E2-S1..4 unchanged).

### Added (Phase 1 — E1-S5, ownership scoping by `cognitoSub`)
- Closed the remaining SEC-02 (IDOR/Broken Access Control) gap (D-35 Option 1, ADR-018): all `/chat`, `/chatsessions`, `/profile` resources are now **scoped by the authenticated user's stable `cognitoSub`** (`req.user.id`, derived only from the verified token), and **client-supplied `userEmail` is removed** from request bodies/query/path on these routes. Chat-session and farm-profile ownership lives on a new `cognitoSub` key (`ChatSession.cognitoSub`, `FarmProfile.cognitoSub` unique+sparse); `userEmail` is retained as a server-set display/legacy dual-key. Foreign/unowned resources return **404** (never 403). Routes changed: `POST /chat`, `GET /chat/session/:chatId`, `GET /chat/sessions`, `POST /chatsessions/new`, `GET /chatsessions/list` (was `/list/:email`), `POST /chatsessions/:id/message`, `GET/DELETE /chatsessions/:id`, `DELETE /chatsessions/clear/all`, `POST /profile` (drops `userEmail`), `GET/DELETE /profile` (were `/:email`). Rate-limit key now `req.user.id`. New idempotent backfill `scripts/backfillOwnership.js` (`--dry-run` supported) maps `User.email → cognitoSub` to scope legacy email-keyed rows per 07_Database_Design §8 migration note (rows without a known user are re-keyed on next login). Files: `models/ChatSession.js`, `models/FarmProfile.js`, `services/chatSession.service.js`, `services/farmProfile.service.js`, `services/chat.service.js`, `services/context.service.js`, `controllers/chat.controller.js`, `controllers/chatSessions.controller.js`, `controllers/farmProfile.controller.js`, `routes/chat.js`, `routes/chatSessions.js`, `routes/farmProfile.js`, `utils/validation.schemas.js`, `middlewares/rateLimit.js`, `index.js`, `scripts/backfillOwnership.js`, docs (08, 07, 18_DECISIONS ADR-018, D-35 → APPROVED). Security: ownership from token only; foreign → 404; no client identity fields trusted. Verification: `t208-verify.mjs` (cross-user read/list/delete/modify → 404; own ops succeed; regressed E1-S2/S3/S4 + E2-S1..4 unchanged).

### Verified (Phase 1 — E1-S6, error sanitization)
- **Sanitization confirmed & documented (SEC-05 resolved).** The central `errorHandler` (`middlewares/error.js`, registered last in `index.js`) already returned safe envelopes — no code change was required: non-`ApiError`/internal failures → `500` fixed generic `"Internal server error"`; `ApiError` → its controlled literal (`message`); body-parse failure → `400` `"Invalid JSON payload"`; unknown route → `404` `"Route not found"` — each `{ statusCode, message, data:{} }`, with **no `stack`/`cause`/internal detail sent to clients**. Full `err` (incl. stack) is logged **server-side** only. Added negative verification `t209-verify.mjs` proving the guarantee at the unit level (native `Error` → generic 500, `ApiError` literal, parse error, not-found) and end-to-end against the live serverless handler (malformed JSON → sanitized 400; 401/404 controlled literals, no stack). Reconciliated stale docs that still claimed a leak: `15_Security.md` (SEC-05 → RESOLVED, A05, remediation step 3), `08_API_Documentation.md` (§0 note, error-envelope convention, §8 `/510` removed), `12_Technical_Guidelines.md` (§4/§6), `ARCHITECTURE_DECISIONS_PENDING.md` (D-06 note), `17_Backlog.md`. Verification: `t209-verify.mjs`.

### Verified (Phase 1 — E1-S7, CORS + body limits; SEC-04 resolved, no application-code change)
- **CORS already strict (SEC-04 resolved, no code change).** `middlewares/cors.js` enforces a fixed allow-list from `env.corsOrigins` (`CORS_ORIGINS`, default `http://localhost:5173`) with `credentials:true`; disallowed/missing allowed origins are rejected (`ApiError.forbidden("Origin not allowed")`) and never receive an `Access-Control-Allow-Origin` header — never `*`. Mounted via `index.js:26`. **JSON body limit 1MB** enforced by `express.json({ limit: "1mb" })` (`index.js:31`). Added `t210-verify.mjs` proving: allowed origin → 200 + `Access-Control-Allow-Origin`; disallowed + arbitrary origins rejected (no bypass); missing origin (non-browser) allowed; OPTIONS preflight allowed → ACAO + methods, disallowed → denied; body ≤1MB accepted; body >1MB rejected (non-2xx, sanitized); E1-S6 sanitization intact (malformed → `400 "Invalid JSON payload"`); E1-S4/S5 controls intact (401/404). Reconciliated stale docs: `06_System_Architecture.md` (was "CORS `*`"), `15_Security.md` (SEC-04 → RESOLVED, A05, remediation step 3, §5 body-size note), `12_Technical_Guidelines.md` (§8), `17_Backlog.md` (E1-S7 → DONE). No `.env`/secrets/tests committed. Regression across t205–t209 + t201–t204 all green. Verification: `t210-verify.mjs`.

### Added (Phase 1 — E1-S8, session mutation rate limiting; SEC-08 resolved)
- **Session mutation limiter added (SEC-08 resolved).** Auth and chat rate limiters already existed (`authLimiter` 10/60s per IP, `chatLimiter` 30/60s per user, `chatDailyLimiter` 300/24h per user — `middlewares/rateLimit.js`). The sole gap — `/chatsessions` mutation routes — is now closed: a new `sessionMutationLimiter` (30 requests per 60s, per authenticated user via `chatKeyGenerator` / `req.user.id`) applies to `POST /new`, `POST /:id/message`, `DELETE /:id`, `DELETE /clear/all` (route-level in `routes/chatSessions.js`). Reads (`GET /list`, `GET /:id`) remain **unthrottled** by design — the limiter is per-route, not mounted on the `/chatsessions` namespace. Returns `429` with `Retry-After` header and standard `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-policy` headers (express-rate-limit v8, `standardHeaders: true`). All four mutation routes share the same per-user counter. D-37 cost quotas / budgets / alerting remain blocked on product approval and are explicitly out of scope. Config: `SESSION_MUTATION_RATE_LIMIT_WINDOW_MS` (default 60000) and `SESSION_MUTATION_RATE_LIMIT_MAX` (default 30) added to `config/env.js` and `.env.example`. Files: `config/env.js`, `.env.example`, `middlewares/rateLimit.js`, `routes/chatSessions.js`. Verification: `t211-verify.mjs` proving 429 triggers exactly at limit; `Retry-After` + `ratelimit-limit`/`ratelimit-remaining` headers present; all 4 mutation routes share counter; reads remain 200 after exhaustion; per-user independence; E1-S4/5/6/7 controls intact. Regression across t205–t210 + t201–t204 all green.

### Added (Phase 1 — production-hardening & reconciliation pass, 2026-09-11)
- **E4-S3 — session API consolidated.** Retired the `GET /chat/session/:chatId` and `GET /chat/sessions` duplicates (routes `routes/chat.js`, controllers `controllers/chat.controller.js`); `/chatsessions/*` is the single sessions resource. Requests to the retired paths now return `404` (valid token) / `401` (no token). Updated `t208-verify.mjs` and docs (08, 07, CHAT_CONTEXT_GUIDE, 04 F-18, roadmap).
- **Fixed `selectTemplate` clarification bug.** `src/ai/PromptTemplates.js` returned `TEMPLATES.Clarifications` (undefined) for short/question-mark messages, so those prompts rendered `Task focus: undefined`; now returns `TEMPLATES.CLARIFICATIONS`.
- **Fixed mojibake Tamil fallback.** The hardcoded empty-AI fallback in `services/chat.service.js` contained U+FFFD replacement chars; replaced with the canonical clean safety line used by the `FALLBACK_RESPONSE` template.
- **Added `ChatSession` compound index** `{ cognitoSub: 1, updatedAt: -1 }` (`models/ChatSession.js`) so the list-recent query gets a covered sort.
- **Added `t212-verify.mjs`** — deterministic full user-backend suite (public probes, auth enforcement on every route, zod validation incl. length caps, session lifecycle, IDOR negatives, profile lifecycle, weather, retired-route checks, template-selector regression). Made `t201-verify.mjs` deterministic by clearing the chennai weather cache before the live-fetch assertion (it was stale-locked by prior runs).
- **Security summary reconciled** (`15_Security.md`): SEC-01 → RESOLVED (E1-S2/S3), SEC-02 → RESOLVED (E1-S4/S5), SEC-03 → RESOLVED (E1-S1), SEC-09 → RESOLVED (E1-S9 input caps), SEC-10 → RESOLVED (E1-S5, no emails in URLs). Backlog/repo reconciled for E1-S1..S5/S9, E2-S1..S5, E4-S1 (blocked, with reason), E4-S3.
- **Not implemented, documented as blocked:** E4-S1 SSE streaming (Lambda + `serverless-http` buffering; needs D-05 + `RESPONSE_STREAM` deploy infra — see 17_Backlog). E3-S2..S4 remain blocked on D-23/D-24. E1-S10/E1-S11/E1-S12/E5-* remain open (credentials/CI/frontend scope). No commit was made pending product review of the final report.
- Verification: regression across t201–t211 all green; `t212-verify.mjs` 59/59.

---

### [1.4.0] — 2026-02-28
**Changed**
- Bumped Lambda runtime to Node 24 base image (`Dockerfile`, commit `5230430`).

### [1.3.0] — 2026-01-04
**Fixed**
- Chat session title now updates from the first message when the session is empty (`945dde8`).
- Removed hardcoded "New Chat" title handling (`e7d3645`).

### [1.2.0] — 2025-10-29
**Changed**
- Docker-based Lambda deployment: build image → push to ECR → update function code; refined GitHub Actions workflow (`165a514`, `5628bea`, `38cdc8a`, `4e54d9b`).
- Removed `multer` dependency (image upload not yet implemented) (`4f11579`).
- Renamed environment variables to be unique (`65994e2`).

### [1.1.0] — 2025-10-28
**Added**
- Chat session model (`ChatSession`) with embedded messages (`aa9f8c2`).
- Merged auth work branch into `main` (`cc1a583`).

### [1.0.0] — 2025-10-21 → 2025-10-23
**Added**
- Express backend scaffold ready for Lambda + deploy workflow (`3a3331e`).
- Google login via AWS Cognito OAuth2 code exchange; upsert user in MongoDB (`d759009`).
- Database schemas for users, queries, and context (`9420854`).
- RAG chat pipeline (Gemini 2.5 Flash + Cohere embeddings + ChromaDB Cloud), S3 ingestion script, chat context/memory, session CRUD.

---

## Frontend releases

### [1.6.0] — 2026-01-05
**Added**
- ChatGPT-style image preview before send (UI only; image not yet uploaded) (`5de18e5`).

### [1.5.0] — 2026-01-03
**Fixed**
- English/Tamil toggling issues in header and interface (`0539261`, `e6cf3bd`).

### [1.4.0] — 2025-12-15
**Changed**
- Chat interface + sidebar reworked to a ChatGPT-style layout (`2c012f4`, `37058e1`, `1baef3a`).
- Mobile-friendly responsive improvements; sidebar open state management; auto-scroll to latest message (`f23ff0f`, `447d143`, `7895913`, `cacae9c`).

### [1.3.0] — 2025-10-29
**Changed**
- Mobile responsiveness pass; README updated (`91e62af`, `527d798`).

### [1.2.0] — 2025-10-28
**Added**
- Location, weather, forecast, and farmer advice on the login screen for Tamil Nadu; default to Chennai (`d74ac23`).
- Voice input for Tamil and English (browser Web Speech API) (`92b9460`).
- Chat sidebar (`67ff26c`); language persistence, toasts, manual translations (`4083adf`).

### [1.1.0] — 2025-10-27
**Added**
- Frontend wired to the AI backend (`1091ce5`).

### [1.0.0] — 2025-10-26
**Added**
- Initial Vite + React + TypeScript SPA scaffold (`1ca1640`).

---

## Known gaps NOT yet released (see 04_Feature_List / 17_Backlog)

- Verified authentication & authorization (SEC-01/02) — **unreleased, critical**.
- Image upload/diagnosis — **UI only today**.
- Text-to-speech output — **unreleased**.
- Weather/location/soil context injected into AI prompts — **unreleased**.
- Streaming responses — **unreleased**.
- Automated tests / AI eval harness — **unreleased**.
- WhatsApp integration — **unreleased**.
- Frontend production deployment — **unreleased**.

---

## Maintenance

- Append to this file on every release (tag/merge to main).
- Group by `Added` / `Changed` / `Fixed` / `Security`.
- Reference commit hashes and, where relevant, ADRs (18_DECISIONS.md) and backlog IDs (17_Backlog.md).
- This file is maintained manually; a release tooling step (semantic release) may generate it in the future.
