# PHASE 2 — LOSS CLAIM MODEL + LIFECYCLE (E9-S2)

## Objective
Implement **Phase 2 — Loss Claim Model & Lifecycle (E9-S2)** of the Vivasayi AI Agricultural Loss / Affected-Area Claims feature: the `LossClaim` domain model, the centralized claim state machine, the owner-scoped `/claims` API (create/list/detail/submit/withdraw/resubmit), the claim-scoped presigned evidence pipeline (presign/complete/delete/url), deterministic tests, project-convention doc updates, and the mandated 13-section final report. Phase 1 (Farm Parcel Foundation E9-S1) is complete and carried forward. Phase 2 **must stop here** — no Phase 3; no commit/push/deploy.

## Important Details
- Domain: agricultural crop-loss / affected-area verification — NOT property ownership, land-title, compensation, or property listing. Evidence pipeline is "upload imagery for the affected area".
- Frozen domain rules (ADR-019 P1–P10, carried into Phase 2): a claim binds to exactly one existing `parcelId` (P10); event date is backend-authoritative within `CLAIM_WINDOW_DAYS` (default 30) and future dates are rejected (P2); weather is supporting-only (never decision grounds alone, P3); **AI never computes acreage** — `claimedAreaAcres` is always server-calculated (P4); the backend never accepts client-supplied authoritative fields (`cognitoSub`, `profileId`, parcel `name`, `crop`, `area`, `claimedAreaAcres`, `state` — zod strips unknown body keys); legacy profiles without parcels remain valid.
- Event enum (backend-authoritative, zod): `flood`, `storm`, `drought`, `pest`, `disease`, `fire`, `other`. Event date parsed with `z.coerce.date` and recomputed day-boundary-aware (UTC) so a "today" timestamp at any time of day is always inside the window.
- Claims state machine (centralized, `services/claimState.service.js`): 10 states — `draft`, `submitted`, `under_processing`, `more_evidence_required`, `verified`, `partially_verified`, `rejected`, `withdrawn`, `failed`, `expired`. Farmer-only transitions implemented: `draft → submitted` (no simulated processing — the engine states are reserved for the verification phases), `submitted → withdrawn`, `more_evidence_required → withdrawn`, `more_evidence_required → resubmitted` (`resubmitted` folds back to `submitted`; caps/cooldown per P6). Terminal states immutable; same-state transitions are a no-op; invalid transitions → `409`; unknown state string → `400`.
- **No client PATCH endpoint** — the finalized contract (08 §10) defines none; draft claims are recreated or resubmitted per the contract. `POST /claims/calculate-area` is **not implemented** (P5 — needs the E9-S3/S4 area-eligibility/overlap engine). Admin endpoints (P7) and pHash dedup (E9-S6) are deferred.
- Idempotency: owner-scoped compound-sparse unique index `{ cognitoSub, idempotencyKey }` on `LossClaim`; duplicate `POST /claims` (same user, same key) returns the existing claim (`200`, no second audit, no duplicate); `E11000` race → verified, documented fallback. A verified-claim partial unique guard (P1/P4) on `{ parcelId, eventDate, eventType }` is limited to `verified`/`partially_verified` states so re-created drafts for other events do not collide.
- Ownership: `requireAuth` (`req.user.id` = cognitoSub); every claim/evidence resource resolved by owner scope; foreign/unknown → `404` (no existence leak); owner identity never accepted from the body. Responses never expose `s3Key`, bucket names, `cognitoSub`, `profileId`, or `idempotencyKey`.
- Evidence reuses the existing presigned-S3 pattern: magic-byte MIME sniff (JPEG/PNG/WEBP only), `EVIDENCE_MAX_SIZE_BYTES`, EXIF strip + redimension + re-encode via the Phase-1 normalization service, owner-scoped keys under `claims/<claimId>/<uploadId>/`. `ClaimEvidence.status = pending → stored | failed`; claim state must be mutable (`draft`/`submitted`/`more_evidence_required`) for evidence mutations, else `409`. Evidence metadata persisted; binary never stored in Mongo. Signed GET URLs (5-min TTL) served to the owner only; `complete` verified by S3 `headObject` (size/type) and is idempotent.
- Evidence count cap conforms to `.env.example` `EVIDENCE_MAX_IMAGES` (default 8). Claim/evidence rate limits: `claimLimiter` (5 claims/hour per user) on all claim routes, `evidenceLimiter` (20 uploads/hour per user) on evidence routes (per 15_Security §5, read from `CLAIM_RATE_LIMIT_*` / `EVIDENCE_RATE_LIMIT_*` env).
- Tests: Phase 1 established Vitest + Supertest + mongodb-memory-server (system binary) and the `tests/` suite. Phase 2 adds **9 state-machine unit tests** (`tests/claimState.test.js`) and **58 claims API scenarios** (`tests/claims.api.test.js`) grouped into Model/Creation/Idempotency/Ownership/State machine/Submit/Evidence/Withdraw/Legacy/Security. Full suite = **108 passed, 0 failed** (10 parcel geometry + 31 parcel API + 9 claim state + 58 claims API).
- Config with deterministic test values (`vitest.config.js` test.env): `CLAIM_WINDOW_DAYS=30`, `CLAIM_RATE_LIMIT_WINDOW_MS`/`MAX=1000`, `EVIDENCE_RATE_LIMIT_*`=1000, `CLAIM_MAX_RESUBMISSIONS=2`, `CLAIM_RESUBMIT_COOLDOWN_MS=0`, `IMAGE_STORAGE_MODE=mock`, `IMAGE_AI_MODE=mock`. No `package.json`/`.env.example` changes were required (all `CLAIM_*`/`EVIDENCE_*` config keys already documented; `env.js` reads them with matching defaults).
- DO NOT COMMIT / PUSH / DEPLOY. STOP before Phase 3.

