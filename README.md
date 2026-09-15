# Vivasayi AI

**Tamil-first AI Agriculture Decision Platform for Tamil Nadu's farmers.**

> **Status:** `[EXISTING]` — conversational assistant prototype. The Decision Platform pillars
> (Context Engine, Model Adapter, Farm Memory, context-fused image diagnosis) are **planned or future**,
> not yet implemented. Nothing below is presented as shipped unless it carries an `[EXISTING]` label.

Vivasayi AI is a bilingual (Tamil + English) AI agriculture assistant. The product vision — see
[PRODUCT_PRINCIPLES.md](docs/product/PRODUCT_PRINCIPLES.md) — is a **Decision Platform, not a chatbot**:
every interaction should end in a decision-support outcome (recommendation, diagnosis, plan, alert, or
sourced answer). Today the product is a working **RAG-powered conversational assistant** over a Tamil Nadu
agricultural knowledge base. The platform pillars that complete the vision are planned:

- **Context Engine** — `[PLANNED]` auto-assembles farm profile, GPS, weather, soil, season, crop history,
  advisories, and knowledge before the AI answers (zero-question context).
- **Model Adapter** — `[PLANNED]` provider-agnostic AI layer (Gemini is the current provider, not the only one).
- **Farm Memory** — `[FUTURE]` long-term memory of the farm across sessions, seasons, and channels.
- **AI diagnosis pipeline** — `[PLANNED]` image + context fusion for structured crop diagnoses.

> **This repository is the Product Repository.** It contains the backend API and is the single source of
> truth for all product, business, AI, architecture, API, database, roadmap, engineering standards, and
> planning documentation (`docs/`).

---

## Quick links

- **Product constitution:** [docs/product/PRODUCT_PRINCIPLES.md](docs/product/PRODUCT_PRINCIPLES.md)
- **Documentation hub:** [docs/README.md](docs/README.md)
- **AI Product Principles:** [docs/product/AI_Product_Principles.md](docs/product/AI_Product_Principles.md)
- **Product vision:** [docs/product/01_Product_Vision.md](docs/product/01_Product_Vision.md)
- **System architecture:** [docs/architecture/06_System_Architecture.md](docs/architecture/06_System_Architecture.md)
- **API reference:** [docs/architecture/08_API_Documentation.md](docs/architecture/08_API_Documentation.md)
- **Backlog & roadmap:** [docs/planning/17_Backlog.md](docs/planning/17_Backlog.md) · [docs/product/05_Product_Roadmap.md](docs/product/05_Product_Roadmap.md)
- **Startup plan:** [docs/business/16_Startup_Plan.md](docs/business/16_Startup_Plan.md)

---

## What's inside

| Path | Contents |
|---|---|
| `index.js` | Express 5 app, wrapped with `serverless-http` for AWS Lambda |
| `config/` | MongoDB connection (`db.js`); vector store config (planned) |
| `controllers/` | HTTP layer — auth, chat (RAG + context), legacy test CRUD |
| `models/` | Mongoose schemas — User, ChatSession, Query, Context |
| `routes/` | `/auth`, `/chat`, `/chatsessions`, `/test` (legacy) |
| `rag/` | Knowledge ingestion: S3 CSVs → embeddings → ChromaDB |
| `utils/` | Prompt, error/response helpers, async handler |
| `docs/` | Full product & engineering documentation |
| `.github/workflows/` | CI/CD — Docker → ECR → Lambda |
| `Dockerfile` | AWS Lambda Node 24 base image |

### Tech stack

- **Runtime:** Node.js (ESM), Express 5
- **Persistence:** MongoDB Atlas (Mongoose 8)
- **AI:** Google Gemini 2.5 Flash (LLM) · Cohere `embed-english-v3.0` (embeddings) · ChromaDB Cloud (vector store)
- **Auth:** AWS Cognito (OAuth2, Google federation)
- **Infra:** AWS Lambda via `serverless-http`, Docker/ECR, GitHub Actions
- **Data source:** Agricultural CSV datasets in AWS S3

Frontend lives in the separate repository **`tn-farming-assistant-frontend`** (React 18 + TypeScript + Vite + Tailwind CSS).

---

## Product status

