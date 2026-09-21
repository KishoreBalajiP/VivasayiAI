# 18 — DECISIONS (Architecture Decision Records)

> **Metadata**
> - **Title:** DECISIONS (Architecture Decision Records)
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Engineering (all deciders)
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [AI_Product_Principles](../product/AI_Product_Principles.md) · [06_System_Architecture](../architecture/06_System_Architecture.md) · [09_AI_Architecture](../architecture/09_AI_Architecture.md) · [12_Technical_Guidelines](../engineering/12_Technical_Guidelines.md) · [13_Testing_Strategy](../engineering/13_Testing_Strategy.md)

> **Why this document exists:** Every consequential technical or product decision is recorded with its context, options considered, chosen solution, rationale, and tradeoffs. This gives new engineers the "why" behind the code and lets future decisions build on — or consciously reverse — earlier ones.
>
> **Format (ADR):** `ADR-###` · Status: `[ACCEPTED]` / `[SUPERSEDED]` / `[PROPOSED]` · Date · Deciders.

---

## ADR-001 — Serverless monolith (Express on AWS Lambda)
- **Status:** ACCEPTED · **Date:** 2025-10-21 · **Deciders:** Founding engineer

**Problem:** Deploy a small Node backend with minimal ops while it is a prototype.
**Options:**
1. Always-on VPS/container (Render/ECS/E2).
2. Serverless function (Lambda) with `serverless-http` wrapper.
3. Platform-as-a-service (Vercel serverless functions).
**Chosen:** Option 2 — Express app wrapped with `serverless-http`, deployed via Docker → ECR → Lambda, GitHub Actions (`deploy-lambda.yml`).
**Reason:** Zero server management, scales to zero, cheap at prototype scale, reuses standard Express code, and CI already exists.
**Tradeoffs:** Cold starts; module-scope init (Mongo/ChromaDB/model clients) at cold start is heavy; no WebSocket/long-lived connections; must keep container small. Mitigations planned: provisioned concurrency, lighter boot (lazy clients), measured p95.

## ADR-002 — Authentication via AWS Cognito OAuth2 (Google federation)
- **Status:** SUPERSEDED (security hardening planned) · **Date:** 2025-10-23

**Problem:** Sign-in without building username/password storage.
**Options:**
1. Firebase Auth (Google).
2. AWS Cognito user pool with Google federation (chosen).
3. Custom OAuth (Passport).
**Chosen:** Cognito authorization-code flow; frontend redirects to Cognito, exchanges code for `id_token`, stores it.
**Reason:** AWS-native (rest of infra is AWS), built-in Google federation, no password handling.
**Tradeoffs / known issues (SEC-01, SEC-06):** Backend currently calls `jwt.decode(id_token)` **without verifying signature**; tokens stored in `localStorage`; no refresh lifecycle. **Decision to harden in Phase 1:** verify signature/issuer/audience/expiry server-side and issue backend session tokens with stable `cognitoSub` identity (see ADR-013 PROPOSED).

## ADR-003 — RAG stack: Cohere embeddings + ChromaDB Cloud + Gemini
- **Status:** ACCEPTED (with planned upgrades) · **Date:** 2025-10-28

**Problem:** Ground AI answers in Tamil Nadu agricultural knowledge to prevent hallucination.
**Options:**
1. Pure LLM prompting (no retrieval).
2. RAG with in-process vector store.
3. RAG with managed vector DB (ChromaDB Cloud) + external embeddings (Cohere) — chosen.
**Chosen:** LLM = Gemini 2.5 Flash (`ChatGoogleGenerativeAI`); embeddings = Cohere `embed-english-v3.0` (1024 dims); vector DB = ChromaDB Cloud (`farming-documents`). Ingestion from AWS S3 CSVs.
**Reason:** Managed services minimize ops; Gemini is strong at multilingual text; Cohere embeddings are compatible and cheap; S3 already held the datasets.
**Tradeoffs:** Vendor coupling (Cohere + ChromaDB + Gemini); embedding model must stay in sync between ingestion and query; manual, non-idempotent ingestion; no district/crop filters at query time. Planned: scheduled versioned ingestion, metadata filtering, hybrid retrieval, eval harness (see 09_AI_Architecture).

