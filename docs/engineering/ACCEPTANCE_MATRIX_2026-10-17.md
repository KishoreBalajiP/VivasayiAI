# Acceptance matrix (2026-10-17)

**Scope.** The 2026-10 completion work: backend `develop` at `6dbe6b8` plus its uncommitted working tree, and frontend `develop` at `56f26eb` plus its uncommitted working tree. Nothing of it is committed beyond those heads, and nothing is deployed.

**Sources.** Every statement below comes from one of these files. Where they conflict, the later audit file wins.

| Source | What it is |
|---|---|
| [`test-results/acceptance/REPORT-20261016T205016Z-6dbe6b8.md`](../../test-results/acceptance/REPORT-20261016T205016Z-6dbe6b8.md) | Automated acceptance run (`npm run acceptance && npm run acceptance:report`), verdict READY |
| `test-results/audit/A.json` | Auditor A: runner and code tracer (implemented and integrated, with file:line) |
| `test-results/audit/B.json` | Auditor B: security, hermeticity and research integrity |
| `test-results/audit/C.json` | Auditor C: test adequacy (mutation testing on a copy of the working tree) |
| `test-results/audit/final-e2e.log` | Playwright re-run on the final tree (§4): 90 passed, `exit 0` |
| [MIGRATION_DRY_RUN_2026-10-16.md](MIGRATION_DRY_RUN_2026-10-16.md), [STATUS_2026-10-17.md](../research/evaluation/live/rag/STATUS_2026-10-17.md) | Migration dry run against production; RAG evaluation status |

**Column meanings.**
- **Implemented:** the code exists (auditor A traced it to file and line).
- **Integrated:** it is reachable from the real entry point (route, worker or UI), not only from tests.
- **Tested:** automated tests pass. All of them use an in-memory or loopback MongoDB and **mocked or fake providers**.
- **Live-validated:** run against the real provider or deployment. **BLOCKED** = waiting for the billed Gemini key (owner decision D6). **Not deployed** = needs a deployment that has not happened. **N/A** = the feature has no external dependency to validate (hermetic logic). **Partial** = some live runs exist, outside the app's claim flow.
- **Result:** the audit verdict for what was tested. PASS never means live-validated.
- **Release-blocking:** whether the *remaining issue* blocks a production release.

## 1. Run summary

| Item | Result | Source |
|---|---|---|
| Automated verdict | READY: 1,949 of 1,949 tests passed, 0 failed, 0 skipped, 0 flaky; 24 of 24 scenarios pass | REPORT, A.json |
| Backend vitest | 1,133 of 1,133 in the run; **1,135 of 1,135** when auditor A re-ran it on the final tree (two tests added after the run, see §3) | A.json `suites`, `integrityFinding` |
| Frontend vitest | 726 of 726 | REPORT |
| Playwright | 90 of 90 (desktop-chromium 45, mobile-chromium 45), 0 flaky, 0 network violations, 21.9 min; **re-run on the final tree: 90 of 90, 21.4 min, exit 0** | REPORT, A.json, final-e2e.log |
| Frontend typecheck, lint, build | passed | REPORT |
| Backend lint and build | N/A (the backend has neither); `node --check` of 273 files passed | REPORT, A.json |
| Manuscript numbers | passed: 74 macros, 1 warning (74 of 74 source-ledger rows not confirmed by the author) | REPORT, B.json |
| Frozen hashes | 8 of 8 match | REPORT, B.json |
| Security and hermeticity | 18 of 18 checks PASS; 2 LOW and 2 INFO findings | B.json |
| Mutation testing | 16 mutants: 14 caught, 1 equivalent, 1 genuine survivor; after the follow-ups the survivor and the lease-owner gap are caught (re-applied) | C.json, §3 |

**Integrity finding (auditor A).** The backend working tree changed while Playwright was running (the migration-guard fixes and test changes in §3; `changedDuringRun: true`), and the generated REPORT does not say so. Auditor A re-ran the backend suite on the final tree (1,135 of 1,135) and the `node --check` sweep (273 files, 0 failures). The frontend did not change. The Playwright suite had loaded the backend modules before the edits, so it was re-run on the final tree (§4): 90 of 90 passed.

## 2. Matrix

