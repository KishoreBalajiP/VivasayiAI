# Frontend contract: backend changes, October 2026

The frontend lives in a separate repository, so this is the list of what changed in the API and what the UI
needs to do about it. Everything is **additive** unless marked **Behaviour change**. Existing clients keep
working; none of these fields is required for them.

Status: implemented and tested in the backend on branch `feat/verification-hardening-2026-10`; not deployed.

> **Status correction (2026-10-17).** This document's branch and commit statements describe the state when it was written. The October hardening work it describes was later committed to `develop` as `b760596` and `6dbe6b8` (both "initial commit", 16 October 2026) and pushed to `origin/develop`. `git branch -a --contains 6dbe6b8` lists only `develop` and `origin/develop`: it is **not on `main`, so CI has not deployed it**. The local branch `feat/verification-hardening-2026-10` still exists but is not the working branch. The later 2026-10 completion work (policy `v1.1-safe-ai` as the default, the durable enqueue, the scheduled worker, the progress contract, the tracker, the hermetic e2e harness) is **uncommitted in the working trees** of both repositories on `develop`, pending owner review; nothing is deployed. Current status: [ACCEPTANCE_MATRIX_2026-10-17.md](../engineering/ACCEPTANCE_MATRIX_2026-10-17.md) and [KNOWN_ISSUES.md](../engineering/KNOWN_ISSUES.md).


## 1. Claims

### 1.1 New request field: `claimantRelationship` (`POST /claims`)
Optional. One of `owner`, `joint_owner`, `tenant`, `authorised_cultivator`, `heir`. Any other value gives 400.
It decides which documents the claim is expected to have, so ask for it when the claim is created:

| Relationship | Documents expected (provisional, not reviewed by a legal or insurer authority) |
|---|---|
| `owner` | a land record **or** an ownership deed |
| `joint_owner` | a land record **or** an ownership deed |
| `tenant` | a lease agreement, **and** a land record, deed or tax receipt |
| `authorised_cultivator` | an authorization letter |
| `heir` | a land record or deed, **and** an identity proof or other supporting document |

The claim response now includes `claimantRelationship` (`null` when not given). Document categories sent to
`POST /claims/:id/ownership` are `land_record`, `ownership_deed`, `lease_agreement`, `authorization_letter`,
`tax_receipt`, `identity_proof`, `other`.

### 1.2 New decision fields (`POST /claims/:id/verify`, and `assessment` inside `GET /claims/:id`)

| Field | Meaning |
|---|---|
| `held` | `true` when a required part of the claim is unresolved. **There is no decision yet**: the claim state is still `submitted` and the farmer can still withdraw. |
| `pendingComponents` | `[{ component, outcome, action }]`. What is holding the claim. `action` is `hold` (a person or provider must resolve it) or `more_evidence_required` (the farmer can act). |
| `components` | Per-component status (below), or `null` for claims decided before this change. |
| `policyId`, `policyHash` | Which rules produced the decision. `policyId` is `"legacy"` for older decisions. |

When `held` is true, `outcome` and `decision` on the `/verify` response are `null`, and `assessment.state` inside `GET /claims/:id` is `null`. The `/verify` response has no `state` field; its `claimState` is the claim state, `submitted`. A claim held after a resubmission no longer carries the previous round's decision (fixed 16 October 2026). Do not show "rejected" or "approved".

**`components`** is an object keyed by `parcel_identity`, `claimant_rights`, `land_documents`, `geometry`, `crop`,
`satellite`, `photos`, `weather`, `overlap`, `manual_review`. Each value:

```json
{ "outcome": "pending", "required": true, "authoritative": false, "actionableBy": "reviewer", "reasonCodes": ["document_awaiting_manual_review"] }
```

`outcome` is one of the seven values below. `actionableBy` is `farmer`, `reviewer`, `system` or `null`.
`reasonCodes` are stable identifiers for display or logging, for example
`missing_document_category:lease_agreement`, `outside_registered_parcel`, `overlaps_other_farmers_claim`,
`satellite_unavailable_or_disabled`.

### 1.3 What to tell the farmer

| `outcome` | Meaning | Suggested wording |
|---|---|---|
| `verified` | Checked and fine | "Checked" |
| `unverified` | Nothing provided yet (when `actionableBy` is `farmer`) | "We still need: *what*" using `reasonCodes` |
| `pending` | Waiting for a review or a result | "Waiting for review" |
| `requires_review` | A person must look | "A reviewer will check this" |
| `unavailable` | A check could not run (provider down or not configured) | "Could not be checked yet. This is not a problem with your claim." |
| `inconclusive` | Checked but not enough to say | "Not enough information. This does not count against you." |
| `failed` | Something contradicts the claim | "Does not match: *what*. Please correct or add evidence." |

Rules for the UI: never describe `unavailable` or `inconclusive` as a failure; satellite and weather are
supporting evidence and are never `failed`; `authoritative: false` means the check is not an official
verification, so do not label it "official" or "government verified".

### 1.4 Held claims
A held claim stays `submitted`. `POST /claims/:id/verify` can be called again at any time and returns the
current situation; repeated calls do not create extra audit entries. If a reviewer accepts a document the next
verify decides. A claim held longer than the policy's maximum is escalated to a review case automatically.

## 2. Rate limits (**Behaviour change**)
Reads (`GET /claims`, `GET /claims/:id`, `GET /claims/:id/verification`, `GET /claims/:id/appeal`) now have their
own, larger per-user limit (default 600 per hour). They no longer use up the strict creating/submitting limit
(default 5 per hour), which previously locked farmers out after a few status polls. A `429` response still
means "slow down"; the write limit is unchanged.