## ADR-004 — MongoDB Atlas + Mongoose as primary persistence
- **Status:** ACCEPTED · **Date:** 2025-10-23

**Problem:** Persist users, chat sessions, queries, and district context.
**Options:** MongoDB Atlas (chosen) · PostgreSQL · Firebase Firestore.
**Chosen:** MongoDB Atlas, Mongoose ODM, database `farmingDB`.
**Reason:** Fast to iterate on schema (capstone speed), JSON documents fit chat history naturally, free-tier Atlas is cost-effective.
**Tradeoffs:** Unbounded embedded `messages` array risk (16MB doc limit, load cost) — normalization planned (F-28); relational integrity requires app discipline. See 07_Database_Design.

## ADR-005 — Chat history as embedded array (current) → normalized messages (planned)
- **Status:** ACCEPTED (will be superseded) · **Date:** 2025-10-28

**Problem:** Store conversation history per session and feed last-6 messages to the model.
**Chosen (current):** `ChatSession.messages` embedded subdocuments; `slice(-6)` for context.
**Reason:** Simplest possible model; single query for a session; good for prototype.
**Tradeoffs:** Document grows unboundedly; every read loads all messages; no message-level ids. **Planned:** separate `messages` collection with pagination and stable ids (F-28) — revisit ADR.

## ADR-006 — Speech-to-text via browser Web Speech API (no server STT)
- **Status:** ACCEPTED · **Date:** 2025-10-28

**Problem:** Enable voice input cheaply.
**Options:** Server-side STT route (Google Speech) · client-side Web Speech API (chosen) · Twilio (for WhatsApp later).
**Chosen:** Client-side `react-hook-speech-to-text` (browser Web Speech API), Tamil + English.
**Reason:** Zero backend cost/latency, no new key, good-enough accuracy for the pilot.
**Tradeoffs:** Quality varies by browser/OS; Tamil coverage inconsistent on some devices; no recording storage. Revisit if pilot feedback demands server STT (tracked F-44 REJECTED today).

## ADR-007 — Weather via Open-Meteo direct from frontend (current) → backend proxy (planned)
- **Status:** ACCEPTED (will be superseded) · **Date:** 2025-10-28

**Problem:** Provide farmer-friendly current weather + forecast.
**Chosen (current):** Frontend geo-location → nearest of 38 TN districts → Open-Meteo (keyless) → formatted cards. Demo mode outside TN.
**Reason:** Instant value with no backend work or API key; weather on the login screen.
**Tradeoffs:** **The AI never receives weather context** — the product's "weather-informed" claim is currently unmet; duplicates logic client-side; no caching. **Planned:** backend weather proxy with district cache feeding the AI prompt (F-20, E2-S1) — supersede this ADR on completion.

## ADR-008 — Two repositories, backend = Product Repository
- **Status:** ACCEPTED · **Date:** 2025-10-29

**Problem:** Organize backend and frontend code.
**Options:** Monorepo (chosen initially as two folders) · separate repos (chosen).
**Chosen:** Two separate Git repos: `tn-farming-assistant` (backend) and `tn-farming-assistant-frontend`. Backend is designated the **Product Repository** and now owns all documentation (`docs/`).
**Reason:** Independent deploy cadence (backend deploys to Lambda; frontend static), clean CI boundaries, docs co-located with the code that defines the contracts.
**Tradeoffs:** Cross-repo changes (e.g., API change) need coordinated PRs; the docs hub must be kept in sync with frontend reality (status labels help).

## ADR-009 — `docs/` as the single source of truth inside the backend repo
- **Status:** ACCEPTED · **Date:** 2026-08-07

**Problem:** Product knowledge was scattered (READMEs, comments, chat history) and would be lost to a growing team.
**Options:** External wiki/Notion · `docs/` in the Product Repository (chosen).
**Chosen:** Structured `docs/` (product, architecture, engineering, business, planning, decisions) versioned with code, index in `docs/README.md`.
**Reason:** Versioned with the code it describes; PR-able; no external tool dependency; investor/new-hire onboarding artifact.
**Tradeoffs:** Docs can drift from code — mitigated by maintenance rules (hub README) and review checklist (12_Technical_Guidelines §11).