| Feature | Implemented | Integrated | Tested | Live-validated | Evidence | Result | Remaining issue | Release-blocking |
|---|---|---|---|---|---|---|---|---|
| Five-step claim wizard with photos and land documents | Yes: FE `src/utils/claimFlow.ts:259`, `ClaimWizard.tsx`, `wizard/EvidenceStep.tsx` | Yes: `#/claims/new` → `ClaimsPage` → `ClaimWizard` | Yes: WZ-*, SUB-*, E2E-01, E2E-05 | N/A | A.json; mutation 15 caught | PASS | Wizard edge cases (K-37); PDFs refused (K-33) | No |
| Claim saved on submit; plan written before the response (S01, S02) | Yes: `services/claim.service.js:236,298`; `claimVerificationPipeline.service.js:31` | Yes: `POST /claims/:id/submit` | Yes: EQ-*, S01 11/11, S02 7/7 | N/A | A.json; mutation 2 caught (EQ-1 and 10 others) | PASS | A 503 after submit relies on the client retry or the worker's reconcile sweep (K-15) | No |
| Duplicate submit creates no duplicate jobs (S03) | Yes: CAS `claim.service.js:265-284`; unique index `models/VerificationJob.js:111-114` | Yes | Yes: S03 8/8, E2E-03 | N/A | A.json | PASS | None | No |
| Verification without a browser: local worker | Yes: `services/verificationWorker.service.js:188,229`; `scripts/worker.js` | Yes: `npm run worker`; e2e harness | Yes: WK-*, E2E-11 | N/A (local) | A.json; B.json §9 | PASS | None | No |
| Verification without a browser: Lambda worker and EventBridge schedule | Yes: `index.js:34`, `handleScheduledWorker` `:266`; `infra/verification-worker.yaml` (rule DISABLED) | Template only | Yes: WK-5, WK-6 (static) | **Not deployed** | REPORT ACC-16, ACC-17, ACC-18 | PASS (tests) | **The worker is not deployed** (K-01). Without it a claim moves only while polled | **Yes**, for the frontend release that removes the verify button |
| Worker crash recovery (S04) | Yes: leases, heartbeat, stuck-claim sweep | Yes | Yes: S04 12/12, E2E-11 (worker process killed) | Not deployed | REPORT | PASS | None | No |
| Concurrent verification (S05) | Yes: atomic `claimNext`, lease-owner filter `verificationJobs.service.js:352` | Yes | Yes: S05 8/8, CV-*, VJ-14, VJ-14c, VJ-15 | N/A | C.json mutations 6, 6b caught | PASS | None (VJ-14 gap closed, §3) | No |
| Provider failures never become adverse decisions (S06-S08) | Yes: `config/verificationPolicy.js:114-125`; engine `:186-190` | Yes: worker → engine step | Yes: S06 9/9, S07 7/7, S08 8/8, SA-*, E2E-06/07/08a/08b | **BLOCKED** (fake Gemini only) | A.json; C.json mutation 11 caught | PASS | Live Gemini behaviour under quota unverified; billed key needed (K-20) | **Yes**: billed key (D6) before real claims |
| Policy `v1.1-safe-ai` is the default | Yes: `config/env.js:33` | Yes | Yes: VP-8, VP-10, PV-3, PV-4 | N/A | A.json; C.json mutations 1, 4b+ caught | PASS | **Does not reduce invalid approvals: 10 of 190, same as v1-legacy** (K-10); held claims wait for a person with no time limit (K-11) | Owner decision |
| v1-legacy and v2-components replay unchanged | Yes: frozen definitions and hashes | Yes: `CLAIM_VERIFICATION_POLICY` | Yes: PV-1, PV-2, VP-7, golden fixture | N/A | REPORT ACC-07 | PASS | None | No |
| Claim window measured at first submission | Yes: `LossClaim.firstSubmittedAt`; engine `claimWindowReference` | Yes | Yes: SA-4, SA-5, PV-6 | N/A | C.json mutation 5 caught | PASS | Only under v1.1; v1-legacy and v2 still use decision time (K-13) | No |
| Satellite never blocks or changes a decision (S13-S15) | Yes: `NON_BLOCKING_STEPS` `verificationJobs.service.js:70` | Yes | Yes: S13 6/6, S15 6/6, VJ-20, VF-4, PV-5 (0 of 1,536 flips) | Partial: 12 research case-study runs on 16 Oct through the adapter, not through the claim flow; processing off by default | C.json mutations 4a caught, 4b equivalent | PASS | Uncalibrated; one false "supports loss" across a harvest in the live study (K-23) | No (supporting only) |
| Satellite status truthful on the tracker | Yes: `services/claimProgress.js:106-124,244,276,313-355`; FE `SatelliteCard.tsx` | Yes: `ClaimTracker.tsx:299` | Yes: SD-*, PRG-*, TRK-8, E2E-14/15/16 | N/A (display of persisted rows) | A.json; C.json mutation 9 **survived**, then SD-10 strengthened (§3) | PASS | None | No |
| Cloudy or insufficient imagery (S14) | Yes | Yes | Yes: S14 7/7, E2E-15 | Partial (as above) | REPORT | PASS | Scene cap 10 per window; post-event cloud not recorded live (SATELLITE_LIMITATIONS) | No |
| Missing weather (S16) | Yes: weather step records `unavailable`, supporting only | Yes | Yes: S16 6/6, E2E-17 | Not exercised in the claim flow (forecast endpoint answered on 16 Oct) | REPORT | PASS | Open-Meteo commercial terms to check (LIVE_PROVIDER_REQUIREMENTS) | No |
| Land documents and claimant rights (S09, S10) | Yes: `landDocumentExamination.service.js`, `officialLandRecord.service.js` | Yes | Yes: S09 22/22, S10 6/6, E2E-09, E2E-10 | **BLOCKED** (Gemini document reading); no official land-record API exists | REPORT | PASS | No authorised land-record API (K-22); PDFs unsupported (K-33); attached documents cannot be deleted (K-32) | No (manual review path) |
| Geometry and area limits (S11) | Yes | Yes | Yes: S11 12/12, E2E-12 | N/A | REPORT | PASS | Server areas +0.63 % against an ellipsoidal reference (K-17) | Owner decision |
| Duplicate or overlapping claims (S12) | Yes: engine emits `duplicate_area` and `partially_verified` | Yes | Yes: S12 10/10, E2E-13 | N/A | REPORT | PASS | None | No |
| Another farmer's claim or evidence (S17) | Yes: owner check before any work | Yes | Yes: S17 19/19, AZ-1..4, E2E-18 | N/A | B.json §8 | PASS | None | No |
| Human review, appeal, admin override of a held claim (S18) | Yes: `routes/admin.js:46,62-66`; `adminOverrideRules.service.js` | Yes | Yes: S18 17/17, E2E-19a, E2E-19b | N/A | A.json | PASS | Widened admin authority (D8) needs explicit owner sign-off (K-11); override dialog lacks a focus trap (K-35) | Owner decision |
| Reviewer diagnostics and dead-job re-queue | Yes: `routes/admin.js:73-74`; `verificationDiagnostics.service.js` | Yes: FE `AdminVerificationDiagnostics.tsx` | Yes: AD-* | N/A | REPORT ACC-20 | PASS | None | No |
| Farmer progress contract; no internals leak | Yes: `services/claimProgress.js`, `FORBIDDEN_FARMER_KEYS` `:129-145` | Yes: `GET /claims/:id/progress` → `ClaimTracker` | Yes: PRG-*, VL-1..5, CT-* | N/A | B.json §7 (FE and BE contract files byte-identical); C.json mutations 10a, 10b caught | PASS | None | No |
| Tracker driven by backend state; no verify button; no fake progress (S23) | Yes: FE `ClaimTracker.tsx:98`, `ProgressStages.tsx:36-41` | Yes | Yes: TRK-6, S23 6/6, E2E-02, E2E-24 | N/A | A.json; C.json mutations 13, 14 caught | PASS | Unused i18n strings `verifyClaim`, `outsideTamilNadu` (K-39) | No |
| Polling (minimum 10 s, `nextCheckAt`, stops on final state) | Yes: FE `progressPolling.ts`, `useClaimProgress.ts` | Yes | Yes: POLL-* | N/A | C.json mutation 12 caught by POLL-1 only | PASS | The 10 s floor rests on one test (K-43) | No |
| Status survives refresh and reopen (S21); API failure recovery (S22) | Yes: FE `hashRoute.ts:44`, `useClaimProgress.ts:27,121-126` | Yes | Yes: S21 3/3, S22 3/3, E2E-22, E2E-23 | N/A | A.json | PASS | None | No |
| English and Tamil statuses (S19) | Yes: `src/locales/v2.en.ts`, `v2.ta.ts` | Yes | Yes: S19 6/6, I18N-*, E2E-20 | **External review pending** (native speaker) | A.json PARTIAL; REPORT ACC-32 | PARTIAL | Tamil copy not reviewed (K-30) | Recommended before a farmer release |
| Mobile and desktop tracker (S20) | Yes | Yes | Yes: S20 2/2, E2E-21 (both projects) | N/A | REPORT | PASS | None | No |
| Header shows the farm district | Yes: FE `App.tsx:182`, `Navbar.tsx:74-92` | Yes | Yes: LOC-* | N/A | A.json; C.json mutation 16 caught | PASS | Tiruvarur missing from both district lists (K-31) | No |
| Rate limits 15 / 60 / 600 per hour | Yes: `config/env.js:39`, `middlewares/rateLimit.js` | Yes | Yes: RL-7, RL-8, E2E-05 | Not deployed | REPORT ACC-12 | PASS | Counters per container (K-06) | No |
| CORS exposes `Retry-After`, `x-request-id`, `RateLimit-Reset` | Yes: `middlewares/cors.js:10` | Yes | Yes | Not deployed | REPORT ACC-23 | PASS | None | No |
| Dev seams never reachable in production | Yes: `config/env.js:205-258`; `app.js:40-43` | Yes: `index.js`, `scripts/worker.js` | Yes: DS-1..5b; boot refused for 7 seams and on Lambda | N/A | B.json §1-§3 (also no `__e2e` in the FE build) | PASS | A production function with a mock seam set will no longer boot; check before deploying (K-05) | Preflight required |
| Hermetic e2e harness, zero network violations | Yes: `scripts/e2e/hermeticBackend.js`; FE `e2e/` | Yes | Yes: 90 Playwright tests, 0 violations | N/A | REPORT; B.json §5 (`.dockerignore`) | PASS | Cognito login not covered (K-38) | No |
| Migration dry run and remote-write guards | Yes: `scripts/migrations/2026-10-verification-automation.js` (dry run by default) | CLI | Yes: MGA-* | Read-only dry run against production on 2026-10-16 | [MIGRATION_DRY_RUN_2026-10-16.md](MIGRATION_DRY_RUN_2026-10-16.md); B.json §9; guard fixes §3 | PASS | Not applied (K-04); components migration writes by default (K-08) | Apply before the release (owner) |
| RAG table chunker and local index; production untouched | Yes: `rag/ingestHelpers.js`, `rag/buildLocalIndex.js`, `rag/localIndex.js` | Evaluation tooling only; production chat unchanged | Yes: RC-1..16 | **Parity FAIL**; evaluation stopped by the owner | [STATUS_2026-10-17.md](../research/evaluation/live/rag/STATUS_2026-10-17.md); B.json §6 (no write calls); C.json mutation 7 caught | PASS (code); effect **unmeasured** | No before/after result (K-21b); knowledge base statistics-only (K-21) | No |
| Live Gemini evaluations (chat, land documents, 10-photo v1.1) | Scripts exist | N/A | N/A | **BLOCKED** (D6) | REPORT ACC-06, ACC-13 | NOT VERIFIED | Billed key; the `LIVE_GEMINI_APPROVED` gate and `--max-calls` cap are not in the scripts yet (K-20) | **Yes** for production |
| Research integrity (write-once outputs, frozen hashes, traceable numbers) | Yes | N/A | Yes: LW-*, FH-1, MN-* | N/A | B.json research a-i | PASS | Source ledger unconfirmed (K-27); IEEE Access template licence unclear, manuscript NOT SUBMISSION-READY (K-24) | No (research only) |
| Documentation set (plan Part E) | This document set | N/A | Relative links checked 2026-10-17 | N/A | [docs/README.md](../README.md) | PASS with one gap | `docs/research/REPRODUCTION.md` was not written (outside this documentation pass, which did not touch `docs/research/`) | No |
| Nothing committed, pushed or deployed | HEAD unchanged at `6dbe6b8` / `56f26eb`; no stash; no new refs | N/A | N/A | N/A | A.json `git` | PASS | Everything after those heads is uncommitted (K-02) | Owner review and commit |