## 3. Verification status and satellite endpoints
- `GET /claims/:id/verification` may also advance one queued verification step (polling makes progress).
  Poll every 10 s or slower while a claim is `submitted`.
- `POST /claims/:id/verification/satellite` now returns a **summary only**:
  `{ recorded, evidence, idempotent, outcome, analysisOutcome }` or `{ recorded: false, skipped, retryAfter }`.
  It no longer returns scenes, request shapes or provider internals. `analysisOutcome` is `SUPPORTS_LOSS`,
  `NO_CHANGE` or `INCONCLUSIVE`; `NO_CHANGE` does **not** mean the claim is false.
- `POST /claims/:id/verification/official-land-record` ignores any request body. It uses the stored reading of the
  farmer's own document and returns `409` if no document has been examined. Official records are not available, so
  expect `unavailable`, not a match.
- `GET /claims/:id/ownership` lists only documents the farmer attached (not automated review cases).
- Ownership documents are attached with `POST /claims/:id/ownership` `{ uploadId, documentCategory? }`. The `uploadId` comes from the generic `/upload/presign` → PUT → `/upload/:uploadId/complete` flow, which accepts **JPEG, PNG and WebP only**: a PDF land record must be photographed or scanned to an image. These uploads count against the same per-user upload limit as chat images. `documentCategory` is one of `land_record`, `ownership_deed`, `lease_agreement`, `authorization_letter`, `tax_receipt`, `identity_proof`, `other`. The category decides whether the claimant relationship's required documents are present, so send it.
- `GET /claims/:id/appeal` returns `200 { appeal: null }` when there is no appeal, and also for a claim that is not the caller's. It never reveals another farmer's appeal.

## 4. Chat

### 4.1 Request (`POST /chat`)
- `parcelId` (optional string): the parcel the question is about. Send it when the farmer has several parcels and
  the question depends on which one. A parcel id that is not the caller's is ignored, not an error.
- `language` (optional `en` or `ta`): now honoured for text chat as well as photo turns. Without it the reply
  follows the message's script, then the profile language.
- Voice input should be sent as the transcribed text through the same endpoint. The backend has no
  speech-to-text or text-to-speech.

### 4.2 Response additions
- `sources`: `[{ filename }]`, the knowledge documents the answer was grounded in; empty when nothing was retrieved.
- `meta`: `{ intent, sufficient, followUpSlot, loaded, language, latencyMs: { context, rag, model, total }, tokens }`.
  Intended for diagnostics. `followUpSlot` is `crop` or `district` when the assistant asked a question.
- The assistant now asks **at most one** follow-up and only when it cannot resolve a required detail from the
  farmer's own records. When several crops or parcels are possible it asks *which*, not "what crop".

### 4.3 Sessions
- `POST /chatsessions/:id/message` accepts the same senders as before, but messages with sender `ai` or `system`
  are stored as client-authored and are **not replayed to the model** as earlier assistant turns. Do not rely on
  appending assistant messages to influence later answers.
- Image diagnosis is unchanged except that it now uses the farmer's district, weather and forecast. Image turns do **not** accept `parcelId` and return no `sources` or `meta`.

### 4.4 Errors
- `503` with "AI service is busy. Please try again later." means the model provider refused the call for quota or overload. It is not a timeout and not a fault in the request. Show a "try again in a few minutes" message and do not retry immediately. Before 16 October 2026 this case reached the client as a `500` "did not respond in time".

## 5. Auth (**Behaviour change**)
`POST /auth/google` now returns distinct statuses instead of always `500`:

| Status | Meaning |
|---|---|
| `401` | The authorization code was rejected or expired, or the ID token failed verification |
| `403` | The email is not verified, so the account cannot be linked |
| `409` | The email is already linked to a different account |
| `502` | The identity provider could not be reached; retry |
| `500` | Unexpected server error |

Other status changes: oversized JSON bodies return `413` and unsupported encodings `415` (previously `500`).

## 6. Admin
- `GET /admin/claims/:id` now returns working short-lived `evidenceUrls` (`[{ uploadId, url, expiresIn }]`);
  previously the list was always empty or contained undefined URLs.
- `POST /admin/claims/:id/override`: `overrideKey` values starting with `ownreview_`, `ovr_auto_` or `mrdecision_`
  are rejected with `400`. A losing concurrent override returns `409` ("Claim state changed...") rather than `500`;
  reload and retry. A repeated request with the same `overrideKey` returns the recorded result with
  `idempotent: true`.
- New: `GET /admin/claims/:id/review-cases` and `POST /admin/claims/:id/review-cases/:caseId/decision` with
  `{ decision: "AVAILABLE" | "INSUFFICIENT" | "INCONSISTENT" | "UNAVAILABLE", reason }` (`reason` at least 10
  characters). `VERIFIED` is not accepted: a manual review cannot make evidence authoritative. A case resolves
  once (`409` on a second decision).
- Admin detail's audit list can now contain `verification_held`, `cross_farmer_overlap_flagged` (with the other
  claims' details; **never show these to farmers**), `verification_released` and `review_required` entries.

## 7. Not available, so do not build UI that assumes it
- Official government land-record verification.
- Satellite evidence as a decision input. It now runs live (16 October 2026 case studies), but it is supporting-only and uncalibrated: a harvest produced a false "supports loss". Never present it to the farmer as proof.
- Soil data (the assistant recommends a soil test).
- Text-to-speech or speech recognition on the backend.
