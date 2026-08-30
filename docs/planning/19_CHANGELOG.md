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

---

## Backend releases

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
