# Verification worker runbook (ADR-022)

**Status (2026-10-16): nothing here is deployed.** The template `infra/verification-worker.yaml` exists, CI is unchanged and only updates `tnFarmingAssistant`, and the EventBridge rule is created **DISABLED**. Deploying the stack, copying the API's environment to it and enabling the schedule are owner decisions. Follow the steps in order; do not skip the preflight.

## What the worker does

Claim checks are durable job rows in MongoDB (`models/VerificationJob.js`, ADR-021/ADR-022). A submit writes the plan inside the request; something then has to **run** the jobs:

| Runner | When | Budget |
|---|---|---|
| Scheduled worker (`index.worker`, this runbook) | every minute once enabled | the Lambda timeout minus 10 s, at most `WORKER_MAX_JOBS` jobs |
| Local worker (`npm run worker`) | development and the e2e harness | a loop, until SIGINT/SIGTERM |
| `GET /claims/:id/progress` and `GET /claims/:id/verification` | each farmer poll, when `CLAIM_VERIFICATION_DRAIN_ON_READ=true` | one step, `CLAIM_VERIFICATION_READ_DRAIN_BUDGET_MS` (20 s by default, enough for the photo check, which needs 15 s of budget; a step that does not fit is skipped and the next shorter due step runs instead) |
| `POST /claims/:id/verify` | reviewers and older clients only; the farmer UI no longer calls it | 22 s (`CLAIM_VERIFICATION_REQUEST_BUDGET_MS`) |

Every worker batch also runs the recovery sweeps:
- **stuck claims:** `processing` for 15 minutes is returned to `submitted` and its engine re-queued;
- **lost plans:** a `submitted` claim with no engine job since its latest submission gets its plan, 5 minutes after the submit;
- **dead jobs:** quota, overload, timeout, network and storage failures are re-queued 6 hours after they died, at most 2 rounds (`VERIFICATION_DEAD_RECOVERY_AFTER_MS`);
- **stale holds:** under a policy with `maxHoldHours` (v2), a long hold gets a review case.

Satellite never blocks a decision (D1). A dead satellite or weather job opens no review case; it shows in the reviewer diagnostics only.

