# 13 — Testing Strategy

> **Metadata**
> - **Title:** 13 — Testing Strategy
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** QA / Engineering
> - **Last Reviewed:** 2026-10-17 (§0 added; §1-§10 are the August 2026 plan)
> - **Related Documents:** [10_User_Flows](../product/10_User_Flows.md) · [09_AI_Architecture](../architecture/09_AI_Architecture.md) · [12_Technical_Guidelines](12_Technical_Guidelines.md) · [14_Deployment](14_Deployment.md) · [15_Security](15_Security.md)

> **Why this document exists:** When this was written (August 2026) there were **zero automated tests** (`npm test` errored out); §0 describes the suites that exist now. The product's credibility depends on answer accuracy and security. This document defines the test strategy across the stack — including how to test an AI system, which is unusual — so quality is built, not retrofitted.

---

## 0. Current state (2026-10-17)

The test suites below exist and pass. **All of them run with an in-memory or loopback MongoDB and mocked or fake providers.** A pass shows the code behaves as specified (automated-test verified); it does not show that Gemini, Copernicus, Cognito or S3 work live, or that decisions are accurate on real claims. Live status is in [LIVE_PROVIDER_REQUIREMENTS.md](LIVE_PROVIDER_REQUIREMENTS.md) and [ACCEPTANCE_MATRIX_2026-10-17.md](ACCEPTANCE_MATRIX_2026-10-17.md).

### 0.1 Levels and commands

| Level | Where | Command | Notes |
|---|---|---|---|
| Backend unit and integration | `tests/` (81 test files) | `npm test` (`vitest run`) | mongodb-memory-server; supertest against the real Express app; providers mocked or faked. Child-process tests kill a real worker (`tests/worker.crashRecovery.test.js`) |
| Backend syntax | every `.js` file | part of `npm run acceptance` (`node --check`) | The backend has no lint or build step; both are recorded as N/A |
| Frontend unit and component | `VivasayiAI-Frontend/src/**/*.test.ts(x)` | `npm test` in the frontend | jsdom, Testing Library |
| Frontend static | | `npm run typecheck`, `npm run lint`, `npm run build`, `npm run contract:check` | `contract:check` compares the progress-contract copy with the backend's |
| End to end | `VivasayiAI-Frontend/e2e/` | `npm run e2e` in the frontend (`npm run e2e:install` once) | Playwright 1.63.0, desktop and mobile Chromium, against the hermetic backend harness (below). See the frontend's [`e2e/README.md`](../../../VivasayiAI-Frontend/e2e/README.md) |
| Synthetic benchmarks | `scripts/eval/` | `npm run eval` | Deterministic; results in `docs/research/evaluation/results/` |
| Research integrity | | `npm run manuscript:numbers`; frozen-hash check in the acceptance run | Every manuscript number is generated; the 16 October live outputs are pinned by SHA-256 |
| Live provider scripts | `scripts/live/` | run by hand, never in CI or the acceptance run | Write-once outputs; Gemini scripts BLOCKED until a billed key (D6) |

### 0.2 Hermetic e2e harness (ADR-024)

`npm run e2e:backend` (`scripts/e2e/hermeticBackend.js`) starts the real API and verification worker on a throw-away MongoDB with: the committed `scripts/e2e/e2e.env` (never `.env`); a fake Gemini that recognises the real prompts and plays scenarios from `scripts/e2e/scenarios.json`; mock storage, land records, weather and satellite; a loopback-only network guard that blocks and records every other connection; and a token-protected control server (sessions, scenarios, pause or kill the worker, read-only inspection). It refuses production, Lambda, live credentials and non-loopback databases. Playwright starts two harnesses (worker inline, and worker as a separate process for the crash test) and Vite, and fails any test with a network violation.

### 0.3 Acceptance runner and report

`npm run acceptance && npm run acceptance:report` (`scripts/acceptance/runAll.js`, `report.js`) runs, in order: backend vitest, the backend `node --check` sweep, frontend typecheck, lint and build, frontend vitest, Playwright, the manuscript-numbers check and the frozen-hash check, with blank live credentials and `VIVASAYI_SKIP_DOTENV=1`. It records both repositories' git state at the start and end. The report maps tests to the 24 scenarios S01-S24 (`scripts/acceptance/matrix.json`) and to acceptance items (`acceptanceItems.json`), separates code defects from external blockers (`triage.json`), and writes:

- `test-results/acceptance/results-<runId>.json` (schema `vivasayi-test-results/v1`, `scripts/acceptance/results.schema.json`);
- `test-results/acceptance/REPORT-<runId>.md`.