## ADR-010 — Image analysis deferred (UI-only today), Gemini Vision planned
- **Status:** ACCEPTED (will be superseded) · **Date:** 2026-01-05

**Problem:** Allow farmers to show crop problems by photo.
**Chosen (current):** Frontend image picker + preview only; image is **not sent** to backend.
**Reason:** Shipped the UI affordance within capstone scope; backend vision pipeline was out of the demo budget.
**Tradeoffs:** The feature "appears" to exist but does nothing — a demo-integrity risk (documented in 02/04). **Planned:** upload → downscale → Gemini Vision → structured diagnosis (F-22, EPIC 3).

## ADR-011 — Manual knowledge ingestion (script), scheduled versioned ingestion planned
- **Status:** ACCEPTED (will be superseded) · **Date:** 2025-10-29

**Problem:** Move S3 CSV datasets into ChromaDB.
**Chosen (current):** One-off `rag/ingest.js` run by hand; CSV → 1000/200-char chunks → Cohere → ChromaDB; chunk IDs include `Date.now()` (non-deterministic).
**Reason:** Fastest path to a working demo; no scheduler needed.
**Tradeoffs:** Stale/duplicated knowledge on re-run; no versioning/rollback; no scheduling. Planned: deterministic ids, idempotent upserts, scheduled job, versioned knowledge packs (09_AI_Architecture §3).

## ADR-012 — No automated tests (current), eval-first test strategy planned
- **Status:** ACCEPTED (will be superseded) · **Date:** 2025-10-29

**Problem:** Speed of capstone delivery vs. quality.
**Chosen (current):** No tests; `npm test` is a stub.
**Reason:** Prototype velocity; manual QA of the demo.
**Tradeoffs:** Regression risk; AI quality unmeasured; security issues unchecked (SEC-01/02 shipped). Planned: unit + integration + **AI golden-set eval** + CI gates (13_Testing_Strategy, EPIC 5).

## ADR-013 — (PROPOSED) Backend-issued session tokens with verified identity
- **Status:** PROPOSED · **Date:** 2026-08-07 · **Deciders:** Founding team (Phase 1)

**Problem:** Replace email-claim authorization and unverified JWT decoding (SEC-01/02).
**Options:**
1. Verify Cognito tokens fully on every request (signature+issuer+aud+exp) and use `cognitoSub` as the userId.
2. Verify once at login, then issue our own signed short-lived JWT + refresh (chosen direction).
3. Server-side sessions (opaque tokens in a store).
**Chosen (direction):** Option 2 — backend verifies Cognito token at `/auth/google`, creates/updates `User` with `cognitoSub`, returns a short-lived session JWT; `requireAuth` middleware verifies it; refresh endpoint issues new tokens; identity derives from token on every request.
**Reason:** Decouples backend from Cognito on each call; enables logout revocation; stable immutable identity.
**Tradeoffs:** More moving parts (refresh lifecycle, token revocation store); frontend must migrate away from `localStorage` id_token. Enables all security fixes in 15_Security §10.

## ADR-014 — Context Engine (context before generation)
- **Status:** ACCEPTED (implementation: Phase 1 first slice, Phase 2 full) · **Date:** 2026-08-07 · **Deciders:** Founding team

**Problem:** Answers today are generated from conversation memory + RAG chunks only. The system prompt declares weather/district/soil/crop context via `{{...}}` placeholders that nothing substitutes, so the product's core promise — "the platform knows your district + weather + farm without asking" — is unmet. Farmers are forced to repeat their situation, violating APP-02/APP-03.

**Options:**
1. Ask the farmer for all context manually at onboarding (profile form, district/crop pickers).
2. Continue model-direct prompting with RAG only (status quo).
3. **Context Engine:** an orchestration layer that automatically assembles nine domains — Farm Profile, Farm Location, GPS, Weather, Soil Type, Season, Crop History, Government Advisories, Agricultural Knowledge — into one context snapshot *before* every LLM invocation, degrading missing domains to explicit `"unknown"` flags rather than silently omitting them.