> **Until the worker runs, production depends on polls and `POST /verify`.** At the default 20 s budget every poll may run one step, the photo check included, so a claim whose farmer UI no longer calls `/verify` still advances one step per poll while the farmer keeps the page open; a poll that runs the photo check can take up to about 20 s. A claim nobody is watching does not advance at all, so ship the worker with the release that removes the verify button (plan risk R1). Do not lower `CLAIM_VERIFICATION_READ_DRAIN_BUDGET_MS` below 15000 on the API function before the worker runs: polls would then never run the photo check. (Before 2026-10-16 the default was 15000, exactly the photo check's minimum, so whether a poll ran it depended on whether the clock ticked between setting the deadline and checking it.)

## 1. Preflight (read-only)

Run from a shell with AWS credentials for `ap-south-1`. These commands print **variable names and non-secret flags only**; never print `Environment.Variables` as a whole.

```bash
set +x
FN=tnFarmingAssistant
# Both must print "true". If either prints "false" or null, removing the verify button would leave
# claims undecided: fix the API function's configuration first.
aws lambda get-function-configuration --function-name "$FN" --region ap-south-1 \
  --query 'Environment.Variables.CLAIM_AUTOMATED_VERIFICATION_ENABLED' --output text
aws lambda get-function-configuration --function-name "$FN" --region ap-south-1 \
  --query 'Environment.Variables.CLAIM_VERIFICATION_DRAIN_ON_READ' --output text
# The policy in force (not a secret). Unset means the code default.
aws lambda get-function-configuration --function-name "$FN" --region ap-south-1 \
  --query 'Environment.Variables.CLAIM_VERIFICATION_POLICY' --output text
# Which variables exist (names only):
aws lambda get-function-configuration --function-name "$FN" --region ap-south-1 \
  --query 'keys(Environment.Variables)' --output text
# ADR-024: from this release on, the API and the worker REFUSE TO BOOT on Lambda when any dev/test seam
# is set. Each of these must print None (unset) or the live value shown in the comment:
for KEY in IMAGE_STORAGE_MODE IMAGE_AI_MODE LAND_RECORD_MODE WEATHER_MODE SATELLITE_MODE DEV_STORAGE_RECEIVER IMAGE_STORAGE_MOCK_DIR; do
  printf '%s=' "$KEY"
  aws lambda get-function-configuration --function-name "$FN" --region ap-south-1 \
    --query "Environment.Variables.$KEY" --output text
done
# Allowed: None, live (any *_MODE), off (WEATHER_MODE, SATELLITE_MODE), or false (DEV_STORAGE_RECEIVER).
# Refused: mock (any *_MODE), true (DEV_STORAGE_RECEIVER), any value of IMAGE_STORAGE_MOCK_DIR.
```

Also confirm, before going further:
- the release image (the commit SHA tag in ECR `vivasayiai-lambda`) contains ADR-022;
- the migration dry run (`node scripts/migrations/2026-10-verification-automation.js`, read-only) has been reviewed, and its `--apply` has been approved and run. The reconcile sweep would otherwise plan claims that predate durable enqueue on its first run (harmless, but it spends provider calls);
- a billed Gemini key is configured (owner decision D6). On a free-tier key the photo checks hit quota limits and the jobs end up dead.

## 2. Deploy the stack (schedule still DISABLED)

```bash
aws cloudformation deploy --region ap-south-1 \
  --template-file infra/verification-worker.yaml \
  --stack-name vivasayi-verification-worker \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageUri=390403879095.dkr.ecr.ap-south-1.amazonaws.com/vivasayiai-lambda:<release-sha> ScheduleState=DISABLED
```

The function `vivasayi-verification-worker` runs the same image with the command `index.worker`, a 300 s timeout and reserved concurrency 1.

> **Every stack deploy resets the worker's environment. Re-run step 3 (then step 4) after EVERY `cloudformation deploy` of this stack.** CloudFormation owns the function's `Environment` block, which holds only `NODE_ENV` and `WORKER_MAX_JOBS`. The rest of the environment is copied in out of band (step 3), so CloudFormation does not know it: any deploy that updates the function (step 2, step 5, step 7, a new `ImageUri`, any parameter change) can replace the whole environment with those two variables. Until step 3 runs again, every invocation fails at start-up (`Missing required environment variable(s)`) and touches no job; the error alarm and the `Errors` metric show it. This applies to every deploy, including the one that enables the schedule, so run step 3 immediately after it. (Moving the worker's settings into Secrets Manager or SSM and resolving them in the template with dynamic references would let CloudFormation own the full environment and remove this step. That changes how the API's secrets are stored, so it is a separate owner decision and is not done here.)

## 3. Copy the API's environment (secrets never echoed)

The worker needs the same variables as the API (MongoDB, Gemini, Chroma, S3, the `CLAIM_*` and `VERIFICATION_*` settings). They are copied through a private temporary file, never through the terminal, shell history or a log:

```bash
set +x
umask 077
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
aws lambda get-function-configuration --function-name tnFarmingAssistant --region ap-south-1 \
  --query '{Variables: Environment.Variables}' --output json > "$TMP"
# Keep the worker's own two variables; nothing is printed.
jq '.Variables.NODE_ENV = "production" | .Variables.WORKER_MAX_JOBS = "25"' "$TMP" > "$TMP.new" && mv "$TMP.new" "$TMP"
aws lambda update-function-configuration --function-name vivasayi-verification-worker --region ap-south-1 \
  --environment "file://$TMP" --query 'LastUpdateStatus' --output text
rm -f "$TMP"
```

Do not `cat` the file, do not pass the variables on the command line, and never commit them. A later change to the API's variables must be copied again the same way. (Moving the secrets to SSM Parameter Store would remove this step; that is a separate decision.)

## 4. Smoke test (one manual invocation)

```bash
aws lambda invoke --function-name vivasayi-verification-worker --region ap-south-1 --payload '{}' \
  --cli-binary-format raw-in-base64-out /tmp/worker-out.json --query 'FunctionError' --output text
jq '{processed, sweep}' /tmp/worker-out.json && rm -f /tmp/worker-out.json
```

`FunctionError` must print `None`. `processed` is the number of jobs run; `sweep` holds the sweep counts. The CloudWatch log lines of each job carry `drainRequestId` = the invocation's `awsRequestId`.

## 5. Enable the schedule

```bash
aws cloudformation deploy --region ap-south-1 --template-file infra/verification-worker.yaml \
  --stack-name vivasayi-verification-worker --capabilities CAPABILITY_IAM \
  --parameter-overrides ImageUri=<same image> ScheduleState=ENABLED
```

Optionally pass `AlarmTopicArn=<sns topic>` to create the error alarm.

**This deploy resets the environment (see step 2): run step 3 and step 4 again right away.** Invocations that fire in between fail at start-up and touch no job.

## 6. Monitor

CloudWatch Logs Insights on `/aws/lambda/vivasayi-verification-worker` (and the API function, whose request drains log the same events):

```
fields @timestamp, msg, step, claimId, errorKind, errorCode
| filter msg in ["job.dead", "job.lease_lost", "worker.batch_failed", "verification.sweep_failed", "verification.plan_reconciled"]
| sort @timestamp desc
```

```
fields @timestamp, kind, provider, operation
| filter msg = "provider.error" and kind = "auth_config"
```

`auth_config` means a key is missing or rejected: those jobs are retried but never recovered automatically after they die; fix the key, then re-queue (step 8). For a single claim, the reviewer view `GET /admin/claims/:id/verification-diagnostics` shows the jobs, attempt logs, error codes and review cases next to what the farmer sees.

## 7. Pause or roll back

Redeploy with `ScheduleState=DISABLED`. Nothing is lost: jobs stay in MongoDB, and polls and `POST /verify` still move the queue. A worker stopped in the middle of a step leaves the job's lease to expire; the next runner takes it over (tested: WK-7). The redeploy resets the environment too: run step 3 again before re-enabling the schedule.

## 8. Recover dead jobs

- One claim: `POST /admin/claims/:id/jobs/requeue` with `{"reason": "...", "steps": ["ai_assessment"]}` (admin token). It is recorded as an `AdminAction` (`jobs_requeued`) and a `ClaimAudit` row.
- In bulk, from a machine that can reach the database: `npm run worker -- --requeue-dead --dry-run` first, then without `--dry-run`. Options: `--step=<step>`, `--kind=<kind>`, `--claim=<id>`, `--limit=<n>`. The worker command line refuses any database that is not on the machine running it unless `WORKER_ALLOW_REMOTE_DB=true` is set for that one command, deliberately and with approval: a developer's `.env` usually points at production.

## 9. After every release

CI updates only `tnFarmingAssistant`. Point the worker at the same image. `update-function-code` changes only the code, not the environment, but it makes the function drift from the stack: the next `cloudformation deploy` must pass the image now running (or a newer one) as `ImageUri`, and, like every deploy, must be followed by step 3.

```bash
aws lambda update-function-code --function-name vivasayi-verification-worker --region ap-south-1 \
  --image-uri 390403879095.dkr.ecr.ap-south-1.amazonaws.com/vivasayiai-lambda:<release-sha> --query 'LastUpdateStatus' --output text
```

## Local worker (development)

```bash
# A local mongod only; the command refuses Atlas and any remote host.
MONGO_URI=mongodb://127.0.0.1:27017/vivasayi_dev npm run worker            # loop until Ctrl-C
MONGO_URI=mongodb://127.0.0.1:27017/vivasayi_dev npm run worker -- --once  # one batch, prints a JSON summary
```

The first Ctrl-C (or SIGTERM) lets the job in flight finish and exits 0 (tested: WK-8); a second one exits 1 at once. Settings: `WORKER_POLL_INTERVAL_MS` (5000), `WORKER_BATCH_BUDGET_MS` (240000), `WORKER_MAX_JOBS` (25), `WORKER_SWEEP_INTERVAL_MS` (60000), plus the queue's `VERIFICATION_*` keys (`.env.example`). The step executors call the real providers configured in the environment; use the hermetic e2e harness for a run without any provider.
