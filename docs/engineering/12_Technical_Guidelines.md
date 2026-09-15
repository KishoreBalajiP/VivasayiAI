# 12 — Technical Guidelines

> **Metadata**
> - **Title:** 12 — Technical Guidelines
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Engineering
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [06_System_Architecture](../architecture/06_System_Architecture.md) · [08_API_Documentation](../architecture/08_API_Documentation.md) · [09_AI_Architecture](../architecture/09_AI_Architecture.md) · [13_Testing_Strategy](13_Testing_Strategy.md) · [14_Deployment](14_Deployment.md) · [15_Security](15_Security.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** The contract for how every engineer writes, organizes, and ships code in this repository. Consistency here makes the codebase maintainable as the team grows from 1 to N. Where the codebase deviates today, the guideline states the **target** and the migration path.

---

## 1. Repository layout

```
tn-farming-assistant/                 ← PRODUCT REPOSITORY (backend + docs)
├── docs/                             ← all documentation (see docs/README.md)
├── .github/workflows/                ← CI/CD
├── config/                           ← db connection, (vectorstore planned)
├── controllers/                      ← HTTP layer
├── models/                           ← Mongoose schemas
├── routes/                           ← Express routers
├── rag/                              ← knowledge ingestion
├── utils/                            ← shared helpers
├── index.js                          ← app entry
├── Dockerfile
└── package.json

tn-farming-assistant-frontend/        ← FRONTEND REPOSITORY (code only)
├── src/
│   ├── components/
│   ├── context/
│   ├── services/
│   ├── config/
│   ├── api.ts, types.ts, i18n.ts, App.tsx, main.tsx
└── …vite/tailwind config
```

## 2. Target folder structure (backend, Phase 1)

```
src/
├── app.js                     # express app assembly (testable, no side effects)
├── server.js                  # bootstrap: env, db, listen (or lambda handler)
├── config/                    # env validation, db, vectorstore, weather cache
├── routes/                    # thin routers → controllers
├── controllers/               # request/response handling
├── services/                  # business logic (chat, contextEngine, farmMemory, profile)
├── ai/
│   ├── adapters/              # MODEL ADAPTERS: interface + gemini.ts (+ llama/qwen/mistral later)
│   ├── context/               # CONTEXT ENGINE: domain resolvers + snapshot assembly
│   ├── prompts/               # versioned prompt templates
│   ├── rag/                   # retrieval + ingestion
│   └── eval/                  # golden-set harness
├── models/                    # mongoose schemas (+ farmmemory, contextsnapshot)
├── middlewares/               # auth, rate-limit, error, validate
├── utils/                     # apiResponse, errors, logger
└── tests/                     # unit + integration + ai eval
```

## 2b. Model Adapter standard (APP-05 — binding)

- All model access — chat, streaming, vision, embeddings — goes through the adapter layer in `ai/adapters/`. **Business logic and services must never import a vendor SDK** (`ChatGoogleGenerativeAI`, etc.).
- Uniform contract per adapter: `ask`, `stream`, `vision`, `embed`.
- Provider selected by `MODEL_PROVIDER` (env), model by `MODEL_NAME`; see 14_Deployment §4 and ADR-015.
- Adapters are thin and testable against a contract; swapping providers must not change service code.

## 2c. Context Engine standard (APP-02/03 — binding)

- Context assembly lives in `ai/context/` and runs **before** every LLM invocation.
- Each domain (profile, location, GPS, weather, soil, season, history, advisories, RAG) is a small resolver returning `{ value | unknown }`; the orchestrator merges into a snapshot and hands it to the prompt builder.
- Never ask the farmer for a field a resolver can auto-obtain/infer/remember/fetch (APP-02); any new UI question needs that justification in the PR description.
- Snapshots are stored (`contextsnapshots`) for traceability + eval (ADR-014).

## 3. Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Files (backend) | `kebab-case.js` (current), target `camelCase.js` under `src/` | `chat.controller.js` |
| Files (frontend) | `PascalCase.tsx` for components, `camelCase.ts` for modules | `ChatInterface.tsx`, `api.ts` |
| Classes/Components | `PascalCase` | `ChatGoogleGenerativeAI` |
| Functions/vars | `camelCase` | `sendChatMessage` |
| Constants/Env | `SCREAMING_SNAKE_CASE` | `CHROMA_API_KEY` |
| Mongo collections | lowercase plural | `chatsessions` |
| Routes | lowercase, nested resources | `/chatsessions/:id/message` |
| Git branches | `feat/…`, `fix/…`, `chore/…`, `docs/…` | `feat/verified-auth` |

## 4. Coding standards

### Backend (Node 20+ locally, ESM)
- Development targets Node 20+; the Lambda runtime uses the **Node 24** base image (`Dockerfile`, see [14_Deployment §1](14_Deployment.md)). Code must be compatible with both.
- Use `import`/`export` (project is `"type": "module"`). No `require`.
- **Controllers:** no business logic outside services (target). Controllers call `service` methods, wrap in `asyncHandler`.
- **AI:** model calls only via the Model Adapter (§2b); context only via the Context Engine (§2c). Never call a vendor SDK from a controller/service.
- **Errors:** throw `ApiError` (with `statusCode`); never leak stack traces/causes to clients (`asyncHandler` → `errorHandler` sanitizes — E1-S6).
- **Env access:** read env at module top via a validated `config` module; no magic strings. Add `.env.example`.
- **Async:** always `try/catch` or `asyncHandler`; no unhandled rejections. Avoid top-level side effects at import time (Lambda cold-start concern).
- **PII/logging:** never log emails, tokens, full messages, or precise GPS coordinates verbatim; log message lengths/hashes.
- **Secrets:** never in code, never in git, never in logs. Use env/secret manager (Phase 1). Per-provider keys are held by the adapter's config, never in service code.

### Frontend (React + TS)
- **Types:** strict TS is on. No `any` (3 remain today — eliminate). Prefer generated API types from the API spec.
- **API calls:** go through `api.ts` (typed client) — do not scatter raw `fetch` in components (several exist today; migrate).
- **State:** local state + React Context (auth). Introduce a data-fetching layer (TanStack Query) in Phase 1 for caching/pagination.
- **i18n:** all user-facing strings via `useTranslation`/`t()`. Keep `en`/`ta` dictionaries in sync in the same PR.
- **Styling:** Tailwind utility classes; no inline `style` except dynamic values; tokenize theme colors (Phase 1).
- **Components:** small, single-purpose; props typed; no prop-drilling beyond one level (use context where shared).

### General
- No dead code: remove unused imports/exports on sight.
- Comments explain **why**, not **what**; prefer self-documenting names. (Existing file has minimal comments — keep it that way.)
- No `console.log` in production paths — use the logger (structured, pino in Phase 1).

## 5. API standards

- Base path `/api/v1` (target, Phase 1); versioning in the URL.
- Resource-oriented REST: `POST /sessions`, `GET /sessions/:id`, etc. Consolidate `/chat/*` and `/chatsessions/*` duplication (F-18).
- Uniform envelope (current `ApiResponse` is fine) — one success shape, one error shape.
- Errors: use correct status codes (`400` validation, `401` unauth, `403` forbidden, `404` not found, `429` rate-limit, `5xx` server).
- Validation: on the boundary (express-validator/zod in Phase 1), both for body and query params.
- Auth: `Authorization: Bearer <jwt>`; identity from token, never from body/query (Phase 1, F-19).
- OpenAPI 3.1 spec generated from code; `docs/architecture/08_API_Documentation.md` mirrors it.

## 6. Error handling

- Domain errors → `ApiError(statusCode, message)` thrown in services.
- `asyncHandler` catches → `next(err)` → `errorHandler` maps to a safe envelope `{ statusCode, message, data:{} }`; `cause`/stack are stripped from client responses (logged server-side only) — E1-S6.
- Unknown errors → log full detail server-side, return generic `500` `"Internal server error"`.
- Frontend: every `fetch`/`api` call has error + empty + loading states (many present; standardize).

## 7. Logging

- Current: `utils/logentries.js` (file append) — **unused and unsuitable for Lambda**.
- Target: structured JSON logs (pino) → CloudWatch/OTel; request-id correlation.
- Log events: auth, chat latency breakdown (embed, retrieve, generate), errors, cost markers. Never log raw PII.

## 8. Security (engineering view — full doc: 15_Security.md)

- `requireAuth` middleware on all routes except auth/health (Phase 1).
- Rate limit auth + chat; cap input sizes (E1-S8/S9); strict CORS allow-list + 1MB body limit (done — E1-S7).
- Secrets rotated + moved to managed store; `.env.example` committed, `.env` ignored (already ignored — verify).
- No PII in URLs (replace `/chatsessions/list/:email`).

## 9. Git strategy

- **Branches:** trunk-based with short-lived branches: `feat/<name>`, `fix/<name>`, `chore/<name>`, `docs/<name>`. Merge to `main` via PR.
- **Never** push directly to `main` (today's workflow auto-deploys `main` — change to deploy from release tag or a `release` branch).
- **History hygiene:** meaningful commit messages (Conventional Commits), no "check"/"initial commit" noise; squash-and-merge feature branches.

## 10. Commit rules

Conventional Commits format:

```
<type>(<scope>): <subject>

<optional body>
```

| Type | Use for |
|---|---|
| `feat` | new feature |
| `fix` | bug fix |
| `docs` | documentation (incl. this system) |
| `refactor` | behavior-preserving change |
| `test` | tests |
| `chore` | tooling, CI, deps |
| `security` | security fix (must reference ADR/issue) |

Rules:
1. One logical change per commit.
2. Subject ≤ 72 chars, imperative mood ("Add verified JWT auth").
3. Reference ticket/ADR where relevant (`#12`, `ADR-002`).
4. Update `docs/planning/19_CHANGELOG.md` on release, not per commit.
5. No secrets, no machine-generated files (`.DS_Store`, `package-lock` changes unrelated to intent).

## 11. Code review checklist

- [ ] Follows naming + structure conventions.
- [ ] No `any`, no `console.log`, no dead code.
- [ ] Error handling + user-visible error states present.
- [ ] Security: no user-controlled identity, input validated, no secrets.
- [ ] **AI:** model calls via Model Adapter only (no vendor SDK in business logic); context via Context Engine only; no new farmer-facing question without an APP-02 justification.
- [ ] i18n keys added for both `en` and `ta`.
- [ ] Tests written/updated (see 13_Testing_Strategy); adapter contract + Context Engine resolver tests included.
- [ ] API changes reflected in 08_API_Documentation + OpenAPI spec.
- [ ] Decisions that changed the design recorded in 18_DECISIONS.md and linked to AI_Product_Principles (APP-IDs).