**Chosen:** Option 3 — the Context Engine (F-20 first slice in Phase 1; full nine-domain engine F-46 completes in Phase 2).

**Reason:** Satisfies APP-02 (zero-question: never ask what the platform can obtain/infer/remember/fetch) and APP-03 (context before generation). Removes the dead `{{...}}` placeholders (F-20). Makes the assembled context a first-class, stored, auditable artifact (`contextsnapshots`, see 07_Database_Design §7) for traceability and AI evaluation (APP-12).

**Tradeoffs:** More moving parts — per-domain resolvers, caching (weather/soil), snapshot storage, and prompt-builder integration. Upstream failures (GPS denied, advisory API down) must degrade gracefully with `"unknown"` flags and never block the answer. Holding more data increases privacy obligations (APP-10). Reference data (38 TN districts: lat/lon/soil/crops) must move server-side (E2-S2). Related: ADR-007 (superseded by the backend weather proxy), ADR-015 (Model Adapter hosts the prompt/context contract).

## ADR-015 — Model Adapter (provider-agnostic AI)
- **Status:** ACCEPTED (implementation: Phase 1) · **Date:** 2026-08-07 · **Deciders:** Founding team

**Problem:** Business logic calls Gemini directly through the vendor SDK (`ChatGoogleGenerativeAI`). The provider is not replaceable without refactoring every call site, cost/quality optimization is blocked, and product intelligence is coupled to a single vendor — contradicting APP-05 and the constitution's "intelligence belongs to Vivasayi AI, not to any single LLM provider."

**Options:**
1. Vendor SDK direct (status quo).
2. Hard fork on provider switch — rewrite all call sites per provider.
3. **Model Adapter:** a thin provider-abstraction layer exposing a uniform contract (`ask`, `stream`, `vision`, `embed`); providers selected by `MODEL_PROVIDER` config; adapters isolated from business logic.

**Chosen:** Option 3 — the Model Adapter (F-45, Phase 1).

**Reason:** Swapping Gemini → Llama/Qwen/Mistral/self-hosted becomes a config change with zero service-layer code changes (APP-05). Enables measured provider switching — every swap must pass the same AI eval gates (APP-12, 13_Testing_Strategy §4). Keeps embeddings swappable too (Cohere today). Protects the data moat: the knowledge base, prompts, and context remain owned by Vivasayi AI.

**Tradeoffs:** Abstraction cost — the contract must be designed and enforced (no vendor SDK imports in services, see 12_Technical_Guidelines §2b); each new provider needs an adapter plus provider-parity eval coverage; latency/feature parity must be verified per provider. The Gemini choice from ADR-003 remains but becomes the default adapter config, not the only option.

## ADR-016 — Farm Memory (long-term farm intelligence)
- **Status:** ACCEPTED (implementation: Phase 2) · **Date:** 2026-08-07 · **Deciders:** Founding team

**Problem:** Memory is session-only (last 6 messages). When a session ends, the farmer's farm context is lost; the farmer must restate their situation every time; and one-off answers do not compound into better advice. APP-04 is unmet.

**Options:**
1. No cross-session memory (status quo).
2. Client-side/local memory on the device only.
3. **Farm Memory:** a persistent, structured store of the farm — profile, plots, crop history, past decisions, outcomes, follow-ups — in MongoDB, surfaced into every conversation across sessions, seasons, and channels.

**Chosen:** Option 3 — Farm Memory (F-47, Phase 2).

**Reason:** Turns one-off answers into compounding intelligence and the data moat; enables zero-question re-entry across seasons (APP-02/04); a follow-up after two months is answered in the context of last season's decisions. Consistent with the decision-platform identity (APP-01).

**Tradeoffs:** Holds substantially more PII (crops, plots, decisions, outcomes) — requires the consent/minimization/retention framework (APP-10, SEC-13, DPDP readiness in 15_Security §6). Memory must be editable and correctable by the farmer. Depends on the farm profile (F-21) and is surfaced through the Context Engine (F-46). Related: ADR-014.