## Work State
### Completed
- Read-only inspection of the Phase 2 surface completed: 07_Database_Design (claim collections + required indexes + §14 migration rule), 08_API_Documentation item 10, 15_Security §5, 17_Backlog E9-S1/E9-S2, 18_DECISIONS ADR-019, plus `app.js`, `config/env.js`, `middlewares/{auth,rateLimit,validate,error}.js`, `services/{s3,parcel,parcelGeometry,upload}.service.js`, `utils/validation.schemas.js`, `tests/{setup,helpers}.js` and the existing suite.
- Config: `config/env.js` added `claimWindowDays`, `claimRateLimitWindowMs/Max`, `evidenceRateLimitWindowMs/Max`, `claimEvidenceMaxImages`, `claimOverlapToleranceM`, `claimAreaOverageFraction`, `claimMaxResubmissions`, `claimResubmitCooldownMs` (defaults match `.env.example`); `vitest.config.js` test.env extended as above.
- Models (new): `LossClaim.js` (10-state enum, event enum, GeoJSON Polygon parcelSnapshot incl. task-mandated `name`, `claimedAreaAcres` server-computed, owner-scoped compound-sparse unique `{cognitoSub, idempotencyKey}`, partial unique `{parcelId, eventDate, eventType}` for verified/partially_verified, indexes `{cognitoSub, createdAt:-1}` and `{parcelId, state}`, `minimize:false`); `ClaimEvidence.js`; `ClaimAssessment.js` (persistence structure only — never written in Phase 2; detail returns `assessment: null`); `ClaimAudit.js` (append-only, `updatedAt` disabled, index `{claimId, createdAt:1}`).
- Services (new): `claimState.service.js` (transition map, `canTransition`, `applyTransition` w/ `400`/`409` semantics, terminal states, `resubmitted → submitted` fold); `claim.service.js` (create/list/get/submit/withdraw/resubmit + `serializeClaim` stripping `cognitoSub`/`profileId`/`idempotencyKey`/`s3Key`; submit idempotent "Claim already submitted"; resubmit only from `more_evidence_required` with P6 caps via prior audit count); `claimEvidence.service.js` (presign → pending `ClaimEvidence` + claim ref + presigned PUT (5 min); complete → headObject verify/normalize→store→`stored` (idempotent); delete → best-effort S3 delete + doc removal; getEvidenceUrl → 5-min signed GET).
- `s3.service.js` gained + exported `getSignedGetUrl({key, expiresInSeconds})` (mock form returns `https://mock-bucket.local/<key>?X-Amz-GET=1&Expires=…` for deterministic tests). `utils/validation.schemas.js` added `claimId`, `eventType`, `idempotencyKey` (8–64, `^[A-Za-z0-9_-]+$`), `claimDate` (coerce date), `createClaimBody`, `claimParams`, `claimEvidenceParams`. `middlewares/rateLimit.js` added exported `claimLimiter` + `evidenceLimiter` (per-user `chatKeyGenerator`). `controllers/claim.controller.js` (10 handlers, `req.user.id` + `req.requestId`), `routes/claims.js` mounted at `/claims` in `app.js` after `requireAuth`.
- Tests: `tests/claimState.test.js` (9 unit) + `tests/claims.api.test.js` (58 scenarios) — full suite **108/108**; `node --check` clean on all 16 modified/new JS files.
- Docs updated: `17_Backlog.md` (E9-S1/E9-S2 → DONE, E9-S2 rewritten for the finalized evidence flow), `15_Security.md` §5 claim controls (implemented vs deferred annotations), `07_Database_Design.md` §1 collection statuses ([ACTIVE] lossclaims/claimevidence/claimaudit, [PLANNED] claimassessment structure-only per §14 rule 1 — nothing removed), `08_API_Documentation.md` item 10 status note (implemented; calculate-area/pHash/admin deferred), `18_DECISIONS.md` ADR-019 Phase 2 implementation note, `19_CHANGELOG.md` Unreleased entry.