Tests are matched to scenarios by an ID prefix in their title (`EQ-1: ...`). 789 tests have no prefix and 64 IDs are shared by more than one test (see [KNOWN_ISSUES.md](KNOWN_ISSUES.md) K-42).

### 0.4 Latest results

| Suite | Result | Source |
|---|---|---|
| Backend vitest | 1,133 of 1,133 in the run; **1,135 of 1,135** on the final tree after two audit gaps were closed | run `20261016T205016Z-6dbe6b8`; audit A re-run (`test-results/audit/A.json`) |
| Frontend vitest | 726 of 726 | same run |
| Playwright | 90 of 90 (45 desktop, 45 mobile), 0 flaky, 0 network violations, 21.9 min; re-run on the final tree 90 of 90 (21.4 min, exit 0) | same run; `test-results/audit/final-e2e.log` |
| Frontend typecheck, lint, build; backend `node --check` (273 files) | passed | same run |
| Manuscript numbers; frozen hashes (8 files) | passed (1 warning: source ledger unconfirmed) | same run |
| **Total** | **1,949 of 1,949** in the run; 24 of 24 scenarios | [REPORT-20261016T205016Z-6dbe6b8.md](../../test-results/acceptance/REPORT-20261016T205016Z-6dbe6b8.md) |

An independent audit (A: runner and code tracer; B: security, hermeticity and research integrity; C: mutation testing) checked the run; its findings are in [ACCEPTANCE_MATRIX_2026-10-17.md](ACCEPTANCE_MATRIX_2026-10-17.md).

### 0.5 CI

`.github/workflows/deploy-lambda.yml` runs `npx vitest run` on pushes to `main` and on pull requests to `main` and `develop`; the deploy job needs it. Frontend tests, Playwright and the acceptance run are **not** in CI, and the frontend repository has no CI.

## 1. Test pyramid (target)

```mermaid
flowchart TD
    A[AI Evaluation & Golden Set<br/>answer quality, regressions] --> B
    B[Integration tests<br/>API + DB + external stubs] --> C
    C[Unit tests<br/>pure logic, controllers, services, utils] --> D
    D[Manual & exploratory<br/>real devices, real networks, real users]
```

Priority order for a startup: **AI eval + security/integration first** (they protect the core value), then unit coverage, then polish.

## 2. Unit testing

**Goal:** fast, deterministic verification of pure logic.

| Area | What to test | Tooling (planned) |
|---|---|---|
| Backend utils | `ApiError`, `ApiResponse`, `asyncHandler` (sanitized errors), env config validation | Vitest |
| Backend services | prompt assembly, context/weather merge, session title logic, message appending | Vitest |
| **Model Adapter** | contract tests per adapter (`ask`/`stream`/`vision`/`embed` return the contract shape); provider fakes; `MODEL_PROVIDER` selection; no service-layer vendor SDK imports (ADR-015, APP-05) | Vitest + fakes |
| **Context Engine** | per-domain resolvers (profile, GPS, weather, soil, season, history, advisories, RAG); missing-domain → `"unknown"` fallback; snapshot assembly + storage; zero-question guard (a UI-asked field must have no auto-resolver) (ADR-014, APP-02/03) | Vitest + mocks |
| **Farm Memory** | read/write memory entries; outcome capture; memory surfaced into context (ADR-016, APP-04) | Vitest |
| Frontend helpers | `farmerWeatherService` formatting (weather-code → text/icons, soil moisture thresholds, district matching, demo-mode logic), i18n key parity | Vitest |
| Frontend components | `MessageBubble` (timestamp, image/audio branches), `VoiceRecorder` (state), `ChatInterface` (state transitions with mocked `api.ts`) | Vitest + React Testing Library |

**Mocking rules:** mock network/DB/AI at their boundaries; never mock the thing under test. Keep tests free of real API keys.

## 3. Integration testing

**Goal:** prove the API contract end-to-end against a real (or in-memory) DB with external services stubbed.

