# Phase 11 (E11-S11) — Verification Evidence Foundation — Final Report

Status: **implementation complete, all Phase 11 tests green, no regressions attributable to this phase.**
Scope discipline: foundation only. No satellite/ownership/remote-sensing/gov-record integration, no new claim
statuses, no new decision rules, no compensation logic, no deployment, no commit/push.

---

## 1. Phase 11 Result

Phase 11 adds a **backward-compatible, reusable, auditable, source-neutral "verification evidence" abstraction** to
the existing claim-verification system. It generalizes the notion of evidence beyond the image-specific
`claimevidence` collection so that future phases (ownership, satellite, weather expansion) can share one shape,
one vocabulary, and one audit trail — **without changing any engine behavior, claim status, or outcome**.

Delivered as an **internal** foundation (no public API):

| Surface | Kind | Purpose |
|---|---|---|
| `utils/verificationEvidence.js` | pure module (no DB) | vocabulary, validation, sanitization, projection |
| `models/VerificationEvidence.js` | Mongoose model (new collection) | persists generic evidence rows |
| `services/verificationEvidence.service.js` | internal service (no route) | owner-scoped, audited, idempotent reads/writes |
| `tests/verificationEvidence.unit.test.js` | test | 20 pure unit cases |
| `tests/verificationEvidence.test.js` | test | 14 Mongo-backed service cases |

`GEOMETRY`, `AI_IMAGE`, `WEATHER` are **operative** (they already feed the engine). `OWNERSHIP` and `SATELLITE`
are **representable but non-operative** — persisted for later phases, and provably ignored by every decision today.

---

## 2. Existing Architecture Audit

The phase was designed by first auditing the current claim/verification stack so the new abstraction matches
existing conventions instead of inventing parallel ones.

- **Claim lifecycle** — `models/LossClaim.js` owns the frozen `CLAIM_STATES` vocabulary. State transitions are
  centralized in `services/claimState.service.js` (`applyTransition`). This phase does **not** touch either.
- **Existing evidence** — `models/ClaimEvidence.js` is image-specific (owner-scoped, presigned-S3 lifecycle,
  `s3Key`/`mediaType`). It **cannot** represent `GEOMETRY`/`WEATHER`/`OWNERSHIP`/`SATELLITE`. Hence a new,
  source-neutral collection rather than overloading `claimevidence`.
- **Verification engine** — `services/claimVerificationEngine.service.js` is a **pure** function
  (`evaluateClaimVerification`, `VERIFICATION_ENGINE_VERSION = "2"`); `services/claimVerification.service.js`
  orchestrates it (loads authoritative claim/evidence/assessment, persists the decision into `claimassessment`,
  advances state via `claimState.service.js`). Geometry remains the **only** area authority.
- **Audit** — `models/ClaimAudit.js` is append-only (pre-hooks throw on update/delete), actor enum
  `["farmer","engine","admin"]`, free-form `action`, `metadata` Object, `requestId`. The foundation **reuses** it.
- **Ownership scoping** — `services/claim.service.js` (`findOwned`, IDOR → 404) is the established pattern; the new
  service reuses it for every operation.
- **Rate limiting** — `middlewares/rateLimit.js` exposes `claimLimiter` / `evidenceLimiter`; `routes/claims.js`
  wires them per route. This phase adds **no route**, so limiters are unchanged.
- **Field-contract guardrails** — AI never produces acreage/boundary/affected polygon/remaining area/approved
  area/compensation/final status. The foundation stores evidence **describe-only** data and grants no decision power.

Conclusion: an additive collection + internal service was the correct, minimally-invasive shape; no existing
model, service, route, controller, or engine file was modified.

---

## 3. Files Changed

**Added (Phase 11):**
- `backend/utils/verificationEvidence.js`
- `backend/models/VerificationEvidence.js`
- `backend/services/verificationEvidence.service.js`
- `backend/tests/verificationEvidence.unit.test.js`
- `backend/tests/verificationEvidence.test.js`
- `backend/PHASE_11_FINAL_REPORT.md` (this file)

**Modified (documentation only — non-behavioral):**
- `backend/docs/architecture/07_Database_Design.md` — added `verificationevidences` to the collections overview and
  a new §9A describing the collection, indexes, operative/non-operative split, security, and backward compatibility.
- `backend/docs/architecture/08_API_Documentation.md` — added a Phase 11 status note stating **no public API change**.