## ADR-017 — AI Diagnosis Pipeline (image + context fusion)
- **Status:** ACCEPTED (implementation: Phase 1) · **Date:** 2026-08-07 · **Deciders:** Founding team

**Problem:** Images can be selected and previewed in the UI but are dropped before the API call; the backend has no image endpoint; the "show us your crop" promise is unmet. Analyzing an image in isolation risks misdiagnosis — a photo of a leaf cannot be interpreted without weather, soil, crop, and location context (APP-07).

**Options:**
1. Vision-only diagnosis (image → model → answer) with no assembled context.
2. Generic chat-image passthrough (image treated as an unattached attachment in the chat flow).
3. **AI diagnosis pipeline:** upload → resize/validate → vision analysis **fused with the Context Engine snapshot** (weather, soil, crop, location, season) → structured diagnosis card (cause → treatment → safety → escalation) rendered in the UI and stored with the message.

**Chosen:** Option 3 — the AI diagnosis pipeline (F-22, Phase 1).

**Reason:** Context fusion prevents isolated-image misdiagnosis (APP-07); the structured card is more actionable than prose (APP-01); the escalation branch enables human-in-the-loop for high-stakes cases (APP-13); images enter a diagnosis pipeline, not a photo viewer.

**Tradeoffs:** More pipeline stages — storage/signed URLs (E3-S1), downscale/validation, vision via the Model Adapter, context fusion, card rendering (E3-S4). Diagnosis quality depends on Context Engine maturity (F-46) and AI eval coverage. Images may contain faces/locations — requires upload consent and retention policy (APP-10). Related: ADR-014, ADR-015.

---

## ADR-018 — Ownership scoping by cognitoSub (SEC-02 remediation)
- **Status:** ACCEPTED (implementation: E1-S5, D-35 Option 1) · **Date:** 2026-08-30 · **Deciders:** Founding team + Product Owner

**Problem:** SEC-02 (OWASP A01 Broken Access Control) — identity and resource ownership were keyed by a **client-supplied `userEmail`** in request bodies/query/path. Any authenticated user could read/list/modify/delete another user's chat sessions and farm profile by supplying that user's email (IDOR).

**Options (D-35):**
1. **`requireAuth` + ownership scoping** — `{ _id, user: req.user.id }` everywhere; foreign resources return **404**; identity from token only; reserved `role` field for future admin, no role logic in Phase 1.
2. Option 1 + roles (admin).
3. Fine-grained policy engine (ABAC).

**Chosen:** Option 1. Ownership is derived **only from the verified session token** (`req.user.id` = the stable, immutable `cognitoSub` from ADR-013); every chat-session/profile query/update/delete is scoped by `cognitoSub`; foreign/unowned resources return **404** (not 403, to avoid resource-existence disclosure). A reserved `role` claim exists on the user context but is unused in Phase 1.

**Reason:** Fixes SEC-02 with minimal code; `cognitoSub` is non-spoofable (unlike email); 404-for-foreign matches 12_Technical_Guidelines §5 and avoids existence disclosure; no admin surface exists until Phase 3+ so no role logic is wired yet.

**Data/legacy:** `chatsessions` and `profiles` gain a `cognitoSub` ownership key (indexed; unique+sparse on profiles for 1:1). `userEmail` is **retained as a display/legacy dual-key** (set server-side only). Existing email-keyed rows are **backfilled** from the `users` collection (`User.email → User.cognitoSub`) via `scripts/backfillOwnership.js` (idempotent; per 07_Database_Design §8 migration note); rows with no known user mapping are re-keyed on the user's next login.

**Tradeoffs:** Breaking API contract — client-supplied `userEmail` is removed from `/chat`, `/chatsessions/*`, `/profile/*` (identity from token only); legacy pre-backfill rows are unscoped until backfill/login. Related: ADR-013 (cognitoSub identity), D-34 (token transport), SEC-02.

---

## ADR-019 — AI-Driven Agricultural Loss / Affected-Area Claim Verification
- **Status:** ACCEPTED (Domain & MVP scope; implementation Phase 1) · **Date:** 2026-09-20 · **Deciders:** Founding team + Product Owner

