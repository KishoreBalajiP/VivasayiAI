# Vivasayi AI

**Tamil-first AI agriculture assistant and crop-loss claim verification backend for Tamil Nadu's farmers.**

Vivasayi AI began as a bilingual (Tamil and English) retrieval-augmented chatbot. It now has two parts:

1. **A farmer-aware advisory chat.** It looks up what it can about the authenticated farmer (profile, parcels, recent claims, weather) and asks a follow-up question only when a detail it genuinely needs is missing.
2. **A crop-loss claim pipeline.** A farmer files a claim against a registered parcel. Photographs, land documents, parcel geometry, overlap checks, satellite and weather evidence are each reduced to an explicit per-component outcome. A **deterministic rule engine, never a language model, decides.**

> **Read this before relying on it.** The system has not been validated on real claims, documents or satellite
> imagery, and no authorised Tamil Nadu land-record API is available. Several parts are built and tested but not
> run live (see [What is and is not verified](#what-is-and-is-not-verified)). Do not use it to make real
> compensation decisions.

The product vision is a *Decision Platform, not a chatbot*; see [docs/product/PRODUCT_PRINCIPLES.md](docs/product/PRODUCT_PRINCIPLES.md).
The frontend lives in a separate repository (`tn-farming-assistant-frontend`: React, TypeScript, Vite).

## Quick links

- Documentation hub: [docs/README.md](docs/README.md)
- System architecture: [docs/architecture/06_System_Architecture.md](docs/architecture/06_System_Architecture.md)
- API reference: [docs/architecture/08_API_Documentation.md](docs/architecture/08_API_Documentation.md)
- Decisions (ADR-020 and ADR-021 describe the verification design): [docs/decisions/18_DECISIONS.md](docs/decisions/18_DECISIONS.md)
- Frontend contract for the latest backend changes: [docs/architecture/FRONTEND_CONTRACT_2026-10.md](docs/architecture/FRONTEND_CONTRACT_2026-10.md)
- Test baseline and fix log: [docs/engineering/BASELINE_2026-10.md](docs/engineering/BASELINE_2026-10.md)
- Research and evaluation: [docs/research/](docs/research/) (start with [evaluation/README.md](docs/research/evaluation/README.md))

## How it works

### Request path

`index.js` wraps the Express 5 app (`app.js`) for AWS Lambda with `serverless-http`. Middleware order: security headers, CORS allow-list, request logging with a validated correlation id, JSON body (1 MB). `/auth` is public; everything else sits behind `requireAuth`, which verifies a backend-issued HS256 session token. `/admin` additionally requires the `admin` role, which comes from the verified Cognito identity at login, never from a request body.

Controllers are thin, services hold the logic, Mongoose models hold the data. Every resource is scoped by the caller's stable Cognito `sub`; another user's resource returns not-found.

### Chat

For each message the assistant (`services/context.service.js`, `src/ai/`):

1. classifies the intent and loads **only** the context that intent needs;
2. resolves district, parcel and crop from the farmer's own records, tagging each item `verified`, `user_provided`, `third_party`, `inferred`, `missing` or `stale`;
3. retrieves knowledge from ChromaDB (Cohere embeddings) and fences it in the prompt as data, returning the source file names;
4. asks one follow-up only if a required detail is unresolved, otherwise answers directly;
5. replies in the requested language, the message's script, or the profile language.

Weather comes from Open-Meteo using the stored district coordinates. **There is no soil data source**: the assistant is told to recommend a soil test rather than guess.

### Claim verification

```
submit -> job queue -> evidence steps -> evidence rows -> component resolver -> rule engine + policy gate -> decision
                                                                                         \-> held (stays "submitted")
```

- **Evidence** is stored append-only per component (photographs, claimant rights, land documents, geometry, satellite, weather, overlap, manual review). Each resolves to `verified`, `failed`, `unverified`, `unavailable`, `inconclusive`, `pending` or `requires_review`. A provider failure is `unavailable`; missing evidence is `unverified`; `failed` needs a positive contradicting finding.
- **The frozen rule engine** (`services/claimVerificationEngine.service.js`) checks the claim window, event type, area allowance, containment in the parcel, duplicate or partial overlap with the farmer's own claims, remaining eligible area and the photograph assessment. Outcomes use the existing claim states; none was added.
- **A versioned policy** (`config/verificationPolicy.js`) decides which components are required. Default `v1-legacy` reproduces the historical decisions. `v2-components` additionally requires claimant-rights evidence and sends overlap with another farmer, or an AI "no damage" reading, to a person instead of rejecting. Select it with `CLAIM_VERIFICATION_POLICY`; it needs product-owner sign-off first (ADR-020).
- **Every decision** records the policy id and hash, the component outcomes and references to the evidence rows used.
- **Work runs from a durable job queue** in MongoDB (ADR-021), because Lambda freezes after the response. Steps run on `POST /claims/:id/verify`, on a status read, or from the optional scheduled `worker` handler in `index.js`.
- **Satellite**: pre- and post-event NDVI over the claim polygon from the Copernicus Data Space Statistical API with cloud masking. **Built and tested against fixtures; never run live.** NDVI change is supporting evidence and never proof of cause.
- **Land records**: a provider-neutral adapter (`LAND_RECORD_PROVIDER_URL`). Without an authorised provider it returns `unavailable`, never a match.

### Main routes

| Area | Routes |
|---|---|
| Auth | `POST /auth/google` |
| Chat | `POST /chat`; `GET/POST/DELETE /chatsessions...` |
| Profile and parcels | `GET/POST/DELETE /profile`; `/profile/parcels...` |
| Uploads | `POST /upload/presign`, `/upload/:id/complete`, `GET /upload/:id/view` |
| Claims | `POST/GET /claims`, `/claims/:id`, `submit`, `withdraw`, `resubmit`, `verify`, `verification`, `evidence/...`, `ownership...`, `appeal` |
| Admin | `GET /admin/claims`, `/admin/claims/:id`, `override`, `ownership/.../review`, `review-cases/.../decision`, `dashboard`, `investigation` |

## Getting started

Prerequisites: Node.js 20 or newer (the production image uses Node 24), MongoDB, and keys for Gemini, Cohere and ChromaDB to run chat for real.

```bash
npm ci --legacy-peer-deps      # the langchain packages declare conflicting peers; the Dockerfile uses the same flag
cp .env.example .env           # then fill in real values; never commit .env
npm run dev                    # serves http://localhost:8000 outside Lambda
curl http://localhost:8000/health
```

Outside Lambda the server listens on `PORT`; on Lambda (`AWS_LAMBDA_FUNCTION_NAME` set) it only exports the handlers.

Other commands:

| Command | Purpose |
|---|---|
| `npm test` | Run the test suite (uses an in-memory MongoDB, downloaded on first run) |
| `npm run eval -- --date=YYYY-MM-DD` | Regenerate the synthetic benchmark results in `docs/research/evaluation/results/` |
| `npm run ingest` | Ingest knowledge CSVs from S3 into ChromaDB (only `.csv` files outside the upload prefix) |
| `npm run seed:districts` | Seed the district reference data |
| `node scripts/migrations/2026-10-verification-components.js --dry-run` | Preview the data migration for the verification changes |

**Before deploying the verification changes**, run the migration without `--dry-run`: two index definitions changed and MongoDB will not alter an existing index on its own (see [BASELINE_2026-10.md](docs/engineering/BASELINE_2026-10.md)).

## What is and is not verified

Four kinds of evidence, kept separate on purpose:

| Kind | Status |
|---|---|
| **1. Tests** | 899 tests in 54 files pass (`npm test`): unit, integration against an in-memory MongoDB, and 15 adversarial claim scenarios. They show the code behaves as specified and does not regress. They do **not** show scientific accuracy. |
| **2. Synthetic benchmarks** | Run and reproducible (`npm run eval`). Ground truth is analytic, the design rule, a written specification, or author-assigned labels. See below. |
| **3. Live-provider validation** | **Not done.** No Gemini, Cohere, Chroma, S3, Atlas or Copernicus call has been made from this repository's evaluation. |
| **4. Real-world experiments** | **Not done.** No real claims, documents or imagery; no annotators; no authorised official records. |

### Synthetic benchmark results

Generated by `npm run eval` at commit 522d212 plus uncommitted changes, Node 26. Full numbers, ground-truth definitions and limitations: [docs/research/evaluation/results/SUMMARY.md](docs/research/evaluation/results/SUMMARY.md).

| Benchmark | Result | Reading |
|---|---|---|
| Geometry vs analytic truth | Containment, overlap flag and invalid-geometry detection: precision and recall 1.0 (n=300, 300, 190) | The implementation matches exact geometry. This says nothing about real cadastral boundaries. |
| Area | Server acres are about **0.63% larger** than an ellipsoidal reference, in every case | Systematic: the formula uses the equatorial radius. Not changed, because stored areas would stop being comparable; needs a product decision. |
| Chat follow-ups (55 cases, specification-scored) | Unnecessary questions: previous rule 36 of 44, new logic 0 of 44. Needed questions missed: 3 of 11 vs 0 of 11. Crop silently assumed when ambiguous: 6 of 6 vs 0 of 6 | The specification and the new logic share an author; the baseline is a reimplementation of the old rule. |
| Evidence fusion (192 scenarios) | Invalid approvals: photograph-only policy 10 of 190, component gate 0 of 190. Satellite and weather changed no decision in 1,536 comparisons | The label is the design rule the gate implements: this shows enforcement, not accuracy. Only 2 scenarios are truly approvable. |
| Name matching (60 pairs) | 60 of 60 | **Optimistic**: 55 of 60 before a rule change made after seeing the errors on the same set. |
| NDVI thresholds (simulation) | No false support at no change; a 0.15 drop detected about half the time, a 0.30 drop almost always; mostly-masked pixels give "inconclusive" | Simulated only. Paddy flooding and normal senescence are not modelled. |

### Pending

- Answer relevance and groundedness of the live assistant (needs a Gemini key and expert raters).
- Land-document field extraction accuracy (needs labelled documents; the scorer is `scripts/eval/docExtraction.score.js`).
- Live Sentinel-2 acquisition, cloud rate and agreement with independently labelled damage (needs Copernicus credentials and field-verified events).
- Duplicate and ownership-mismatch detection on real cadastral data (needs authorised access).
- A user study of the unnecessary-question experience.

### Known limits

- No authorised Tamil Nadu land-record API; official records are never reported as matched.
- The required-document policy per claimant relationship (owner, tenant, heir and so on) is provisional and has not been reviewed by anyone with legal or insurer authority.
- An intermittent test failure that appeared in full-suite runs was traced to test requests reaching another local program on a shared port. The shared test server now avoids that port range; 25 consecutive full runs passed afterwards.
- Rate limits are in-memory per Lambda container, not global.
- Frontend work is not in this repository; see the frontend contract.

## Tech stack

- **Runtime:** Node.js (ESM), Express 5, AWS Lambda via `serverless-http`
- **Data:** MongoDB (Mongoose 8)
- **AI:** Google Gemini (chat, vision, document reading), Cohere embeddings, ChromaDB; the model output is evidence, never the decision
- **Geo:** Turf for overlap; Copernicus Data Space (Sentinel-2) for satellite; Open-Meteo for weather
- **Auth:** AWS Cognito (OAuth2 code flow, Google federation) exchanged for backend session tokens
- **CI/CD:** GitHub Actions: tests, then Docker to ECR to Lambda with an immutable commit-SHA tag

## Repository layout

| Path | Contents |
|---|---|
| `app.js`, `index.js` | Express app; Lambda handlers (`handler`, `worker`) |
| `config/` | Environment, verification policy, claimant-evidence policy, districts, weather |
| `routes/`, `controllers/` | HTTP layer |
| `services/` | Business logic: chat, context, claims, verification engine and components, job queue, satellite, documents, admin |
| `src/ai/` | Prompts, intent classification, context sufficiency |
| `models/` | Mongoose schemas |
| `rag/` | Knowledge ingestion |
| `scripts/` | Seeding, migrations, evaluation harness (`scripts/eval/`) |
| `tests/` | Test suite |
| `docs/` | Product, architecture, engineering, decisions and research documentation |

## Contributing

1. Read the docs hub ([docs/README.md](docs/README.md)) and the technical guidelines ([docs/engineering/12_Technical_Guidelines.md](docs/engineering/12_Technical_Guidelines.md)).
2. Branch from `develop`: `feat/...`, `fix/...`, `docs/...`.
3. Open a PR. CI runs the test suite; a deploy happens only on a push to `main` after the tests pass.
4. Reference ADRs and backlog IDs in the description.

## License

ISC (see `package.json`). Commercialization strategy: [docs/business/16_Startup_Plan.md](docs/business/16_Startup_Plan.md).