**Explicitly NOT modified:** `models/LossClaim.js`, `models/ClaimEvidence.js`, `models/ClaimAssessment.js`,
`models/ClaimAudit.js`, `services/claimVerificationEngine.service.js`, `services/claimVerification.service.js`,
`services/claimState.service.js`, `controllers/claim.controller.js`, `routes/claims.js`, `middlewares/rateLimit.js`,
`app.js`. Verified: no file outside the list above references the new module.

---

## 4. Evidence Model

**Vocabulary (frozen for this phase):**

- `EVIDENCE_SOURCES` = `GEOMETRY`, `AI_IMAGE`, `WEATHER`, `OWNERSHIP`, `SATELLITE`
- `EVIDENCE_STATUSES` = `NOT_CHECKED`, `PENDING`, `AVAILABLE`, `VERIFIED`, `INSUFFICIENT`, `INCONSISTENT`,
  `UNAVAILABLE`
- `OPERATIVE_EVIDENCE_SOURCES` = `GEOMETRY`, `AI_IMAGE`, `WEATHER`; `FUTURE_EVIDENCE_SOURCES` = `OWNERSHIP`,
  `SATELLITE`
- `EVIDENCE_FOUNDATION_VERSION = "1"`

**Collection `verificationevidences`:**

```
claimId (ref LossClaim, indexed) | source (enum) | status (enum, default NOT_CHECKED)
confidence (Number|null, 0..1) | observedAt (Date) | provider | providerVersion
evidenceVersion | evaluationVersion | reference | metadata (Object) | result (Object)
idempotencyKey (String|null) | timestamps: true
```

- **Indexes:** `{ claimId, source, createdAt: -1 }`; unique **partial** `{ claimId, idempotencyKey }` filtered to
  `idempotencyKey: { $type: "string" }`.
- **Pure helpers:** `buildVerificationEvidence` (validates; throws `ApiError.badRequest` 400),
  `validate/sanitizeEvidencePayload`, `projectExistingEvidence`.
