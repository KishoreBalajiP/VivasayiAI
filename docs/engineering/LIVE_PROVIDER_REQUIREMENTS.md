# Live provider requirements

**Status (2026-10-17).** What each external provider needs before the claim flow and chat can run for real, what the code does with it, and what has actually been exercised live. Environment variable details are in [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md). Nothing here was re-run for this document; "live" facts come from the 16 October 2026 study ([LIVE_RESULTS_2026-10-16.md](../research/evaluation/live/LIVE_RESULTS_2026-10-16.md)).

| Provider | Used for | Live status | Blocking a production release? |
|---|---|---|---|
| Google Gemini | chat, image chat, claim photo assessment, land-document reading | Provider answered on 16 Oct; chat and document evaluations **BLOCKED** (quota) | **Yes**: needs a billed key (owner decision D6) |
| Cohere | query and document embeddings | Exercised (22 retrieval queries, query-vector cache) | No |
| Chroma Cloud | knowledge retrieval for chat | Exercised read-only | No |
| AWS S3 | uploads and claim evidence; knowledge CSVs | Exercised read-only | No |
| Copernicus Data Space (CDSE) | Sentinel-2 discovery and NDVI statistics | 12 case-study runs through the production adapter (script, not the app) | No: satellite is supporting only |
| Open-Meteo | weather panel, rainfall around the event | Forecast endpoint exercised | No |
| Nominatim, OpenStreetMap tiles | frontend place search, reverse geocoding, map tiles | Used by the frontend in development | Production needs its own capacity (below) |
| AWS Cognito | login (Hosted UI, Google federation) | Used manually; no automated browser login | No |
| Official land-record API | claimant rights | **None exists**; the adapter returns `unavailable` | No (documented gap) |

## Google Gemini

- **Key:** `GOOGLE_API_KEY`, model `MODEL_NAME` (default `gemini-2.5-flash`). Required at boot.
- **Billed key required (D6).** The key used on 16 October was a free-tier key and its daily quota ran out during the live chat evaluation. `live_eval_status_2026-10-16.json` records the limit as "20 req/day"; that figure is the operator's diagnosis, not a measured value. Until a billed key is configured, live chat and land-document evaluations stay **BLOCKED**, and a production deployment would hit quota errors within a few claims.
- **Call-cap gate not present yet.** The acceptance item ACC-13 expects the live scripts to require `LIVE_GEMINI_APPROVED=1` and a `--max-calls` cap. A grep of `scripts/` on 2026-10-17 found neither; add them before running the live Gemini evaluations on a billed key.
- **What a quota error does now.** It is classified `quota`, retried with backoff, and under `v1.1-safe-ai` never becomes a rejection or a request for more evidence: the claim is held and, if the step dies, a reviewer gets a review case. Chat answers 503 "AI service is busy".

### Calls per claim

Counts are **model calls**. Each call may be retried once more by the SDK on a transient error (`AI_MAX_RETRIES`, default 1), so HTTP requests can be up to twice the number shown.

| Work | Normal case | Worst case (automatic retries only) |
|---|---|---|
| Photo check, `n` photos (1 to 10) | `n` | about `n + 21`: each failed attempt makes at least one call; 7 attempts per job and up to 2 automatic recovery rounds (`3 × 7 = 21` failed attempts) per photo-set version. Images already assessed are checkpointed and not sent again |
| Land documents, `m` documents (up to 5 in the wizard) | `m`, or `2m` when answers are unusable (one stricter retry per document) | up to 21 attempts, each sending only the documents not yet examined, each at most twice |
| Engine | 0 | 0 under `v1.1-safe-ai` (a photo check that already failed for the same photos is not re-run inline). Under `v1-legacy` each engine attempt may re-run the photo check inline |
| Text chat message | 1 | 1 (+ SDK retry); per-user caps of 30 per minute and 300 per day |

Every new photo set (a photo added after submit) starts its own retry chain. Admin or CLI re-queues add attempts on top (up to 10 recovery rounds). With the default schedule a failing photo-check job spends about 5 h 21 min (±20 % jitter) before it dies, and automatic recovery waits 6 h after each death, so three failing jobs span about 28 hours.

## Cohere

- **Key:** `COHERE_API_KEY`; model `EMBEDDING_MODEL` (default `embed-english-v3.0`). The API imports the chat module at start-up, which builds the Cohere client, so the key must be set even for a worker.
- **Calls:** one `embedQuery` per text chat message. Ingestion and `npm run rag:build-local` call `embedDocuments` for every chunk; `scripts/live/ragEmbedQueries.js` embeds the 22 evaluation queries once and caches them.
- Use a production key: trial keys are rate-limited and their terms do not cover production use.

