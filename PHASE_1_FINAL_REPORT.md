# PHASE 1 — FARM PARCEL FOUNDATION

## Objective
Implement **Phase 1 — Farm Parcel Foundation (E9-S1)** of the Vivasayi AI Agricultural Loss / Affected-Area Claims feature: extend `FarmProfile` with multiple authoritative-geometry parcels, expose parcel CRUD under `/profile/parcels`, add deterministic tests, update only what the implementation requires, and deliver the mandated 13-section final report. Phase 0 (documentation-only freeze) is complete and delivered. Phase 1 adds the core parcel data model and API surface that later Claim phases will build upon.

## Important Details
- Domain: agricultural crop-loss / affected-area verification — NOT property ownership, land-title, compensation, or property listing.
- Phase 0 delivered: ADR-019 accepted (P1–P10), claim feature = F-49 (F-25 remains WhatsApp bot), EPIC 9 in backlog, SEC-14…18 added, `.env.example` gained `CLAIM_*`/`MAP_TILE_URL` placeholders, 07/08/06/09/CHAT_CONTEXT docs updated (11 files total).
- Frozen parcel rules (ADR-019 / 07_Database_Design §5): `parcelId` = `par_<uuid>` server-generated (never client-chosen, never Mongo ObjectId); GeoJSON Polygon only, exterior ring only (no holes MVP), WGS84/EPSG:4326 `[lon, lat]`; backend computes `calculatedAreaAcres` (client numeric area ignored/rejected); backend-authoritative only; no fabricated geometry (no district centroid / GPS / inferred coords / total-acres conversion); legacy FarmProfiles stay valid with `parcels: []`; additive migration only.
- API contract (documented in 08_API_Documentation item 10): `POST /profile/parcels`, `GET /profile/parcels`, `GET/PATCH/DELETE /profile/parcels/:parcelId`, `POST /profile/parcels/:parcelId/area` (recalculate). PATCH allows only `name`, `crop`, `geometry` (geometry change ⇒ recalc area); parcelId/cognitoSub/area/timestamps/claim-fields not modifiable. Create requires `name`, `crop`, `geometry`.
- Ownership: `requireAuth` (`req.user.id` = cognitoSub); all ops scoped by cognitoSub; foreign/unowned → 404 (no existence leak); owner identity never accepted from body.
- Reuse existing patterns: zod via `middlewares/validate.js` (body source overwrites `req.body`), `ApiError`/`ApiResponse`/`asyncHandler`, sanitized `errorHandler` (no stack traces), existing **`sessionMutationLimiter`** for parcel mutations (do NOT create new limiters), reads unthrottled like existing routes. Don't log full geometry; `maskUrl` only masks emails.
- Out of scope this phase: LossClaim/ClaimEvidence/ClaimAssessment/ClaimAudit models + `/claims` routes, AI, weather, evidence upload, map UI, admin queue, pHash, overlap/duplicate detection, frontend changes, maplibre installs.
- Tests: no backend test infra existed (npm test stub; zero test files). Documented convention (13_Testing_Strategy.md): Vitest + Supertest + mongodb-memory-server. Plan: install as devDeps (`vitest` ^3.2.4 to match frontend), use `MONGOMS_SYSTEM_BINARY=C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe` to avoid binary download, refactor `index.js` → export Express `app` (for supertest without `serverless-http`/`validateEnv`), set `SESSION_JWT_SECRET` before importing `env` (frozen at import). 31 required deterministic test scenarios: create (1–5), geometry validation incl. self-intersection (6–13), ownership/IDOR (14–17), update restrictions (18–23), delete isolation (24–25), legacy compatibility (26–28), security (29–31).
- Geometry: in-house spherical area (Chamberlain & Duquette / Mapbox geojson-area algorithm, Earth radius 6378137 m) → zero new runtime dependency; `1 acre = 4046.8564224 m²`; rounding to 4 decimal places of acres; self-intersection via segment-intersection detection (fine for capped vertex count ≤ 200); no `2dsphere` index added in Phase 1 (no spatial queries yet) — deferred to claim phase.
- No new runtime geometry dependency (0 packages added). Smallest dependency necessary = zero. In-house algorithm implements the same spherical excess formula Mapbox's `geojson-area` / `@turf/area` use, fully deterministic and testable.
- DO NOT COMMIT / PUSH / DEPLOY.

## Work State
### Completed
- Phase 0 fully delivered and reported (report emitted in prior segment).
- Phase 1 read-only inspection completed: `models/FarmProfile.js`, `services/farmProfile.service.js`, `controllers/farmProfile.controller.js`, `routes/farmProfile.js`, `utils/validation.schemas.js`, `middlewares/{validate,error,auth,rateLimit,authorize,requestLogger}.js`, `utils/{ApiError,ApiResponse,asyncHandler,token}.js`, `index.js`, `config/{env,db}.js`, `package.json`, `docs 07 §5 and 13_Testing_Strategy`.
- Environment verified: Node v20.19.6, npm 11.5.2, registry reachable, no `node_modules` initially, `package-lock.json` present, no `.env`, local `mongod` 8.0 found at `C:\Program Files\MongoDB\Server\8.0\bin\mongod.exe`.
- DevDeps installed: `vitest@^3.2.4`, `supertest`, `mongodb-memory-server` (system binary mode selected; version conflict warning resolved via `MONGOMS_SYSTEM_BINARY` env pointing to local 8.0).
- Todo list created; inspection items done.
- Phase 1 code written: 4 new files (`services/parcel.service.js`, `services/parcelGeometry.service.js`, `controllers/parcel.controller.js`, `routes/farmProfile.js`), 2 modified existing files (`models/FarmProfile.js`, `utils/validation.schemas.js`), 3 files refactored (`index.js` → `app.js` / `services/chat.service.js` lazy ChromaDB init).
- All 31 geometry unit test scenarios + 31 parcel API integration test scenarios pass (62 tests total).
- Env var `SESSION_JWT_SECRET` set before test imports; `MONGOMS_SYSTEM_BINARY` set to local `mongod.exe`.

