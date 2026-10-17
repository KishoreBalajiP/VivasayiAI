# Farmer progress contract `progress-v1` (ADR-022)

**Status:** implemented on the backend (2026-10-16, uncommitted working tree), not deployed. *Updated 2026-10-17:* the frontend tracker now consumes it from a byte-identical copy (`VivasayiAI-Frontend/src/contracts/progress-contract-v1.json`, checked by `npm run contract:check`; audit B confirmed the two files are identical).

**Files that make up the contract:**

| File | What it is |
|---|---|
| `services/claimProgress.js` | The pure builder (`buildFarmerProgress`, `buildSatelliteDisplay`) and the vocabulary |
| `services/claimProgress.service.js` | Loads the claim's rows and calls the builder (read-only) |
| `docs/architecture/progress-contract-v1.json` | **The machine-readable vocabulary.** Every stage × status × explanation key, every action, every satellite status and reason code, every overall status. Generated from the builder; the frontend copies it. |
| `docs/architecture/progress-v1.example.json` | The builder's output for 20 named scenarios, plus one full response. Generated; the frontend's fixture. |
| `tests/fixtures/progressScenarios.js` | The scenarios. `VIVASAYI_SKIP_DOTENV=1 node tests/fixtures/progressScenarios.js --write` regenerates both JSON files. |

`tests/progressContract.unit.test.js` (PRG-10) fails if the builder emits a value that is not in the JSON, if the JSON lists a value the builder never emits, or if either generated file is stale.

## Endpoints

| Endpoint | Who | Notes |
|---|---|---|
| `GET /claims/:claimId/progress` | the claim's owner | Read rate limit (`claimReadLimiter`). Another farmer, or an unknown id, gets 404 before anything runs. With `CLAIM_VERIFICATION_DRAIN_ON_READ=true` the owner's read also runs one due step. Response: `{ statusCode, message: "Claim progress fetched", data: { progress } }`. |
| `GET /claims/:claimId/verification` | the claim's owner | Also returns `data.progress` (the same object). Its `verification.persisted` rows are now the farmer projection: no review cases, `result: null`, `provider: null`, no internal versions or references, metadata limited to `documentCategory`, `processingStatus` and `analysisExecuted`. |
| `GET /admin/claims/:claimId/verification-diagnostics` | admins | Jobs (attempts, `lastError`, `attemptLog`), the assessment, every evidence row, review cases, satellite internals (`deltaNdvi`, adapter outcome), the audit trail, admin actions, and the farmer's `progress` side by side. |
| `POST /admin/claims/:claimId/jobs/requeue` | admins | Body `{ reason (10-2000 chars), steps? }`. Re-queues the claim's dead jobs (and the engine). Recorded as `AdminAction` `jobs_requeued` plus a `ClaimAudit` row `verification_jobs_requeued`. A repeat while the new jobs are active changes and records nothing (`idempotent: true`). Only for a `submitted` claim (409 otherwise). |

The browser can read `Retry-After`, `x-request-id` and `RateLimit-Reset` from any API response; CORS exposes them.

## The object

```jsonc
{
  "contractVersion": "progress-v1",
  "claimId": "…",
  "claimState": "submitted",          // the claim's real state (no new states exist)
  "overallStatus": "in_progress",     // draft | in_progress | waiting_for_review | action_required | decided | withdrawn
  "decision": null,                   // the claim state when it is a decision state (more_evidence_required included), else null
  "policyId": "v1.1-safe-ai",         // for support only; never render it
  "submittedAt": "…",                 // the latest (re)submission
  "lastUpdatedAt": "…",               // when something last happened (see below)
  "nextCheckAt": "…" | null,          // earliest next check among the blocking stages; always a real job time
  "stages": [ /* received, photos, land_documents, weather, area_checks, decision — always this order */ ],
  "satellite": { /* supporting evidence only; never decides */ },
  "actionRequired": [ /* what the farmer can do now */ ]
}
```

### Stages

Each stage: `{ id, status, blocking, startedAt, completedAt, nextCheckAt, explanationKey, actionRequired }`.

