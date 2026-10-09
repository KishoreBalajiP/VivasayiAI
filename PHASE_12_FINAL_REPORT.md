# Phase 12 (E12) — Land Ownership Verification — Final Report

Status: **implementation complete, all Phase 12 tests green, no regressions attributable to this phase.**
Scope discipline: the **first functional ownership workflow only**. It is built on the Phase 11 Verification
Evidence Foundation and does **not** implement satellite verification, authoritative/government land-record
integration, any new claim status, any new decision rule, or any engine change. No deployment, no commit/push/PR.

---

## 1. Phase 12 Result

Phase 12 lets a claimant **attach supporting land-ownership documents** to a claim they own, and lets a
**reviewer (admin) classify each document honestly** through a manual review — without making any legal
eligibility determination and without changing any claim lifecycle state, decision, area, or engine outcome.

It is the first phase to **write** the Phase 11 foundation: it uses `verificationevidences` rows with
`source: "OWNERSHIP"`. It adds **no new collection, no new claim state, no new decision rule, and no new
storage path** (document bytes reuse the existing private presigned-S3 pipeline), and it keeps `OWNERSHIP`
**non-operative** for the deterministic engine.

| Surface | Kind | Purpose |
|---|---|---|
| `utils/ownershipEvidence.js` | pure module (no DB) | ownership vocabulary, validation, review-outcome rules, fingerprint |
| `services/ownershipEvidence.service.js` | service | owner-scoped attach/list/url + admin review (audited, idempotent, CAS) |
| `controllers/ownership.controller.js` | controller | thin farmer + admin handlers |
| `tests/ownershipEvidence.unit.test.js` | test | 14 pure unit cases |
| `tests/ownership.evidence.test.js` | test | 21 end-to-end cases (mock S3 + mongodb-memory-server) |

Workflow at a glance:

1. Farmer uploads a document through the **existing** `POST /upload/presign` → Browser→S3 PUT →
   `POST /upload/:uploadId/complete` flow (owner-scoped `ImageRecord`, `status:"stored"`).
2. Farmer calls `POST /claims/:claimId/ownership` with `{ uploadId, documentCategory? }`. The service
   verifies the caller owns the claim **and** that the claim's parcel exists on the caller's own farm profile
   **and** that the document is a `stored` upload owned by the same caller; it creates a `PENDING` ownership row
   (`source:"OWNERSHIP"`) and appends a `ClaimAudit(ownership_evidence_submitted)`.
3. An admin (behind `requireRole("admin")`) calls
   `POST /admin/claims/:claimId/ownership/:evidenceId/review` to resolve the document to a terminal outcome,
   immutably recorded as `AdminAction(manual_review)` + `ClaimAudit(ownership_evidence_reviewed)`.
4. Owners read their attached documents (`GET .../ownership`, `GET .../ownership/:evidenceId/url`); admins read
   any claim's documents for review (`GET /admin/claims/:claimId/ownership`).

---

## 2. Existing Architecture Audit

The phase was designed by first auditing the current claim/verification stack. Key findings:

- **No pre-existing land-ownership implementation.** The only "ownership" concepts in the repo are the
  `cognitoSub` access-control scoping (`scripts/backfillOwnership.js` is a cognitoSub backfill, unrelated to
  land ownership) and the Phase 11 **non-operative** `OWNERSHIP` evidence source. There was nothing to reuse or
  extend for ownership documents.
- **The claim model is `models/LossClaim.js`** (frozen `CLAIM_STATES`). State changes are centralized in
  `services/claimState.service.js`. Phase 12 touches **neither**.
- **The generic evidence model exists** — `models/VerificationEvidence.js` + pure `utils/verificationEvidence.js`
  (vocabulary, `buildVerificationEvidence`, sanitization, forbidden-key guard). Reused as the persistence shape.
- **A private, AI-free upload pipeline exists** — `services/uploadPresign.service.js` (+ `routes/upload.js`):
  `POST /upload/presign`, `POST /upload/:uploadId/complete`, `GET /upload/:uploadId/view`, storing an
  owner-scoped `ImageRecord` with a server-owned `s3Key`. Reused for ownership document bytes (no new storage).
- **`ClaimEvidence` is image-specific** (feeds AI vision via the assessment). It was deliberately **not**
  polluted with ownership documents (doing so would feed them into the vision pipeline).
- **An admin/reviewer mechanism exists** — `middlewares/authorize.js#requireRole`, `/admin` mounted in
  `app.js` behind `requireAuth + requireRole("admin")`, `routes/admin.js` applying `adminLimiter`, and
  `models/AdminAction.js` (append-only; `action` incl. `manual_review`; `actorSub` from token). Reused.
