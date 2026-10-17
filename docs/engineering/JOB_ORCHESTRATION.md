# Verification job orchestration (ADR-021, ADR-022)

**Status (2026-10-17).** Implemented in the backend working tree on `develop` after `6dbe6b8`; **not committed, not deployed**. Automated-test verified with an in-memory MongoDB and fake or mocked step executors (test files in [§13](#13-tests)). Not run against live providers as a queue, and no scheduled worker is deployed.

This is the reference for the durable job queue behind claim verification: which steps exist, what waits for what, how failures are retried, what happens when a job dies, and what the logs say. The overview with diagrams is [CLAIM_FLOW.md](../architecture/CLAIM_FLOW.md); operating the worker is [WORKER_RUNBOOK.md](WORKER_RUNBOOK.md).

Main files:

| File | Contents |
|---|---|
| `models/VerificationJob.js` | Job schema, `JOB_STEPS`, `JOB_STATUSES`, indexes |
| `services/verificationJobs.service.js` | Constants, enqueue and plans, claiming, leases, `runJob`, dead-job review cases, `requeueDeadJobs`, `drain` |
| `services/verificationSteps.js` | The executor behind each step |
| `services/verificationWorker.service.js` | Sweeps, `drainDueJobs`, `runWorkerLoop`, Lambda `handleScheduledWorker` |
| `services/claimVerificationPipeline.service.js` | Plan scheduling at submit and resubmit, late-evidence plans |
| `services/verificationDiagnostics.service.js` | Admin diagnostics and the admin re-queue |
| `utils/providerErrors.js` | Error taxonomy |
| `scripts/worker.js` | `npm run worker` |

## 1. Steps

| Step | Planned when | Executor does | Needs budget (`MIN_BUDGET_MS`) | Default max attempts | Dead job opens a review case labelled |
|---|---|---|---|---|---|
| `ai_assessment` | the claim has a stored photo | Gemini photo assessment, image by image, checkpointed (`claimAssessment.service.js`, mode `job`) | 15 s | 7 | `AI_IMAGE` |
| `land_documents` | a land document is attached | Gemini reading of each attached document; already-examined documents are skipped | 12 s | 7 | `OWNERSHIP` |
| `official_land_record` | a land document is attached | Looks up the official record through the provider adapter; without a configured provider the result is `unavailable` | 6 s | 5 | `OWNERSHIP` |
| `satellite` | the claim has geometry | Sentinel-2 discovery and, if enabled, NDVI processing; supporting only | 12 s | 5 | none |
| `weather` | the claim has geometry | Open-Meteo rainfall around the event; supporting only | 4 s | 5 | none |
| `engine` | always, last | `verifyClaim`: the deterministic rules, the policy gate, the decision or a hold | 4 s | 5 | `GEOMETRY` |

Sources: `DEFAULT_MAX_ATTEMPTS` (`services/verificationJobs.service.js:56`), `MIN_BUDGET_MS` (line 107), `STEP_REVIEW_SOURCE` (line 76), `SUPPORTING_STEPS` (line 72), `ensurePlan` (line 284). The maximum is stored on each job when it is created, so a later configuration change never rewrites a queued job.

## 2. Dependencies and what the engine waits for

`blockingStepsFor(step, policy)` (line 415):

- `official_land_record` waits for `land_documents` (`STEP_DEPENDENCIES`, line 74).
- `engine` waits for the policy's `engineWaitsFor`, or for every other step when the policy has no such key, **minus `NON_BLOCKING_STEPS`** (`["satellite"]`, line 70).

| Policy | `engineWaitsFor` key | Effective blocking steps for the engine |
|---|---|---|
| `v1-legacy` | absent | `ai_assessment`, `land_documents`, `official_land_record`, `weather` |
| `v2-components` | absent | `ai_assessment`, `land_documents`, `official_land_record`, `weather` |
| `v1.1-safe-ai` (default) | `["ai_assessment", "land_documents", "official_land_record", "weather"]` | the same four |

`NON_BLOCKING_STEPS` is queue timing, not decision logic, so it is not part of any policy and no policy hash changed (owner decision D1). Only steps that are queued or running count: a step that was never planned, or has already finished, does not hold anything up.

When a job finds an active blocker it is put back untouched (its attempt is refunded) with `runAt = max(now + 15 s, earliest queued blocker's runAt + 1 s)`. If a blocker is running at that moment, only the 15 s wait applies. Outcome: `waiting_for_other_steps` (engine) or `waiting_for_dependencies`.

A satellite result never re-triggers the engine: only `ai_assessment`, `land_documents` and `official_land_record` are decision inputs (`DECISION_INPUT_STEPS`, line 91).

## 3. Plans and idempotency

| Plan | Plan key | Created by |
|---|---|---|
| Submission round | `r<submissionRound>` | submit, resubmit, their retries, `POST /verify`, the reconcile sweep (`ensurePlan`) |
| Photo added or removed after submit | `r<round>:ev:<first 12 hex of the photo-set version>` (`ai_assessment` + `engine`, or `engine` alone when no photo is left) | `scheduleEvidencePlan` |
| Land document attached after submit | `r<round>:doc:<evidenceId>` (`land_documents`, `official_land_record`, `engine`) | `scheduleDocumentPlan` |
| Recovery, re-evaluation, photo-check retry | none | `requeueDeadJobs`, `requestReevaluation`, `queuePhotoCheckRetry` |

- `enqueue` (line 213) is idempotent: an active job for the same claim and step, or a job already created for the same claim, step and plan key, is returned with `created: false`. Two unique partial indexes enforce this: `activeKey` (`<claimId>:<step>` while active) and `{claimId, step, planKey}`.
- Late evidence uses `rerunIfRunning`: if the step is running when the photo or document arrives, the running job is flagged `rerunRequested` and queued once more when it finishes, without using an attempt (`job.rerun_requested`).
- Late-evidence scheduling never fails the upload. A failure is logged (`verification.late_evidence_plan_failed`) and a repeated upload or attach call schedules again.
- Submit and resubmit await the plan. If it cannot be written the response is **503** "Your claim was saved, but its checks could not be scheduled. Please try again." (`PLAN_FAILED_MESSAGE`); the claim is already `submitted` and a retry returns 200 with `idempotent: true` after re-running `ensurePlan`.
- Correlation: every job carries `requestId` (the request that created it) and `correlationId` (`clm_<claimId>_r<round>`). Log lines also carry `drainRequestId`, the runner that ran the attempt (an HTTP request id, `worker-<uuid>`, or the Lambda `awsRequestId`).

## 4. Claiming, leases and heartbeats

- `claimNext` (line 326) takes one job with a single atomic `findOneAndUpdate`: either `status: queued` with `runAt <= now`, or `status: running` with an expired `leaseUntil` (a frozen or killed runner). It sets `status: running`, `leaseOwner`, `leaseUntil = now + lease` and increments `attempts`. Oldest `runAt` first.
- Lease: `VERIFICATION_LEASE_MS`, default 60 000 ms. Heartbeat: `VERIFICATION_HEARTBEAT_MS`, default a third of the lease, capped at half of it. The heartbeat write does not touch `updatedAt`.
- Every write the runner makes is filtered on the lease owner. When the lease was taken over the write matches nothing, the runner logs `job.lease_lost` and stops. Its provider call may already have been made.
- A step with less budget left than its `MIN_BUDGET_MS` is put back as due (`skipped_no_budget`, attempt refunded). The drain then excludes that step for the rest of the drain, so a one-job poll whose photo check does not fit still runs a shorter due step.

### Runners and their budgets

| Runner | Deadline | Jobs |
|---|---|---|
| Lambda `index.worker` (`handleScheduledWorker`) | remaining invocation time minus 10 s | `WORKER_MAX_JOBS` (25) |
| `npm run worker` loop or `--once` | `WORKER_BATCH_BUDGET_MS` (240 000) per batch | `WORKER_MAX_JOBS` (25) |
| Owner poll (`GET /progress`, `GET /verification`) | `CLAIM_VERIFICATION_READ_DRAIN_BUDGET_MS` (20 000) | 1, this claim only |
| `POST /claims/:id/verify` | `CLAIM_VERIFICATION_REQUEST_BUDGET_MS` (22 000) | up to 10, this claim only |

A poll drains only when `CLAIM_AUTOMATED_VERIFICATION_ENABLED` and `CLAIM_VERIFICATION_DRAIN_ON_READ` are both true, and only after the ownership check.

## 5. Outcomes of one run (`runJob`, line 476)

| Outcome | Attempt counted? | Next |
|---|---|---|
| `cancelled` (`claim_withdrawn`, `claim_missing`) | no if before the step ran, yes if after | job is finished |
| `skipped_no_budget` | no | due again at once |
| `waiting_for_other_steps` / `waiting_for_dependencies` | no | `runAt` as in §2 |
| `rescheduled` (the step returned `rescheduleAt`) | no; `rescheduleCount` += 1 | `runAt = rescheduleAt` |
| `rerun` | no | 1 s later |
| `succeeded` | yes | job is finished |
| `retry_scheduled` | yes | backoff (§6) |
| `dead` | yes | review case (§8), recovery (§9) |
| `lease_lost`, `precheck_failed`, `settle_failed` | — | the lease expires and another runner takes the job |

The engine may report "in progress" (another run holds the claim, or the photo check is still processing). It is rescheduled 60 s later. After `ENGINE_MAX_RESCHEDULES` (30) reschedules it fails with `ENGINE_STUCK`, which is classified as an application defect, so it gets at most 3 attempts and then a review case.

## 6. Retries

| Setting | Default | Override |
|---|---|---|
| Backoff after attempt 1, 2, 3, ... (last value repeats) | 60 s, 5 min, 15 min, 1 h, 1 h, 3 h | `VERIFICATION_RETRY_SCHEDULE_MS` (comma-separated ms) |
| Jitter | ±20 % | not configurable (`RETRY_JITTER`) |
| Attempts per step | `ai_assessment` 7, `land_documents` 7, others 5 | `VERIFICATION_MAX_ATTEMPTS` (JSON, for example `{"ai_assessment":3}`) |
| Attempts for an `application_defect` | at most 3, whatever the step limit | not configurable (`DEFECT_MAX_ATTEMPTS`) |

All `VERIFICATION_*` settings are read on every call (`queueSettings`, line 157); an unusable value is ignored with one `verification.invalid_setting_ignored` warning. With the defaults, a photo check that fails seven times spends about 5 h 21 min (±20 %) before it dies.

Step-specific behaviour (`services/verificationSteps.js`):
- **`ai_assessment`:** out of time between images it saves its checkpoint and asks to run again 1 s later; another runner holding the assessment slot means "look again in 60 s". Neither uses an attempt. A retry after a failure reuses the images already assessed for the same evidence and prompt version. If the photo set changed while it ran it is assessed again (up to 30 reschedules).
- **`land_documents`:** a document that failed for a retryable reason (quota, overload, timeout, network, storage, auth_config, malformed output) fails the step with that kind, so it is retried. A document that failed with an application defect is counted in `failed` and the step finishes.
- **`official_land_record`:** a 409 "no examined document" is a finished step (`skipped: no_examined_document`), not a failure.
- **`satellite`:** a provider refusal, timeout or error is recorded as `UNAVAILABLE` evidence and the step asks to run again 1 h later, without using an attempt, while `rescheduleCount` is below 3. That count is shared with the post-event-window reschedules. See [SATELLITE_LIMITATIONS.md](SATELLITE_LIMITATIONS.md).
- **`engine`:** see §5.

## 7. Error taxonomy (`utils/providerErrors.js`)

`classifyProviderError` gives every thrown value exactly one kind; first match wins.

| Kind | Code | Typical cause | Retried | Auto-recovered after death | Log level |
|---|---|---|---|---|---|
| `timeout` | `PROVIDER_TIMEOUT` | `AiTimeoutError`, `AbortError`, `ETIMEDOUT` and similar | yes | yes | warn |
| `quota` | `PROVIDER_QUOTA` | HTTP 429, `RESOURCE_EXHAUSTED`, "quota" | yes | yes | warn |
| `overload` | `PROVIDER_OVERLOAD` | HTTP 502/503/504, gRPC `UNAVAILABLE`, "overloaded" | yes | yes | warn |
| `auth_config` | `PROVIDER_AUTH_CONFIG` | HTTP 401/403, bad or missing API key, `PERMISSION_DENIED` | yes | **no** (an operator must fix the key, then re-queue) | error, `operatorAction: true` |
| `network` | `PROVIDER_NETWORK` | `ECONNRESET`, `ENOTFOUND`, "fetch failed" and similar | yes | yes | warn |
| `malformed_response` | `PROVIDER_MALFORMED` | unreadable model output (set by the caller) | yes | **no** | warn |
| `storage` | `STORAGE_UNAVAILABLE` | S3 read or write failed (set by the caller) | yes | yes | warn |
| `application_defect` | `APP_DEFECT` | anything unrecognised | at most 3 attempts | **no** | error |

The job's `lastError.code` is the error's own code when it has one (for example `ENGINE_STUCK`), otherwise the kind's code. Messages are sanitised (URLs and key-like parameters removed) and cut to 300 characters. `ProviderError` deliberately does not keep the original `cause`, because the logger would print its message, which can carry a prompt, URL or key.

A technical failure is never a finding about the claim. Under `v1.1-safe-ai` a failed photo check makes the photos component `unavailable`, and the engine holds the claim instead of rejecting it or asking for more evidence.

## 8. Dead jobs and review cases

When a job runs out of attempts it becomes `dead` (`job.dead`, error level) and `openReviewCaseForDeadJob` (line 663) runs:

- `satellite` and `weather` (`SUPPORTING_STEPS`): **no review case**. Logged as `job.dead_supporting_step_no_review_case` and shown in the admin diagnostics only.
- A withdrawn or deleted claim: no review case.
- Otherwise one review case with `source` from `STEP_REVIEW_SOURCE` (`AI_IMAGE`, `OWNERSHIP` or `GEOMETRY`), reason `automated_step_failed_<step>`, and metadata `failedStep`, `failedComponent`, `errorCode`, `errorKind`.

A job that later recovers leaves its earlier review case open. Under `v1.1-safe-ai` that is harmless; under `v2-components` an open case keeps the claim held until a reviewer closes it.

## 9. Re-queueing dead jobs

`requeueDeadJobs` (line 699) never revives a dead row. It marks the row `requeuedAt` (so two sweeps cannot re-queue it twice) and creates a new job with `recoveredFrom` and `recoveryRound + 1`. If the dead step feeds the decision, the engine is queued again too. Only jobs of claims still `submitted` are touched, oldest first.

| Path | Kinds | Cool-down | Max recovery rounds | Recorded as |
|---|---|---|---|---|
| Worker sweep (`recoverDeadJobs`) | `quota`, `overload`, `timeout`, `network`, `storage` (`AUTO_RECOVERABLE_KINDS`) | `VERIFICATION_DEAD_RECOVERY_AFTER_MS`, default 6 h after `deadAt` | 2 | `job.requeued`, actor `worker` |
| Admin: `POST /admin/claims/:claimId/jobs/requeue` | any | none | 10 | `AdminAction` `jobs_requeued` + `ClaimAudit` `verification_jobs_requeued` |
| CLI: `npm run worker -- --requeue-dead [--dry-run]` | any, or `--kind=` | none | 10 | `job.requeued`, actor `cli` |

Admin re-queue rules (`services/verificationDiagnostics.service.js`): body `{ reason (10-2000 characters, required), steps? }`; **409** when the claim is not `submitted`; a repeat that finds nothing to re-queue writes no AdminAction and returns `idempotent: true`. CLI options: `--step=`, `--kind=`, `--claim=`, `--limit=` (default 50). The CLI refuses any database that is not on the local machine unless `WORKER_ALLOW_REMOTE_DB=true`.

Under a persistent provider failure the automatic chain is bounded: one chain of 1 + 2 recovery rounds per photo-set version (pinned by SA-10, `tests/claim.verify.retryBound.test.js`).

## 10. Sweeps

`drainDueJobs` (`services/verificationWorker.service.js:188`) runs due jobs first, then four sweeps. Each sweep is bounded and isolated: a failing sweep logs `verification.sweep_failed` and the others still run. The long-running loop runs sweeps at most every `WORKER_SWEEP_INTERVAL_MS` (60 s) and skips them while stopping. Polls and `POST /verify` never run sweeps.

| Sweep | Finds | Does | Default timing |
|---|---|---|---|
| `releaseStuckProcessingClaims` | claims in `processing` with no decision and no engine job under a live lease | returns them to `submitted` (audit `verification_released`) and queues the engine; decided-but-still-processing claims are only reported (`verification.decided_claim_still_processing`) | 15 min after `processedAt` |
| `reconcilePlans` | `submitted` claims with no engine job created since `submittedAt` and none active | `ensurePlan` for the current round (`verification.plan_reconciled`); skipped when automation is off | 5 min grace after submit |
| `recoverDeadJobs` | dead jobs of the auto-recoverable kinds | §9 | 6 h after death |
| `sweepStaleHolds` | held claims older than the policy's `maxHoldHours` | opens a review case `hold_exceeded_maximum_duration`; never decides | v2: 72 h; v1-legacy and v1.1: off (`maxHoldHours: null`) |

## 11. Cancellation

- **Withdraw:** `cancelJobsForClaim` cancels every queued job of the claim (`claim_withdrawn`). A running job is cancelled by `runJob` when it sees the claim is withdrawn.
- **Admin override of a held claim:** cancels the queued `ai_assessment`, `land_documents`, `official_land_record` and `engine` jobs (`admin_override`). Satellite and weather keep running.

## 12. Log events

All job lines are emitted from `logger.child({ jobId, claimId, step, requestId, correlationId, drainRequestId })`. They contain ids, codes and kinds only, never prompts, keys or provider message bodies.

| Event | Level | When |
|---|---|---|
| `verification.plan_ensured` | info | `ensurePlan` ran (with `trigger`, `steps`, `created`) |
| `verification.plan_failed` | error / warn | a plan could not be written (submit 503; `POST /verify` logs and continues) |
| `verification.late_evidence_plan_failed` | error | a late photo or document plan could not be written |
| `job.started` | info | an attempt began |
| `job.waiting` | debug | put back while blockers are active |
| `job.rescheduled` | info | the step asked to run later |
| `job.rerun_requested` | info | late evidence arrived while it ran |
| `job.succeeded` | info | finished |
| `job.retry_scheduled` | warn (error for `auth_config` and defects) | failed, will retry (`retryInMs`, `errorKind`, `errorCode`) |
| `job.dead` | error | out of attempts |
| `job.dead_supporting_step_no_review_case` | warn | dead satellite or weather job |
| `job.cancelled` | info | withdrawn or missing claim |
| `job.lease_lost`, `job.heartbeat_failed` | warn | another runner took the job, or a renewal failed |
| `job.precheck_failed`, `job.settle_failed` | error | a database read or write around the step failed |
| `job.requeued` | info | a dead job was re-queued (`actor`, `recoveryRound`) |
| `verification.stuck_claim_released`, `verification.plan_reconciled`, `verification.sweep_failed` | warn / error | sweeps |
| `verification.technical_hold`, `verification.photo_check_retry_not_queued` | warn | v1.1 technical hold |
| `verification.drain_failed` | warn | a request drain failed (the request still succeeds) |
| `verification.jobs_requeued_by_admin` | info | admin re-queue |
| `worker.started`, `worker.batch`, `worker.batch_failed`, `worker.stopping`, `worker.stopped`, `worker.forced_exit`, `worker.failed` | info / error | `npm run worker` |
| `provider.error` | warn / error | `logProviderError` (`kind`, `provider`, `operation`) |

CloudWatch queries for these events are in [WORKER_RUNBOOK.md §6](WORKER_RUNBOOK.md#6-monitor).

## 13. Tests

Automated-test verified (mocked or fake executors, in-memory MongoDB): `tests/verificationJobs.test.js` (VJ-*), `tests/verificationEnqueue.test.js` (EQ-*), `tests/verification.concurrency.test.js` (CV-*), `tests/verificationWorker.loop.test.js` and `tests/worker.crashRecovery.test.js` (WK-*, including SIGKILL and SIGTERM of a child worker), `tests/claim.verify.safeAi.test.js` (SA-*), `tests/claim.verify.retryBound.test.js` (SA-10), `tests/providerErrors.unit.test.js` and `tests/providerErrors.api.test.js` (PE-*), `tests/admin.diagnostics.test.js` (AD-*), `tests/decisionConsistency.test.js` (DC-*). Results of the latest run are in the acceptance report (`npm run acceptance && npm run acceptance:report`, see [13_Testing_Strategy.md](13_Testing_Strategy.md)).