- **Backend:** Vitest + Supertest against the Express app; `mongodb-memory-server` for Mongo; stub Cohere/ChromaDB/Gemini/Cognito with in-memory fakes or `nock`.
- **Cover at least:**
  - Auth: `/auth/google` success + failure; token verification (post-F-19).
  - Chat: new session, follow-up with context, missing fields, model failure fallback (RAG-off path), 500/400 handling.
  - Sessions CRUD: create/list/get/append/delete/clear; **cross-user isolation negative tests** (user B must not read/delete user A's sessions) — the key security test.
  - Context Engine (post-F-46): each domain resolves; a domain's upstream failure → `"unknown"` flag, answer still produced; snapshot persisted.
  - Model Adapter (post-F-45): request through `MODEL_PROVIDER=gemini` vs a fake provider yields identical service behavior (provider-parity test).
  - Weather proxy (post-F-20): caching, upstream failure fallback.
- **Frontend:** mock the API layer; test flows per [10_User_Flows.md](../product/10_User_Flows.md) mapping table.

## 4. AI testing (critical & unique)

The LLM is non-deterministic; test it with an **evaluation harness**, not assertions.

### 4.1 Golden evaluation set
- 50-100 curated (question, expected-answer-rubric) pairs across: pests/diseases, fertilizers, irrigation, crop selection, seasons, Tamil-only, English, Tanglish, follow-up-with-context, off-topic, unsafe.
- Each case scored by rubric dimensions:
  - **Groundedness** (does not invent facts/schemes/prices),
  - **Relevance** (answers the question),
  - **Actionability** (gives concrete steps),
  - **Language** (correct Tamil/English, no English jargon in Tamil mode),
  - **Safety** (defers to officer when uncertain; refuses out-of-scope),
  - **Context-awareness** (post-Context Engine: uses the assembled farm/weather/soil context when the rubric says it should — APP-03).
- Threshold (Phase 1): ≥80% acceptable across the set; **no** critical groundedness failures.
- **Provider parity:** each golden case is scored against every active Model Adapter; a provider swap must not regress the set (APP-05/12).

### 4.2 Eval workflow
1. Prompt/model change → run golden set (CI, nightly).
2. Regression detected → block merge (or document accepted regression + rationale in CHANGELOG).
3. Human-in-the-loop: flagged by thumbs-down + manual weekly review of a random sample.
4. Golden set grows from real missed queries (feedback loop into knowledge pipeline).

### 4.3 Cost/perf tests
- Assert p75 latency and estimated $/conversation stay under budget (alert on drift). This is a testable contract (see 14_Deployment, 15_Security).

## 5. Manual testing

- **Smoke runbook** (per release): login → language → chat (Tamil + English) → voice → image (once implemented) → weather → history → logout.
- **Device matrix:** 2 Android devices (low-end + mid), 1 iPhone, desktop Chrome; 3G/4G throttle; mobile data + Wi-Fi.
- **Language matrix:** Tamil-only user, Tanglish user, English user.
- Track manual checks as a checklist in the release PR (no separate tooling until scale demands it).

## 6. Regression testing

- CI: lint → typecheck → unit → integration on every PR.
- AI regression: golden set on every prompt/model change (nightly cron).
- Security regression: auth bypass + cross-user isolation tests run on every change to auth/session code.
- Manual smoke before every release to staging.

## 7. Performance testing

- **Chat latency:** p50/p95 from first token (streaming, Phase 1) and total response; budget: first token <2s, total <8s p75.
- **Cold start:** Lambda cold-start p95 <3s (or move to provisioned concurrency if violated).
- **DB:** session listing with 100/1000 sessions; message pagination (post-F-28).
- **Load:** 50 concurrent chat requests against staging with stubbed AI to test rate limits + queue behavior.
- **Client:** Lighthouse mobile score ≥80; bundle budget (Vite build size tracking).

## 8. Test data & environments

- Unit/integration: `mongodb-memory-server` + fakes. No live keys.
- Staging: full stack with **real but rate-limited** AI providers + real Mongo (sanitized).
- Production: never run tests against prod; use synthetic users in staging only.

## 9. CI pipeline (planned; the CI that exists today is in §0.5)

```mermaid
flowchart LR
    A[push PR] --> B[eslint + typecheck]
    B --> C[unit tests]
    C --> D[integration tests]
    D --> E[AI golden set*]
    E --> F[provider parity test*]
    F --> G[build + bundle check]
    G --> H[deploy staging]
    H --> I[smoke runbook]
    I --> J[deploy prod via tag]
```
`*AI golden set` = nightly + on prompt/model/context changes; always on `main`. `*provider parity` = golden set scored on every active provider adapter.

## 10. Coverage targets (by Phase 1)

- Backend unit/integration: ≥60% lines on services/controllers/middleware; **100%** on auth middleware + session authorization.
- Frontend: ≥50% on services and critical components (ChatInterface, MessageBubble).
- AI golden set: 50+ cases, threshold ≥80% acceptable, 0 critical groundedness failures.
- Security negatives: auth bypass, cross-user read/delete/clear — must pass 100%.