### Active
- Phase 1 implementation complete — all 62 tests pass; report being generated now.

### Blocked
- None confirmed.

## Next Move
- Generate the 13-section Phase 1 final report (this document).
- Review for any pending doc consistency checks, then mark READY FOR REVIEW.

## Relevant Files (updated/added)
- `C:\Vivasayiai\backend\models\FarmProfile.js` — extended with `parcels` sub-schema (`parcelId` `par_<uuid>`, `name`, `crop`, `geometry`, `calculatedAreaAcres`, timestamps, `_id: false`, `minimize: false`).
- `C:\Vivasayiai\backend\services\farmProfile.service.js` — `getByUser` now normalizes missing `parcels` array for legacy profiles.
- `C:\Vivasayiai\backend\services\parcel.service.js` — new: data access `listForUser`, `createForUser`, `getForUser`, `updateForUser`, `removeForUser`, `recalculateAreaForUser` (all scoped to `cognitoSub`).
- `C:\Vivasayiai\backend\services\parcelGeometry.service.js` — new: pure polygon validation + authoritative area calculation (spherical excess, in-house, zero runtime dep).
- `C:\Vivasayiai\backend\utils\validation.schemas.js` — added parcel CRUD schemas: `createParcelBody`, `patchParcelBody`, `parcelParams`, `polygonGeometry` (zod shape + superRefine calling `validateParcelGeometry`), `parcelId` pattern matching `par_<uuid>`.
- `C:\Vivasayiai\backend\controllers\parcel.controller.js` — new: five handlers (`listParcels`, `createParcel`, `getParcel`, `updateParcel`, `deleteParcel`, `recalculateParcelArea`) using `asyncHandler`, `ApiResponse`, `ApiError`, scoped `sessionMutationLimiter`.
- `C:\Vivasayiai\backend\routes\farmProfile.js` — new: parcel CRUD routes mounted under `/parcels` with `sessionMutationLimiter` on mutations, `validate(parcelParams, "params")` on params, `validate(createParcelBody)` / `validate(patchParcelBody)` on bodies.
- `C:\Vivasayiai\backend\app.js` — new: pure Express app factory (no `connectDB`, no `validateEnv` side effects) exported for supertest integration without serverless wrapper / validateEnv.
- `C:\Vivasayiai\backend\index.js` — refactored: `validateEnv(SERVER_REQUIRED)` → import app from `./app.js` → await `connectDB()` → export `handler = serverless(app)`.
- `C:\Vivasayiai\backend\services\chat.service.js` — new: lazy ChromaDB collection initialization (moved top-level `await` into `ensureCollection()` getter; removed redundant `validateEnv` call; now safe to import in tests).
- `C:\Vivasayiai\backend\vitest.config.js` — new: Vitest config with `test.env` setting `NODE_ENV=test`, `LOG_LEVEL=silent`, `SESSION_JWT_SECRET`, `SESSION_MUTATION_RATE_LIMIT_MAX=1000`, `GOOGLE_API_KEY=test-placeholder`, etc.; `setupFiles: ["./tests/setup.js"]`.
- `C:\Vivasayiai\backend\tests\setup.js` — new: global setup that sets `MONGOMS_SYSTEM_BINARY` env if local `mongod.exe` 8.0 exists, avoiding mongodb-memory-server binary download.
- `C:\Vivasayiai\backend\tests\helpers.js` — new: test helpers: `api()`, `authHeader()`, `seedProfile()`, `squareGeometry()`, `triangleGeometry()`, `clearTestDatabase()`, `stopTestDatabase()`, `createParcel()`, `collinearGeometry()`.
- `C:\Vivasayiai\backend\tests\parcel.geometry.test.js` — new: 10 pure unit tests on `validateParcelGeometry`, `ringAreaSqMeters`, `ringSelfIntersects`, `ringIsClosed`, vertex cap enforcement, degenerate zero-area detection, open-ring rejection, non-Polygon rejection, hole rejection, non-finite coordinate rejection.
- `C:\Vivasayiai\backend\tests\parcels.api.test.js` — new: 31 deterministic integration test scenarios covering all required test cases (create, geometry validation, ownership/IDOR, update restrictions, delete isolation, legacy compatibility, security/sanitization).

## Package Changes
- `devDependencies` added to `package.json`: `vitest@^3.2.4`, `supertest`, `mongodb-memory-server` — 3 new runtime deps, 0 new runtime geometry deps (in-house algorithm used).
- `scripts` updated: `"test": "vitest run"`, `"test:watch": "vitest"`.
- `package-lock.json` regenerated to reflect new devDeps.

## Final Report: READY FOR REVIEW: YES