- **`models/ClaimAudit.js`** (append-only; actor enum `farmer | engine | admin`) is the immutable trail. Reused.
- **Rate limiting** is per-user via `middlewares/rateLimit.js` (`evidenceLimiter`, `uploadLimiter`,
  `adminLimiter`). No new limiter was introduced.

Conclusion: reusing `VerificationEvidence` (source `OWNERSHIP`) + the existing private upload pipeline + the
existing admin role/action machinery was the correct, minimally-invasive shape. No claim status, decision,
geometry/area authority, or engine file was modified.

---

## 3. Files Changed

**Added (Phase 12):**
- `backend/utils/ownershipEvidence.js`
- `backend/services/ownershipEvidence.service.js`
- `backend/controllers/ownership.controller.js`
- `backend/tests/ownershipEvidence.unit.test.js`
- `backend/tests/ownership.evidence.test.js`
- `backend/PHASE_12_FINAL_REPORT.md` (this file)

**Modified (non-behavioral wiring + docs):**
- `backend/routes/claims.js` — added three owner-scoped farmer ownership routes.
- `backend/routes/admin.js` — added two admin-only ownership routes.
- `backend/utils/validation.schemas.js` — added `ownershipBody`, `ownershipEvidenceParams`,
  `ownershipReviewBody` (zod), importing the ownership vocabulary.
- `backend/docs/architecture/07_Database_Design.md` — overview-table row + new §9A.1 (Phase 12 ownership).
- `backend/docs/architecture/08_API_Documentation.md` — endpoint list + a Phase 12 status note.

**Explicitly NOT modified:** `models/LossClaim.js`, `models/ClaimAssessment.js`,
`models/ClaimEvidence.js`, `models/FarmProfile.js`, `models/ClaimAudit.js`, `models/AdminAction.js`,
`models/VerificationEvidence.js`, `services/claimVerificationEngine.service.js`,
`services/claimVerification.service.js`, `services/claimState.service.js`, `services/claim.service.js`,
`services/uploadPresign.service.js`, `services/s3.service.js`, `middlewares/*`, `app.js`,
`controllers/claim.controller.js`, `controllers/admin.controller.js`. The deterministic engine, the frozen
claim states, and the AI-only field contract are untouched.

---

## 4. Ownership Evidence Model

**Persisted shape** (rows in `verificationevidences`, `source = "OWNERSHIP"`):

```
claimId           ObjectId      (ref LossClaim)
source            "OWNERSHIP"
status            "PENDING" → one of AVAILABLE | VERIFIED | INSUFFICIENT | INCONSISTENT | UNAVAILABLE
reference         String        = the document's uploadId (opaque; never an s3Key/signed URL)
metadata          { parcelId, documentCategory, mediaType, size }   (validated + sanitized)
evidenceVersion   fingerprint of { uploadId, mediaType, size }      (sha1)
evaluationVersion "1"
idempotencyKey    "owndoc_<uploadId>"                               (derived)
result            after review: { verificationMethod, authoritative, reviewedByRole, reviewedAt, reason }
provider          "admin-manual-review" after review (labels WHO produced the outcome, not authority)
```

**Vocabulary** (`utils/ownershipEvidence.js`, pure):

- Document categories: `land_record | ownership_deed | lease_agreement | authorization_letter |
  tax_receipt | identity_proof | other` (default `other`).
- Review statuses: `AVAILABLE | VERIFIED | INSUFFICIENT | INCONSISTENT | UNAVAILABLE`. `PENDING`/`NOT_CHECKED`
  are **not** review outcomes.
- Verification methods: `manual_review` only. `OWNERSHIP_AUTHORITATIVE_METHODS = []` (none configured).
- `resolveOwnershipReviewOutcome({ status, method })` refuses `VERIFIED` while no authoritative method exists
  (returns a clear `400` reason). `OWNERSHIP_FOUNDATION_VERSION = "1"`.

**Honest semantics.** Attaching a document is **not** verification: it is recorded `PENDING` and can only be
resolved by an admin. `AVAILABLE` means "present/consistent on manual review", explicitly
`authoritative: false` — not a legal determination. `VERIFIED` is reserved for a future authoritative provider
and is currently **unreachable**. No ownership eligibility rule (owner vs. representative, tenancy, succession)
is invented, because the repository defines none.

---

## 5. Backward Compatibility

- **Additive only.** Existing claims need no ownership rows; `GET /claims/:claimId/ownership` returns an empty
  list and a valid summary for a legacy claim (`OW-19`). No migration, no reset; rollback = drop the
  `source:"OWNERSHIP"` rows.