### Active
- Final report generation (this document) — nothing else remains.

### Blocked
- None. Note as-designed future blockers (not Phase 2): E9-S3/S4 (overlap/remaining-eligibility engine) gates `POST /claims/calculate-area`; E9-S6 gates pHash dedup; verification/admin phases gate `claimassessment` persistence and engine states.

## Next Move
- STOP — Phase 2 is complete. Provide the report + test evidence for product review. On approval: Phase 3 may proceed (engine/deterministic verification beginning to populate engine states); do not proceed automatically.

## Relevant Files (added)
- `tests/claims.api.test.js` — 58 numbered scenarios (Model/Creation/Idempotency/Ownership/State machine/Submit/Evidence/Withdraw/Legacy/Security).
- `tests/claimState.test.js` — 9 unit tests on the state machine.
- `models/LossClaim.js`, `models/ClaimEvidence.js`, `models/ClaimAssessment.js`, `models/ClaimAudit.js`.
- `services/claimState.service.js`, `services/claim.service.js`, `services/claimEvidence.service.js`.
- `controllers/claim.controller.js`, `routes/claims.js`.

## Relevant Files (modified)
- `config/env.js`, `vitest.config.js`, `middlewares/rateLimit.js`, `services/s3.service.js`, `utils/validation.schemas.js`, `app.js`.
- `docs/planning/17_Backlog.md`, `docs/planning/19_CHANGELOG.md`, `docs/engineering/15_Security.md`, `docs/architecture/07_Database_Design.md`, `docs/architecture/08_API_Documentation.md`, `docs/decisions/18_DECISIONS.md`.

## Package Changes
- None. Zero runtime/dev dependencies added or removed; `package.json` and `package-lock.json` untouched. All new endpoint/config behavior is built on Phase 1 infrastructure.

## Test Evidence
- `npm test` → **4 files, 108 passed, 0 failed** (14.85s). Breakdown: `parcel.geometry.test.js` 10, `parcels.api.test.js` 31, `claimState.test.js` 9, `claims.api.test.js` 58.
- `node --check` clean on all 16 modified/new JS files.
- No commit was made; `git status --short` shows exactly the intended change set (changed: `app.js`, `config/env.js`, `middlewares/rateLimit.js`, `services/s3.service.js`, `utils/validation.schemas.js`, `vitest.config.js` + 6 docs; new: 4 models, 3 claim services, controller, routes, 2 test files).

## Deployment & Safety Notes
- **SAFE** to deploy at Phase-2 cutover: strictly additive (new collections, new route namespace behind `requireAuth`, new config defaults matching `.env.example`), zero existing-table changes, zero dependency changes, existing routes/tests untouched (Phase 1 suite still green within the same run). Engine states never entered, `claimassessment` never written — engine/admin behavior arrives with their phases.
- **Security posture:** idempotency + owner-scoped unique keys; foreign → 404; evidence mutation guards on claim state; per-user claim/evidence rate limits; magic-byte sniff + normalization (EXIF strip) reused; signed GET to owner only; responses sanitized; `claimState.service.js` single source of truth for transitions; append-only audit with `requestId` correlation.

## Final Report: READY FOR REVIEW: YES