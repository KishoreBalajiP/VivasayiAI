# Migration dry run against production (2026-10-16)

**Command:** `node scripts/migrations/2026-10-verification-automation.js` (no `--apply`), run against the production MongoDB Atlas database configured in the local `.env`.

The run was **read-only**:
- Mongoose connected with `autoIndex: false` and `autoCreate: false`.
- Every step only counts what it would change.
- `--apply` against a `mongodb+srv` URI is refused unless `MIGRATION_ALLOW_REMOTE_APPLY=true` is set, and it was not set.

**Nothing was written.**

> **Note (2026-10-17).** After audit B (finding B-D1) the `--apply` guard was widened: it now refuses any database that is not on this machine (Atlas or a remote `mongodb://` host), not only `mongodb+srv` URIs, unless `MIGRATION_ALLOW_REMOTE_APPLY=true` (`scripts/migrations/2026-10-verification-automation.js:39-44`). The dry run above is unaffected.

## Output

```
claims firstSubmittedAt: 2 would be backfilled
claims submissionRound: 2 would be backfilled
index verificationjobs.claimId_1_step_1_planKey_1: would be created
queued jobs of withdrawn or deleted claims: 0 would be cancelled
claims stuck in processing: 0 would be released
dead jobs: 1 (ai_assessment/error: 1)
assessments stuck in processing: 0 (the next photo check takes them over)
submitted claims with no job and no decision: 0 (the worker's reconcile sweep plans them)
dead-job review cases labelled OWNERSHIP for another step: 1 (reported only)
```

## What it means

1. **Two claims** would get `firstSubmittedAt` and `submissionRound`. Both values come from their earliest `submitted` audit row and the count of submit and resubmit audits.
2. **One new index**, `{claimId, step, planKey}`, unique and partial. It is safe to build because no existing job has a `planKey`.
3. **One dead `ai_assessment` job** from before this change; its last error was recorded without a kind. Under the new queue it is not requeued automatically, because the kind is unknown. An admin can requeue it with `POST /admin/claims/:id/jobs/requeue` after reviewing it.
4. **One older review case** is labelled `OWNERSHIP` but was opened for a different failed step. This is reported only; history is never rewritten.
5. No queued jobs belong to withdrawn claims, no claims are stuck in `processing`, and no submitted claims are missing a plan.

## Applying it (owner decision; not done)

Apply only after the release that contains these changes is approved:

```
MIGRATION_ALLOW_REMOTE_APPLY=true node scripts/migrations/2026-10-verification-automation.js --apply
```

Run the dry run again afterwards. It should report zero changes, because the migration is idempotent (MGA-2).