- `status` is one of `pending | active | complete | waiting | blocked | not_applicable | failed_technical`.
- `explanationKey` is `progress.<stage>.<reason>`. **Each key always comes with the same status** (see the JSON). A client translates the key; it never shows it raw.
- `blocking` is true when the decision waits for that stage (it follows the policy's `engineWaitsFor`; a stage with nothing to do is never blocking).
- `active` only while the stage's job is really running; `waiting` only while a retry is really scheduled; `nextCheckAt` only from a real job `runAt` in the future. Nothing is estimated and there are no percentages.
- `actionRequired` on a stage is `{ code, required }` when the farmer can act on it.

Highlights:
- **photos:** `missing` (blocked, with `add_photos`), `queued`, `checking`, `retrying_technical` (a provider failure is being retried), `technical_issue_reviewer` (the check kept failing; a reviewer will look), `complete`.
- **land_documents:** `none_attached` (not applicable; an optional or required `upload_land_documents` action may be attached), then the same set as photos.
- **weather:** supporting only. A weather service that could not answer is `complete` with `unavailable_supporting_only`, never a failure.
- **decision:** `waiting_for_checks`, `deciding`, the held reasons (`ai_no_damage_review`, `held_retrying_checks`, `technical_issue_reviewer`, `waiting_for_reviewer`, all `waiting`), `technical_issue` (the decision step itself failed), `needs_more_evidence` (blocked, with `resubmit_with_evidence` while a resubmission is still allowed), `complete`.

### Overall status

| `overallStatus` | When |
|---|---|
| `draft` | not submitted yet |
| `withdrawn` | withdrawn by the farmer |
| `decided` | a decision state other than `more_evidence_required` |
| `action_required` | `more_evidence_required`, or a blocking stage is `blocked` (for example no photos) |
| `waiting_for_review` | held for a person (`ai_no_damage_review`, `technical_issue_reviewer`, `waiting_for_reviewer`) or the decision step failed |
| `in_progress` | everything else, including a hold while a failed check is being retried |

### Satellite

`{ status, reasonCode, supportingOnly: true, noteCode, observedWindows, imageryDates, nextCheckAt, updatedAt }`.

Satellite never blocks or changes a decision under any policy (owner decision D1). The status follows this truth table (first match wins; anything not covered is `unavailable / provider_unavailable`, never `passed`):

| Situation | `status` / `reasonCode` |
|---|---|
| Claim withdrawn | `unavailable` / `claim_withdrawn` |
| Satellite job running | `processing` / `checking_imagery` |
| Job dead, nothing recorded | `failed` / `technical_issue` |
| Job dead, an earlier result recorded | the earlier result, plus `noteCode: "latest_check_failed"` |
| Nothing recorded, satellite switched off | `unavailable` / `not_enabled` |
| Nothing recorded, post-event window not open | `pending` / `waiting_for_post_event_imagery` (`nextCheckAt` only if a job is scheduled) |
| Nothing recorded, job due / no job yet | `pending` / `queued` / `not_started` |
| Adapter disabled when it ran | `unavailable` / `not_enabled` |
| Invalid area, unsupported provider or product | `not_supported` / `area_not_supported` |
| Imagery found, analysis not enabled | `unavailable` / `analysis_not_enabled` |
| Provider failure (auth, quota, error, timeout, malformed) | `unavailable` / `provider_unavailable` |
| No imagery / cloud / too few images / inconclusive analysis | `inconclusive` / `no_imagery_for_window` / `cloud_cover` / `not_enough_images` / `analysis_inconclusive` |
| Analysis supports the loss | `passed` / `vegetation_drop_consistent_with_damage` (supporting only) |
| Analysis shows no clear change | `inconclusive` / `no_clear_vegetation_change` (never `failed`) |

`observedWindows.postEvent.end` is `null` while the window is not open (`open: false`). `imageryDates` lists the acquisition dates used, only when an analysis ran. Satellite rows record the adapter outcome (`metadata.outcome`) since ADR-022; older rows are read from their evidence status.

### Actions

`{ code, stage, required, explanationKey: "action.<code>", params }`. Codes: `submit_claim`, `add_photos`, `upload_land_documents` (`params.categoryGroups`: each inner list is "any one of these categories", parsed from the resolver's `missing_document_category:a|b` reason codes; `[]` means any land document), `resubmit_with_evidence`. `required` follows the policy (claimant rights are optional under v1-legacy and v1.1, required under v2).

### `lastUpdatedAt`

The latest of the claim's meaningful times: submission, decision, audit rows, job start / completion / death / cancellation / failure, assessment start / completion / failure, the hold's start, evidence rows and photos. A lease renewal, a put-back or any other bookkeeping write never moves it, and it never goes back in time.

### Never in the farmer object

Job ids, attempts, error codes or messages, review-case rows, provider names, NDVI values, the policy hash, or anything about another farmer's claim (`forbiddenFarmerKeys` in the JSON lists the field names).