**Problem:** The product must verify farmer-reported agricultural loss / affected-area claims (e.g., crop loss from weather/insects) with trust, determinism, and no human bottleneck, while keeping AI exactly inside — not beyond — its safe boundary. Ten decision points (P1–P10 below) were mandated and are frozen for Phase 1 scope.

### Approved decisions (P1–P10)

**P1 — Parcels & claim binding.**
FarmProfile supports **multiple parcels**; every claim binds to **exactly one `parcelId`**. Geometry is farmer-drawn on the parcel; the system **never fabricates geometry** (no district-centroid polygons, no GPS-derived shapes). Claims without a configured parcel are **not** permitted.

**P2 — Claim window.**
Claimable loss window = **30 days** default before submission, configurable (`CLAIM_WINDOW_DAYS`). The window is **backend-authoritative** — clients never compute eligibility. Future-dated event dates are rejected.

**P3 — Weather as supporting evidence only.**
Weather (Open-Meteo) is gathered as **supporting context** for the claim record. There are **no hard weather thresholds** (e.g., "rain ≥ 50 mm ⇒ reject") in Phase 1; the **absence of weather data must never cause a rejection** (it may only reduce confidence). Any future thresholds are added as **configurable** rules, never hardcoded, and require a new ADR.

**P4 — No AI-derived acreage.**
AI is **prohibited** from estimating area, remaining/approved area, or compensation. Area comes **only** from backend geometric computation on the authoritative parcel/claim polygon (Turf.js / geojson-area). Insufficient evidence ⇒ `MORE_EVIDENCE_REQUIRED`, never an AI guess.

**P5 — Overlap policy.**
Overlapping-claims detection uses a **configurable geometric tolerance/epsilon** (contract-style, avoiding floating-point false positives). Outcomes are distinguished: **(a) no overlap**, **(b) overlaps a verified claim**, **(c) overlaps a draft/in-flight claim** — each maps to a different verification result.

**P6 — Resubmission.**
Resubmission is allowed **only from `MORE_EVIDENCE_REQUIRED`** → `submitted` → `processing`. Limits/cooldowns are **configurable**. Terminal states (`verified`, `rejected`, `out_of_limit`, `duplicate_area`, `withdrawn`) cannot be resubmitted.

**P7 — Admin is exception-only.**
Normal verification is **fully automated** (geometry + AI evidence + deterministic rules). Admin review is a deferred, **exception-only** UI (Phase 10 backlog); admin identity reuses existing `requireRole('admin')`.

**P8 — Maps: free stack.**
Browser maps = **MapLibre GL + free OSM tiles** (no Google Maps / Mapbox). Tile source is **isolated in config** for future swapping. No map in Phase 1 (claim UI is Phase 1; map drawing is subsequent within the claim epic).

**P9 — Evidence = images only (MVP).**
Only raster images (JPEG/PNG/WEBP) in the MVP. No PDF/OCR/scan parsing. Evidence upload reuses the **existing private S3 presigned pipeline** (owner-scoped keys, EXIF stripped).

**P10 — No auto-created parcels.**
Parcels are **never auto-created** from survey/district data. Legacy users must **configure a parcel before claiming**; migration is **additive** (new fields/collections only; nothing removed).

### Frozen boundaries (must not be overridden)

- **AI may output:** `cropDetected`, `damageDetected`, `damageType`, `severity`, `visibleAffectedPortion`, `confidence`, `uncertain`, `inconsistencies`, `observations`, `imageQuality`.
- **AI must NOT output:** `acreage`, `polygon`, `parcel boundary`, `remaining/approved area`, `compensation`, `final status`.
- **Claim states (frozen):** `draft`, `submitted`, `processing`, `verified`, `partially_verified`, `more_evidence_required`, `rejected`, `out_of_limit`, `duplicate_area`, `withdrawn`.
- **Evidence mutation allowed only in:** `draft | submitted | more_evidence_required`.
- **Idempotency:** claim creation/submission requires a DB-enforced unique `idempotencyKey`.
- **Frontend modules (frozen for later phases):** `api/claims.ts`, `api/types/claim.ts`, `components/ClaimWizard.tsx`, `ClaimMapDraw.tsx`, `ClaimStatusCard.tsx`, `ClaimEvidenceGallery.tsx`, `services/mapDraw.ts`, `claimFlow.ts`, `i18n/claim.ts`, `pages/ClaimsPage.tsx` — the claim feature is part of the product UI, not the chatbot.