- **No claim/decision coupling.** After attach **and** an `AVAILABLE` review, the claim stays `draft`, its
  `claimedAreaAcres` is unchanged, and `assessment` is still `null` (`OW-18`).
- **Engine untouched.** `OWNERSHIP` remains excluded from `OPERATIVE_EVIDENCE_SOURCES`
  (`["GEOMETRY","AI_IMAGE","WEATHER"]`), so the deterministic engine's outputs are byte-for-byte identical
  (`OW-21`). Phase 11's internal `verificationEvidence.service.js` is unchanged and still works.
- **Existing pipeline reuse.** Document bytes flow through the existing `/upload` presign pipeline; no new
  storage code, no change to `/upload` behavior.

---

## 6. Security & Authorization

- **Ownership scoping.** Farmer routes resolve the claim through `findOwned(cognitoSub, claimId)`; foreign/
  unowned claims → **404** (not 403), matching the existing IDOR convention (`OW-06`, `OW-15`, `OW-17`).
- **No cross-user document attach.** The attached `uploadId` must be a `stored` `ImageRecord` owned by the
  **same** caller (`ImageRecord.findOne({ uploadId, cognitoSub })`); a foreign uploadId → **404** (`OW-05`).
  A not-yet-stored upload also → **404** (`OW-20`).
- **Parcel relationship validated server-side.** The claim's `parcelId` must exist on the caller's own
  `FarmProfile`; otherwise `404` — the client can never assert parcel ownership.
- **No self-verification.** Review is admin-only at the route (`requireRole("admin")`, `OW-08`) **and** guarded
  defensively in the service (`actorRole !== "admin"` → 403). A farmer cannot advance a document past `PENDING`.
- **No sensitive data exposure.** `s3Key`/bucket/signed URLs are never stored on the row; signed GET URLs are
  minted on demand, owner-scoped, with the existing short TTL. Serialization exposes only opaque `reference`
  (= uploadId), safe `metadata`, and the review `result`.
- **Boundary validation.** zod validates body/params; `utils/ownershipEvidence.js` re-validates categories,
  uploadId format, and reason length; `validateEvidencePayload`/`sanitizeEvidencePayload` (Phase 11) enforce the
  forbidden-key and size/depth caps.
- **No new global rate limit / no loosening.** Attach reuses `evidenceLimiter`; admin operations reuse
  `adminLimiter`; GETs are unmetered like other reads. Existing limits are unchanged.

---

## 7. Idempotency & Concurrency

- **Attach idempotency.** The derived key `owndoc_<uploadId>` sits on the Phase 11 partial-unique index
  `{ claimId, idempotencyKey }`, so re-attaching the same document returns the existing row
  (`idempotent: true`) with **no** duplicate row and **no** duplicate audit (`OW-07`). Concurrent duplicate
  attaches are recovered from the `11000` duplicate-key path.
- **Review race-safety.** Review uses an atomic compare-and-swap
  (`findOneAndUpdate` with `status ∈ {PENDING, NOT_CHECKED}`). Under four concurrent conflicting reviews,
  exactly one applies and exactly one `AdminAction` is written; the others receive `409` (`OW-14`).
- **Review replay-safety.** A terminally reviewed document cannot change outcome (`409`); an identical replay
  returns the existing row (`idempotent: true`) without a second `AdminAction` (`OW-13`). The `AdminAction`
  carries a deterministic `idempotencyKey = "ownreview_<evidenceId>"`, which also avoids the `AdminAction`
  sparse-unique-`null` collision across multiple reviews on the same claim.

---

## 8. Audit Trail

- **Attach:** `ClaimAudit { actor:"farmer", action:"ownership_evidence_submitted", fromState: claim.state,
  toState: claim.state, metadata:{ evidenceId, uploadId, parcelId, documentCategory, mediaType, size },
  requestId }` (`OW-01`).
- **Review:** immutable `AdminAction { action:"manual_review", actorSub (from token), actorEmail, priorState,
  targetState, reason, idempotencyKey, metadata:{ ownershipEvidenceId, uploadId, method, authoritative },
  requestId }` **and** `ClaimAudit { actor:"admin", action:"ownership_evidence_reviewed", fromState: claim.state,
  toState: claim.state, metadata:{ evidenceId, uploadId, fromStatus, toStatus, method, authoritative,
  adminActionId }, requestId }` (`OW-09`).
- `ClaimAudit` and `AdminAction` remain append-only (pre-hooks reject update/delete). No ownership path updates
  or deletes an existing audit row.

---

## 9. Tests

Commands (Windows PowerShell, `backend/`):

```
npx vitest run tests/ownershipEvidence.unit.test.js tests/ownership.evidence.test.js --no-file-parallelism
npx vitest run --no-file-parallelism
```