## Chroma Cloud

- **Keys:** `CHROMA_API_KEY`, `CHROMA_TENANT`, `CHROMA_DATABASE`; collection `RAG_COLLECTION` (default `farming-documents`).
- **Read-only for the app.** The API only reads the collection. The only writer is `rag/ingest.js --target=chroma-cloud`, which needs `--collection=<name>` and `--confirm-production-write` and refuses to mix chunk formats. The production collection was built by an older ingestion script; re-ingesting it with the new chunker is an owner decision (ADR-023) and has not been done.
- `scripts/live/ragSnapshotProd.js` reads the collection (`count` and `get` only) and runs only with `--allow-prod-read`.

## AWS S3

- **Keys:** `MY_AWS_REGION`, `MY_AWS_ACCESS_KEY_ID`, `MY_AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`.
- **The app** needs `PutObject` (presigned uploads), `GetObject`, `HeadObject` and `DeleteObject` under `uploads/` (chat images, land documents, and claim photos at `uploads/claims/<claimId>/...`).
- **Knowledge tooling** (`npm run rag:build-local`, the RAG evaluation) needs only `GetObject` and `HeadObject` on the knowledge CSV keys. `rag/buildLocalIndex.js` wraps the client (`createReadOnlyS3`) and refuses any other command, bucket, key off its 60-key allow-list, and anything under `uploads/` or `claims/`. That guard is code, not policy: give these scripts a **separate IAM principal with read-only access** to the knowledge keys.

## Copernicus Data Space Ecosystem (CDSE)

- **Discovery** (the STAC catalogue) is anonymous and runs whenever `SATELLITE_ENABLED` is true (the default).
- **Processing** (the Statistical API, NDVI over the parcel) needs OAuth client credentials (`CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET`) **and** `SATELLITE_PROCESSING_ENABLED=true`. It is off by default. With it off, a claim shows satellite `unavailable / analysis_not_enabled`.
- Processing requests use the account's CDSE quota; check the account's limits before enabling processing for every claim.
- Satellite is supporting evidence only and never blocks or changes a decision. See [SATELLITE_LIMITATIONS.md](SATELLITE_LIMITATIONS.md).

## Open-Meteo

- Backend only (the frontend no longer calls Open-Meteo directly): `GET /weather` (forecast, cached `WEATHER_CACHE_TTL_MS`) and the claim's `weather` step (archive API, rainfall around the event).
- The free Open-Meteo API is offered for non-commercial use with a daily call limit; a commercial deployment needs an API subscription. Check the current terms on open-meteo.com before launch and set `OPEN_METEO_*_BASE_URL` if a paid endpoint is used.
- A weather failure never affects a decision: the step records `unavailable` and the farmer sees "unavailable, supporting only".

## Nominatim and OpenStreetMap tiles (frontend)

- Place search and reverse geocoding use the public Nominatim instance unless `VITE_GEOCODER_URL` is set. Its usage policy allows about one request per second, no bulk use, a valid Referer, and requires ODbL attribution. The frontend debounces typing and paces requests to the public instance to one per second (`src/services/geocoderRateLimit.ts`). That is enough for development, not guaranteed production capacity: self-host Nominatim or use a paid geocoder for production.
- Map tiles default to `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. The OSM tile usage policy forbids heavy use and requires attribution; point `VITE_MAP_TILE_URL` at a dedicated or self-hosted tile source for production.

## AWS Cognito

- Backend: `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET`, `COGNITO_DOMAIN`, `COGNITO_REDIRECT_URI`, and `COGNITO_USER_POOL_ID` (pins the user pool; without it any pool is accepted and only the audience check binds the token to this app). Frontend: `VITE_COGNITO_DOMAIN`, `VITE_COGNITO_CLIENT_ID` (must equal the backend's), `VITE_COGNITO_REDIRECT_URI` (must be registered in the app client).
- The backend verifies the Cognito id token once at login and issues its own HS256 session tokens (`SESSION_JWT_SECRET`).
- The Playwright suite does not log in through Cognito: it injects a session minted by the hermetic harness. There is no Cognito bypass in the frontend source. A real login is checked manually only.

## Official land records

No authorised Tamil Nadu land-record API is available. `services/officialLandRecord.service.js` is a provider-neutral adapter: without `LAND_RECORD_PROVIDER_URL` and `LAND_RECORD_API_KEY` it returns `unavailable`, never a match. Claimant rights can only be reviewed manually.