- **Projection:** `projectExistingEvidence` read-only-derives `GEOMETRY` (from the claim's authoritative geometry),
  `AI_IMAGE` (from stored `ClaimEvidence` + `ClaimAssessment.aiImageAssessments`, with status mapping), and
  `WEATHER` (from `ClaimAssessment.weatherCorrelation`). It **never** fabricates `OWNERSHIP`/`SATELLITE` history.

---

## 5. Backward Compatibility

- **Existing claims need no new rows.** A legacy claim (`P11-10`) renders an empty `persisted` list and a valid
  view, projects its existing `GEOMETRY` evidence, and its `LossClaim` document is unchanged
  (`state: submitted`, `claimedAreaAcres` intact).
- **No destructive migration / no reset.** The new collection is additive; rollback = drop `verificationevidences`.
- **No fabricated historical evidence.** Projection only mirrors records that already exist.
- **No behavioral coupling.** Recording `OWNERSHIP`/`SATELLITE` rows provably leaves the deterministic engine's
  output byte-for-byte identical (`P11-14/15`).
- **No new public API**, so no client contract changes.

---

## 6. Security

- **Ownership scoping.** Every operation resolves the claim through `findOwned(cognitoSub, claimId)`; foreign
  access → **404** (not 403), matching the existing IDOR convention. Covers record, list, view, and status-update.
- **Boundary validation.** Source/status enum-checked; confidence range-checked; malformed payloads → **400**.
- **Sanitization caps.** `metadata`/`result` ≤ 4096 bytes, depth ≤ 4, strings ≤ 512, arrays ≤ 64.
- **Forbidden keys rejected** (no storage/PII/infra leakage): `s3Key`, `bucket`, `cognitoSub`, `token`, `secret`,
  `prompt`, `image`, `url`, and related — enforced recursively.
- **Auditability.** Every write appends a `ClaimAudit` row (`evidence_recorded` / `evidence_status_updated`, actor
  `engine`, `fromStatus`/`toStatus`, `requestId`); tests assert the metadata contains **no** `s3Key`.
- **Idempotency.** Claim-scoped `idempotencyKey` (`[A-Za-z0-9_-]{8,64}`) makes duplicate operations safe; no
  duplicate rows or audit noise.
- **Reused protections.** Existing authorization, sanitized errors, rate limiting, and PII/S3 protections are
  untouched and still apply to the surrounding claim surface.

---

## 7. Tests

Commands (Windows PowerShell, backend root):

```
npx vitest run tests/verificationEvidence.unit.test.js tests/verificationEvidence.test.js
npx vitest run --no-file-parallelism
```

- **New Phase 11 tests: 34 total** — 20 pure unit + 14 Mongo-backed service cases, all passing.
- Service coverage maps to the mandated scenarios: each source accepted (`P11-01`); invalid source/status rejected
  (`P11-02/03/04`); evidence bound to the correct claim (`P11-05`); ownership scoping (`P11-06`); metadata
  validation (`P11-07`); provider/version metadata round-trip (`P11-08`); auditability (`P11-09`); legacy claims
  without the foundation (`P11-10`); `AI_IMAGE`/`WEATHER`/`GEOMETRY` compatibility via projection (`P11-11/12/13`);
  `OWNERSHIP`/`SATELLITE` never change a decision (`P11-14/15`); deterministic outcomes unchanged (`P11-16`);
  idempotent duplicate operations (`P11-17`); unauthorized access rejected (`P11-18`).

One model-index fix was required during implementation: `idempotencyKey` defaults to `null`, which a **sparse**
unique index still treats as present (collides). Replaced with a **partial** unique index on
`idempotencyKey: { $type: "string" }`.

---

## 8. Verification Regression

- **Full backend suite** (`--no-file-parallelism`, required because parallel `mongodb-memory-server` instances
  exhaust the local machine): **484 passed / 8 failed / 492 total** across 18 test files.
- **All 8 failures are environmental, not regressions.** They live in `tests/ai.503.test.js`, which forces
  `IMAGE_STORAGE_MODE=live`; with no `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`S3_BUCKET` present locally, the
  presign step returns a sanitized 500. That suite **imports no Phase 11 code** (verified), and the failure is at
  the S3 presign seam, unrelated to this phase. It requires real AWS credentials to pass.
- **No regressions in the frozen surfaces:** the deterministic engine suites
  (`claim.verificationEngine.test.js`, `claim.verificationEngine.phase9.test.js`), claim API suites, evidence
  suites, and admin suites all pass unchanged.

> Note on counts: prior-phase reports cite a "425" backend figure from an earlier environment/run; the current
> tree executes 18 files / 492 tests, of which the 34 new Phase 11 tests are additive and green.

---

## 9. `/claims` 429 Investigation

**Finding (documented as a separate issue; rate limits were deliberately NOT changed):**

- In `middlewares/rateLimit.js`, `claimLimiter` defaults to `max = env.claimRateLimitMax || 5` per hour
  (`windowMs = 3600000`) keyed by `cognitoSub`, with a single shared limiter instance.
- In `routes/claims.js`, **all** claim routes reuse that same instance — including `GET /` (list) and
  `GET /:claimId` (detail) — plus create/submit/withdraw/resubmit/verify/appeal.
- The claim-detail UI polls `GET /:claimId` (`frontend/src/components/ClaimsPage.tsx`, `setInterval` ~3s up to
  `MAX_RESULT_POLLS = 20` via `getClaim`) while a verification is in progress. This polling consumes the **same**
  5/hour budget as list/create, so a user can exhaust the budget and receive `429`.
- **No infinite loop was found.** `loadClaims` is a stable `useCallback([])`, and its effect deps are
  `[loadClaims, retryKey]`.
- **Decision:** this is a rate-limit budget/route-sharing design issue, not a Phase 11 defect. Per directive, no
  production rate-limit change was made. Recommended separate follow-up: give read routes (list/detail) their own
  limiter or exclude polling reads from the mutation budget.

---

## 10. Not Implemented (explicitly out of scope this phase)

- No satellite verification, remote-sensing integration, or satellite APIs/providers.
- No land-ownership verification or government land-record integration.
- No new claim statuses and no new claim decision rules.
- No compensation logic; no AI acreage/boundary/affected-polygon estimation.
- No change to automatic approval behavior or admin/frontend redesign.
- No deployment, no AWS changes, no commit/push/PR.
- `OWNERSHIP`/`SATELLITE` are stored/represented only and never influence decisions.

---

## 11. Remaining Next Phase

**Phase 12 — Ownership Verification on this foundation.** Build the first *operative* future source on the
abstraction delivered here: an ownership evidence provider that records `OWNERSHIP` evidence through
`verificationEvidence.service.js`, with its own owner-scoped ingestion, provider/version metadata, and audit — then
(only when explicitly specified) discuss whether/how ownership evidence may participate in decisions. The
non-operative `SATELLITE` source remains reserved for a later phase.

---

READY FOR REVIEW: YES