**New Phase 12 tests: 35 total (14 unit + 21 end-to-end), all green.** Coverage maps to the mandated
scenarios:

- ownership evidence creation + correct fields/`operative:false` (`OW-01`); valid/invalid category (`OW-02/03`);
  uploadId validation (`OW-04`); parcel/claim/user relationship validation (`OW-05/06`);
- cross-user access rejection (attach foreign doc, attach to foreign claim, foreign list, foreign url)
  (`OW-05/06/15/17`); unauthorized verification mutation / self-verify prevention (`OW-08`);
- document private-storage authorization + completion idempotency (`OW-07`, `OW-20`); concurrent transitions
  (`OW-14`); audit append-only integration (`OW-01/09`);
- valid review outcomes incl. pending-review-until-admin (`OW-09/11`); honest incomplete/inconsistent handling
  (`OW-11`); no fabricated results / `VERIFIED` refused when no authoritative provider (`OW-10`);
- legacy claim without ownership evidence (`OW-19`); Phase 11 evidence compatibility + ownership does not
  change deterministic outcomes (`OW-18/21`); existing lifecycle/overclaim regression via the full suite (§10).

---

## 10. Full-Suite Regression

- **Full backend suite** (`--no-file-parallelism`; required because parallel `mongodb-memory-server` instances
  exhaust the local machine): **519 passed / 8 failed / 527 total** across 20 test files.
- The 8 failures are **all** in `tests/ai.503.test.js`, which forces `IMAGE_STORAGE_MODE=live`; with no
  `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`S3_BUCKET` locally, the presign step returns a sanitized 500.
  These are **environmental, not regressions** — the same 8 failures were documented in Phase 11, and the suite
  imports no Phase 12 code.
- **No regressions in frozen surfaces:** the deterministic engine suites, claim lifecycle/API suites, evidence
  suites, and admin suites all pass unchanged. Net change vs. Phase 11: **+35 passing / +35 total** (492 → 527),
  i.e., exactly the new Phase 12 tests.

> Note: the backend has no ESLint/`tsc` configuration (plain ESM JavaScript; no `lint`/`typecheck` script), so
> there is no separate lint/type gate to run. Verified by running the full vitest suite above.

---

## 11. `/claims` 429

Unchanged from Phase 11. Phase 12 adds **no** claim route to the shared `claimLimiter` (the ownership routes use
`evidenceLimiter`/`adminLimiter`/unmetered GETs), so it does not worsen the documented shared-budget issue
(polling `GET /claims/:id` drains the same 5/hour budget as claim mutations). Per directive, no rate-limit
change was made; the recommendation to split read vs. mutation budgets remains a separate follow-up.

---

## 12. Not Implemented (explicit scope exclusions)

- **No satellite verification / remote-sensing / satellite APIs** (reserved for a later phase; `SATELLITE`
  stays non-operative).
- **No authoritative or government land-record verification.** There is no provider integration, so `VERIFIED`
  is unreachable and is refused by design.
- **No legal/eligibility determination.** No ownership rules were invented; the workflow records + reviews
  evidence only. It does not model "owner" vs "authorized representative" eligibility.
- **No change to claim statuses, decision precedence, claimed acreage, or parcel geometry**; ownership is never
  consumed by the engine.
- **No auto-approve/reject**, no fabricated historical evidence, no compensation logic.
- **No document-format expansion.** Documents reuse the existing image pipeline (JPEG/PNG/WEBP, size-capped,
  normalized) — PDFs are not supported, because adding them would require broadening the shared upload pipeline
  (explicitly avoided). Notes: normalized images may be dimension-capped/EXIF-stripped by the existing pipeline.
- **No deployment, no AWS changes, no commit/push/PR.**

---

## 13. Remaining Work — Next Phase

- **Authoritative ownership verification provider.** Introduce a real registry/authoritative source, register
  its method in `OWNERSHIP_AUTHORITATIVE_METHODS`, and only then allow `VERIFIED` (with provider/version
  metadata). Until then, `VERIFIED` remains correctly unreachable.
- **Reviewer workflow polish** (optional): surface ownership documents inside the admin claim detail /
  review queue, and optionally let the farmer see review outcomes in-app.
- **Document formats** (if required): extend the private upload pipeline to accept PDFs (with size limits and
  validation) before supporting scanned land records.
- **Satellite verification** remains the separate `SATELLITE` source, still non-operative until its own phase.
- **`/claims` read-vs-mutation rate-limit split** (carried over): give read routes their own limiter or exclude
  polling reads from the mutation budget.

---

READY FOR REVIEW: YES
