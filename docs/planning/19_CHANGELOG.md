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