**Options considered:**
1. Manual/paper-based loss assessment with human inspectors only.
2. Pure ML "AI approves/rejects + AI computes acreage" end-to-end.
3. **Hybrid deterministic pipeline (chosen):** backend-authoritative geometry + AI structured observation (bounded) + deterministic rule engine + configurable policies + append-only audit.

**Chosen:** Option 3 — the Claim Verification Engine (see 06_System_Architecture §9, 07_Database_Design collections `lossclaims`/`claimevidence`/`claimassessment`/`claimaudit`, 08_API_Documentation item 10).

**Reason:** Deterministic geometry + rules give **auditable, explainable, court-defensible** outcomes (no black-box acreage); the bounded AI observation adds scalable damage evidence without delegating money/staking decisions to a model; all policy knobs are config vars, not code; idempotency + audit protect against double-claims and fraud.

**Tradeoffs:** Requires a **parcel foundation** first (no claims until geometry exists — P10); legitimate unverified claims may be flagged for more evidence (P4) with a slower path; maps (P8) are free-tier which trades polish for zero cost; admin override is deliberately deferred (P7), so edge cases wait on the Phase-10 UI. Related: ADR-017 (vision pipeline reused for claim evidence), ADR-013/018 (ownership by `cognitoSub`), SEC-14…18 (07_Database_Design + 15_Security).

### Phase 2 implementation note (E9-S2, ADR-019)

Implemented additive (07_Database_Design §14 rule 1 — nothing removed, no existing collection altered): new `lossclaims` / `claimevidence` / `claimassessment` (structure only, never written) / `claimaudit` collections with the documented indexes (incl. owner-scoped compound-sparse unique `{ cognitoSub, idempotencyKey }` and the partial unique verified-claims guard). `claimState.service.js` is the single source of truth for the 10-state machine; only `draft → submitted` exists as a farmer submit path (no simulated processing), with `withdrawn`/`resubmitted` transitions and configurable P6 limits that are already enforced. Explicitly deferred per the frozen boundaries: AI/weather correlation, pHash dedup, overlap/remaining-eligibility (P5), `POST /claims/calculate-area`, admin endpoints (P7), and any draft-`PATCH` endpoint (the finalized 08 §10 contract defines none). 58-scenario integration suite + 9 state-machine unit tests pass alongside the Phase 1 suite (108 tests).

### Phase 3 implementation note (claim evidence + assessment foundation, ADR-019)

No new decision: Phase 3 hardened the Phase 2 evidence layer **additively on the same frozen rules**, with no new public contract. Additions: (1) every evidence mutation (`presign` / `complete` / `delete`) now appends an append-only `ClaimAudit` row (`evidence_presigned` / `evidence_completed` / `evidence_deleted`, actor `farmer`, `requestId`); (2) `complete` is atomic + idempotent via a status CAS (`pending → processing`) — one record per upload, repeated completes return stored metadata, a missing S3 object keeps the record retryable; (3) a 17-scenario hardening suite (`tests/claims.evidence.test.js`) proving the IDOR/ownership/validation/state/rate-limit/idempotency guarantees on the unchanged contract. Boundary restated and enforced: no AI/vision/weather/RAG, no pHash/fraud scoring, no `claimassessment` writes, no acreage from images (P4), and submit remains **explicitly evidence-optional** per the finalized 08 §10 contract (a client `evidenceUploaded` flag is never trusted — evidence status is server-derived from persisted `ClaimEvidence` rows). Full suite: **125 tests** — 10 parcel geometry + 31 parcel API + 9 state machine + 58 claims API + 17 evidence hardening.

---

## Decision log conventions

- New decisions: create a new ADR entry, update this file, and link it from affected docs.
- Reversals: mark the old ADR `SUPERSEDED` and cite the new ADR.
- Reference ADRs in commits/PRs that implement them (e.g., `security: verified JWT (ADR-013)`).
