# PHASE 3 — CLAIM EVIDENCE + ASSESSMENT FOUNDATION (E9-S2 hardening)

## 1. Result
Phase 3 complete. The Phase 2 claim evidence layer was verified against the frozen contract and hardened additively: **every evidence mutation is now audited** (append-only `ClaimAudit`, actor `farmer`, `requestId`), **`complete` is atomic + idempotent** (status compare-and-swap), and a **17-scenario hardening suite** proves the 16 mandated IDOR/security/validation/lifecycle guarantees plus the evidence-audit and evidence-optional-submit behavior. Full backend suite: **125 passed, 0 failed**. No new public API, no AI, no package.json/.env changes, no commit/push/deploy. **STOP — Phase 4 not started.**

## 2. Files changed
- `services/claimEvidence.service.js` (modified) — evidence audit rows (`evidence_presigned` / `evidence_completed` / `evidence_deleted`); atomic/idempotent `completeEvidence` (CAS `pending → processing` via `findOneAndUpdate`; missing-object + vanished-object paths revert the record to `pending` so the same presigned capability retries; idempotent return for stored/completed; 409 on concurrent processing); `requestId` plumbed through presign/complete/delete.
- `controllers/claim.controller.js` (modified) — passes `requestId` to all three evidence-mutating handlers.
- `vitest.config.js` (modified) — `EVIDENCE_RATE_LIMIT_MAX` 1000 → 6 (harness now surfaces a real 429 for the rate-limit scenario; all per-user per-suite evidence calls stay < 6).
- `tests/claims.evidence.test.js` (new) — 17 deterministic Phase 3 scenarios (P3-01..P3-17).
- Docs (modified): `07_Database_Design.md`, `08_API_Documentation.md`, `15_Security.md`, `17_Backlog.md`, `18_DECISIONS.md`, `19_CHANGELOG.md`.

## 3. Evidence pipeline implemented
Presign → direct-to-S3 PUT (short-lived signed URL, 5 min, one server-owned key) → complete (server verifies object existence via `headObject`, **server-measured size**, S3 `Content-Type` vs declared, magic-byte signature vs declared, then the existing sharp decode/normalize/EXIF-strip pipeline → normalized image overwrites the same owner-scoped key → `ClaimEvidence` status `stored` with server-measured `size`/`width`/`height`). The browser MIME is never authoritative. Delete is best-effort object cleanup + record removal; signed GET URLs are owner-scoped, claim-scoped, short-lived, server-generated, and never public. Keys stay `claims/<claimId>/<uploadId>/` inside the existing private-bucket namespace (no second storage convention, no new provider). No client-supplied S3 key can reach the endpoints (params schema accepts only `img_<uuid>`; path-shaped keys never even route).

## 4. ClaimAssessment boundary
Unchanged and enforced: `ClaimAssessment` remains a **persistence-structure-only** model (07 §8). No row is ever written; claim detail returns `assessment: null`; no assessment/AI/weather/verification code, call, or field was introduced. `ClaimEvidence.aiAssessment` / `perceptualHash` / `exifGps` remain reserved-null (populated by later phases only).

## 5. Security / IDOR protections (all proven by tests)
- User A cannot **read** (complete/url/detail), **delete**, or **generate a signed URL for** user B's evidence → 404 (P3-01..P3-03).
- User A cannot **attach user B's upload** to A's claim (complete/delete/url on A's claim with B's uploadId → 404) (P3-04).
- `cognitoSub`/`state`/`s3Key`/`s3Bucket`/owner in request bodies are stripped and ignored; ownership always derives from the verified token (P3-05, P3-07).
- Evidence mutation rejected in **all 7 blocked claim states** (`processing`, `verified`, `partially_verified`, `rejected`, `out_of_limit`, `duplicate_area`, `withdrawn`) → 409, via the centralized service guard (P3-06).
- Unsupported type → 400; MIME/signature mismatch (bytes-vs-declared AND header-vs-declared) → 400 + record `failed`; oversized → 413 at presign and 400 (server-measured) at complete (P3-08..P3-10).
- Arbitrary S3 keys never accepted (400 / 404) (P3-14); evidence rate limiter returns 429 exactly at its configured limit with `ratelimit-limit`/`ratelimit-remaining` headers (P3-15).

## 6. Idempotency / concurrency behavior
- Complete is race-safe: the CAS on status means concurrent duplicate completes share **one** `ClaimEvidence` record (no duplicate rows; verified by count), a sequential repeat returns the stored metadata without re-processing, and a not-yet-uploaded/missing object leaves the record `pending` (the same presigned URL retries cleanly — proven by a missing-object → upload → complete flow). Existing claim create/submit idempotency and the owner-scoped `idempotencyKey` index are untouched.

## 7. Tests executed and exact result
`npm test` (Vitest + Supertest + mongodb-memory-server, mock S3): **5 files, 125 passed, 0 failed** — parcel.geometry 10, parcels.api 31, claimState 9, claims.api 58, claims.evidence 17. All against mongo-memory-server + in-memory mock S3; never production DB/S3.

## 8. node --check result
Clean on all changed JS files (`services/claimEvidence.service.js`, `controllers/claim.controller.js`, `tests/claims.evidence.test.js`, `vitest.config.js`).

## 9. Documentation updated
`07_Database_Design.md` (§7 evidence audit + atomic complete; §9 action list), `08_API_Documentation.md` (item 10 Phase 3 note + explicit boundary), `15_Security.md` (§5 evidence idempotency/audit/ownership), `17_Backlog.md` (Phase 3 note under the E9 table), `18_DECISIONS.md` (ADR-019 Phase 3 note — no new decision), `19_CHANGELOG.md` (Phase 3 entry).

## 10. Explicit non-implementation confirmation
NOT implemented in Phase 3: AI/vision calls, crop/damage/severity detection, weather correlation, Open-Meteo historical weather, RAG, deterministic claim verification, claim approval/rejection logic, compensation, pHash, duplicate-image/fraud detection (including scoring), satellite imagery, MapLibre/polygon-drawing/frontend claim wizard, admin claim UI, notifications, legal ownership logic, new paid APIs/services, `claimassessment` writes, and any simulation of claim processing. No acreage is ever derived from images (P4); server geometry calculation remains the only authoritative area.

## 11. Blockers / deferred items
None blocking. Deferred by design (unchanged, documented): pHash/duplicate-evidence dedup (E9-S6), AI evidence analysis + weather correlation (E9-S4), deterministic verification engine + `claimassessment` writes + engine states (E9-S5, dep E9-S4), overlap/remaining-eligibility + `POST /claims/calculate-area` (E9-S3), frontend claim UI (E9-S8), admin endpoints (Phase 10). Evidence remains **explicitly optional at submit** (Phase 2 contract preserved — no client `evidenceUploaded` flag trusted).

## 12. READY FOR REVIEW: YES