## 3. Audit follow-ups closed on 2026-10-17

**Auditor C: mutation testing.** Sixteen mutants were applied to a copy of the working tree (never the user's tree); the copies were diff-clean against the working trees at the end.

| Mutant | Target | Verdict |
|---|---|---|
| 1 | v1.1 "no damage" → reject | Caught (PV-3, PV-4, SA-1, SA-1b, SA-7) |
| 2 | submit no longer awaits the plan | Caught (EQ-1 and 10 more) |
| 3 | satellite rows include review cases | Caught (VC-26, VJ-17) |
| 4a | `NON_BLOCKING_STEPS` emptied | Caught (VJ-20, VF-4; not VF-3) |
| 4b | v1.1 `engineWaitsFor` includes satellite | Survived the named tests; **equivalent** at runtime (`blockingStepsFor` filters it). Caught by VP-8 (4b+) |
| 5 | engine ignores the first-submission window | Caught (PV-6, SA-4, SA-5) |
| 6, 6b | lease-owner check dropped | Caught only by VJ-15 (heartbeat); VJ-14 did not test the owner check |
| 7 | chunker emits the preamble as its own chunk | Caught (RC-1 and 6 more) |
| 8 | write-once loses its `wx` flag | Caught (LW-1, LW-2, RC-13) |
| 9, 9full | imagery found + analysis disabled + stale `SUPPORTS_LOSS` → passed | **Survived** the whole backend suite (1,131 passed) |
| 10a, 10b | progress stages leak `attempts` or `lastError` | Caught (PRG-2, PRG-3, PRG-10b, PRG-10c) |
| 11 | engine ignores the technical-failure hold | Caught (PV-3, PV-7, SA-2, SA-3, SA-6) |
| 12 | FE polling floor 10 s → 1 s | Caught (POLL-1 only) |
| 13 | FE tracker renders a verify button | Caught (TRK-6) |
| 14 | FE satellite "passed" in the success tone | Caught (TRK-8) |
| 15 | FE submits although an upload failed | Caught (SUB-3, SUB-6..8, WZ-12, WZ-13, WZ-16) |
| 16 | FE geocoder failure → "outside Tamil Nadu" | Caught (LOC-4, LOC-10) |

**Test gaps closed** (both in the backend suite that auditor A re-ran: 1,135 of 1,135):
- **SD-10** (`tests/satelliteDisplay.unit.test.js:118`): now also builds rows that carry a `SUPPORTS_LOSS` analysis result while processing is `disabled`, `credentials_required` or `not_attempted`, and asserts `unavailable / analysis_not_enabled`, never `passed`. This closes the mutant 9 survivor; re-applying mutant 9 after the change, SD-10 fails (caught).
- **VJ-14c** (`tests/verificationJobs.test.js:348`): the stale owner's success write is attempted while the new owner is still running, so only the lease-owner check can refuse it. This covers the gap shown by mutants 6 and 6b; re-applying the lease-owner mutation, VJ-14c fails (caught).

Other weaknesses auditor C reported but did not require fixing: VF-3 is not sensitive to `NON_BLOCKING_STEPS` under v1.1 (VF-4 is the guard); the `AuthContext` instance of UI-14 is near-vacuous; TRK-12 relies on an implicit precondition; 64 test IDs are shared by several tests (K-42, K-43).

**Auditor B: two migration-guard fixes** (both LOW):
- **B-D1:** `scripts/migrations/2026-10-verification-automation.js` refused `--apply` only for `mongodb+srv` URIs. It now refuses any database that is not on this machine (it reuses `isLocalMongoUri` from `scripts/worker.js`) unless `MIGRATION_ALLOW_REMOTE_APPLY=true` (lines 2, 39-44).
- **B-D2:** `scripts/migrations/2026-10-verification-components.js` wrote by default with no remote guard. Writing to a database that is not on this machine now needs `MIGRATION_ALLOW_REMOTE_APPLY=true` (lines 18-19), pinned by the new test MG-9 (`tests/migration.verificationComponents.test.js:152`: a write against a non-local database is refused; dry runs and local writes are allowed). It still writes by default on a local database; `--dry-run` remains opt-in (K-08).

B-D3 (source ledger unconfirmed) and B-D4 (the compiled PDF does not carry the literal "NOT SUBMISSION-READY" marker) are informational and remain open.

## 4. Playwright re-run on the final tree

Because the backend changed during the acceptance run's Playwright step, the suite was re-run against the final working trees; the output is in `test-results/audit/final-e2e.log`.

**Result: 90 of 90 passed (21.4 min), `exit 0`**: 45 desktop-chromium and 45 mobile-chromium, against the final working trees (harness policy `v1.1-safe-ai`, inline and process workers). This replaces the acceptance run's e2e result as the evidence for the final tree.

## 5. What this matrix does not show

- Nothing here is **real-world validated**: no real claims, farmers, documents or labelled satellite damage.
- **Live-provider** evidence is limited to the 16 October 2026 study (provider check, 12 satellite case studies, 22 retrieval queries, farmer journeys on a local database). Live Gemini chat and document evaluations are BLOCKED.
- **Deployment:** nothing of this work is deployed, including the worker and the EventBridge schedule.
- Remaining issues with sources: [KNOWN_ISSUES.md](KNOWN_ISSUES.md).