### `[EXISTING]` — Working today
- Bilingual (Tamil/English) RAG chat grounded in the TN knowledge base, with conversation memory (last 6 messages).
- Chat session create / list / fetch / delete / clear (MongoDB persistence).
- Google sign-in via AWS Cognito (OAuth2 code flow).
- Voice-to-text input (browser Web Speech API).
- Weather widget on the login screen (Open-Meteo, nearest of 38 TN districts).
- Language selection (English/Tamil) persisted locally.
- Backend deployed to AWS Lambda via Docker → ECR (GitHub Actions).

### Present in the UI but **not** wired end-to-end
- Image capture/preview — the file is **not** transmitted to the backend (AI diagnosis pipeline is `[PLANNED]`).
- Audio playback affordance — no text-to-speech is implemented.

### `[PLANNED]` — Phase 1 (next milestone)
- Verified authentication & authorization (today's token is decoded without verification — see Security notice).
- Context Engine first slice: backend-assembled weather/location/soil/farm-profile context injected into AI prompts.
- Model Adapter: provider-agnostic AI layer (Gemini configurable, others drop-in).
- AI diagnosis pipeline: image + context fusion → structured diagnosis.
- Farm profile onboarding.
- Streaming responses (SSE).
- Automated tests + AI evaluation harness.
- Monitoring & cost analytics.

### `[FUTURE]` — Roadmap only
- Farm Memory (long-term farm intelligence), WhatsApp bot, Tamil TTS, alerts, personal crop plans.
- Marketplace (dealer directory, leads), premium subscriptions, recordkeeping.
- Enterprise/B2B/government, multi-state expansion.

See [docs/product/04_Feature_List.md](docs/product/04_Feature_List.md) for the full, statused inventory and
[AI Product Principles](docs/product/AI_Product_Principles.md) for the binding rules.

---

## Getting started (local development)

### Prerequisites
- Node.js 20+
- MongoDB (local or Atlas connection string)
- API keys: Gemini (`GOOGLE_API_KEY`), Cohere (`COHERE_API_KEY`), ChromaDB Cloud (`CHROMA_*`) — required for chat; AWS keys + `S3_BUCKET` for ingestion

### Setup

```bash
npm install
# create .env (see docs/engineering/14_Deployment.md) — .env.example is planned, not yet committed
npm run dev            # http://localhost:8000
```

Health check:

```bash
curl http://localhost:8000
# => { "message": "Backend is Live!" }
```

Full local-dev and deployment guide: [docs/engineering/14_Deployment.md](docs/engineering/14_Deployment.md)

> ⚠️ **Security notice:** authentication and authorization are being hardened in Phase 1.
> The backend currently decodes Cognito tokens without signature verification and trusts a
> client-supplied `userEmail`; `/test/*` routes expose data. See
> [docs/engineering/15_Security.md](docs/engineering/15_Security.md) for the current posture and
> remediation plan. **Do not onboard real users until Phase 1 completes.**

---

## Repository roadmap

| Phase | Focus | Status |
|---|---|---|
| 0 | Documentation & product foundation | In progress |
| 1 | Trusted core MVP (security, context, diagnosis, quality) | Planned |
| 2 | Farmer intelligence (WhatsApp, profiles, alerts, TTS) | Future |
| 3 | Marketplace (dealer directory, leads) | Future |
| 4 | AI automation & Pro (subscriptions, expert loop, records) | Future |
| 5 | Enterprise & ecosystem (B2B, govt, multi-state) | Future |

Full detail: [docs/product/05_Product_Roadmap.md](docs/product/05_Product_Roadmap.md)

---

## Contributing

This project is a startup product in an early phase. Contributions and questions are welcome.

1. Read the docs hub ([docs/README.md](docs/README.md)) and Technical Guidelines ([docs/engineering/12_Technical_Guidelines.md](docs/engineering/12_Technical_Guidelines.md)).
2. Branch from `main`: `feat/…`, `fix/…`, `chore/…`, `docs/…`.
3. Open a PR (CI runs lint/typecheck/tests; AI evaluation gates Phase 1+).
4. Reference backlog IDs and ADRs in the description.

---

## License

ISC (see `package.json`). Commercialization strategy is defined in [docs/business/16_Startup_Plan.md](docs/business/16_Startup_Plan.md).
