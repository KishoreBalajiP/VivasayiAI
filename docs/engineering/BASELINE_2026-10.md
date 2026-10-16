# Test baseline and Phase A fixes — October 2026

Branch `feat/verification-hardening-2026-10`, created from `develop` at `522d212`. Nothing here is
committed, pushed or deployed.

## Environment

| Item | Value |
|---|---|
| OS | macOS (Darwin) |
| Node | 26.7.0 (production image targets Node 24) |
| Install | `npm ci --legacy-peer-deps` (same flag as the Dockerfile; the langchain peers conflict) |
| Test runner | vitest 3.2.4, supertest, mongodb-memory-server 11.2.0 with mongod 8.2.6 |
| External providers | none configured; no `.env` exists, so no live Gemini, Cohere, Chroma, S3, CDSE or MongoDB Atlas call was made |

## Baseline on HEAD (before any change)

Serial run (`--no-file-parallelism`): **558 passed, 9 failed, 567 total.**

| Failures | Cause |
|---|---|
| 8 in `ai.503.test.js` (B1 to B8) | The suite forced `IMAGE_STORAGE_MODE=live`, so presigning needed real AWS credentials. It failed on any machine without them. |
| 1 in `claims.api.test.js` (test 6) | Race: the test inserted a duplicate before Mongoose had built the unique index, so no duplicate-key error was raised. Deterministic on a cold mongod. |

Neither is a product defect. Both were test-infrastructure faults. The previous release report
(`FINAL_RELEASE_VALIDATION_REPORT.md`) listed the 8 as "pre-existing environmental"; the ninth is new
on this machine.

## After Phase A

Default parallel run: **613 passed, 0 failed, 613 total, 29 files** (Phase A only). The 46 added tests are
regression tests; each was run against the unfixed code first and failed there. The totals for the whole
branch are in the next section.

## Defects fixed

| Area | Defect | Fix | Regression tests |
|---|---|---|---|
| Land record | `officialLandRecord.service.js` destructured a named export from a default-export model, so `POST /claims/:id/verification/official-land-record` always returned 500 and never persisted a row | Default import; static imports | `officialLandRecord.test.js` |
| Land record | Endpoint forwarded the client body as the record query | Controller ignores the body; service reads the stored AI extraction; 409 when none exists | same |
| Admin | Evidence photo links were always empty or `undefined` (S3 key excluded by populate; signer's string result destructured as an object) | Sign from a separate lookup that keeps the key server-side | `admin.api.test.js` (detail test strengthened) |
| Admin override | A second keyless override changed the claim and then failed with a duplicate-key 500, leaving no AdminAction or audit row | Atomic state change guarded by prior state; AdminAction written immediately after; server-generated key for keyless overrides; rollback if the record cannot be written; losing a race returns 409 | `admin.api.test.js` section K |
| Admin override | A client `overrideKey` could collide with a server key and return an unrelated record as "already applied" | Client keys with reserved prefixes are rejected with 400 | same |
| Manual review | Idempotency key contained `Date.now()`, so every pipeline run added another case | Deterministic key from claim, source and sorted reasons | `manualReview.test.js` |
| Manual review | Review cases and land-record check rows appeared in the farmer's ownership list and were re-examined as documents | Document filter on farmer list, document URLs, examination and pipeline; admins still see all rows | same |
| Auth | Every failure became 500; the raw AxiosError (client secret and one-time code) was logged | 401 for a rejected code, 502 for a Cognito outage, safe log fields only, 10 s timeout | `auth.service.test.js` |
| Auth | A legacy account was linked without checking `email_verified`, and an account bound to a different Cognito identity was re-bound | Verified email required; different identity gives 409 | same |
| Errors | Oversized or unsupported bodies returned 500; every 4xx logged at error level | 413 and 415 mapping; 4xx logged as warnings | `error.middleware.test.js` |
| Chat | One transient Chroma failure disabled retrieval for the whole container lifetime | Failed connection is no longer cached | `chat.regressions.test.js` |
| Chat | Maize alias started with a Bengali letter and never matched; Tamil சோளம் (sorghum) was lumped in with maize | Alias fixed; separate sorghum entry, listed after maize because மக்காச்சோளம் contains சோளம் | same |
| Chat | History trimming dropped several messages at once | Drop the oldest one at a time | same |
| Rate limits | The 5 per hour claim write limit also counted GET reads, so polling locked farmers out of creating claims | Separate read limiter (default 600 per hour, `CLAIM_READ_RATE_LIMIT_*`) | `claims.ratelimit.test.js` |
| Logging | Logger required the `pino-pretty` devDependency whenever `NODE_ENV` was not `production`; the Lambda image installs production dependencies only | Falls back to JSON when it is missing or when running in Lambda | `logger.test.js` |
| Local run | `npm run dev` connected to MongoDB and then never listened | `app.listen` outside Lambda, verified by starting the real server and calling `/health` | manual smoke run |
| CI | Deploy ran with no tests, tagged `latest` only | Test job gates deploy, pull requests are tested, images are also tagged with the commit SHA | not runnable locally |
| Image | `COPY . .` shipped git history, tests, docs and any local `.env` | `.dockerignore`; `npm ci --omit=dev` honours the lockfile | `npm ci --dry-run` only; the image was not built |

## Required before deploying: index migrations

Mongoose does not change an existing index whose options differ. These model changes only take
effect on a database where the old index has been dropped and rebuilt (a script will be added in
Phase B). Until then the code is safe, because keyless overrides get server-generated keys, but the
database keeps the old, weaker index.

| Collection | Old index | New index |
|---|---|---|
| `adminactions` | `claimId_1_idempotencyKey_1` unique, sparse | same keys, unique, partial on string `idempotencyKey` |
| `users` | `email_1` unique | `email_1` unique, sparse |

## Known limits of this baseline

- Run on one machine with Node 26; CI uses Node 24. Not yet run on Node 24.
- The Docker image was not built. The GitHub Actions workflow was not executed.
- No live provider has been exercised, so Gemini, Cohere, Chroma, S3 and Copernicus behaviour is untested here.
- Passing tests show regression safety. They do not measure agricultural accuracy or fraud detection.

## Later phases (B to H) and final state

Same branch, still uncommitted. Final run: **899 tests in 54 files, all passing**; 25 consecutive full-suite runs
passed after the test-server change below.

| Phase | Delivered |
|---|---|
| B | Component-based verification with versioned policies (ADR-020), required-component gate with hold semantics, append-only evidence history, durable job queue and scheduled worker (ADR-021), cross-farmer overlap review signal, review-case endpoints, historical rainfall evidence, migration script |
| C | Pre/post-event NDVI over the claim polygon with cloud masking; interpretation outcomes; reschedule while the post-event window is open. **Not run against the live Copernicus service** |
| D | Intent-driven context loading with provenance tags and a one-question-at-most follow-up rule; parcel selection; language handling; source attribution; knowledge fenced as data; weather from stored district coordinates with a 3-day forecast; ingestion fixes |
| E | Land-document hardening (untrusted-data instruction, instruction-like text flagged, one bounded retry, uncertain fields), Tamil/Latin name matching, claimant relationship and per-relationship document policy (**provisional, unreviewed**) |
| F | 15 adversarial claim scenarios, Cognito pool pinning and `token_use` check, bounded key cache, request-id validation, authentication rejection diagnostics, dependency clean-up |
| G | Evaluation harness (`npm run eval`), literature review with 45 verified references, research questions, protocol, ethics statement, manuscript draft with generated tables |
| H | Frontend contract: [FRONTEND_CONTRACT_2026-10.md](../architecture/FRONTEND_CONTRACT_2026-10.md) |

### Additional defects found and fixed during B to G

| Area | Defect | Found by |
|---|---|---|
| Job queue | Nothing imported the real step executors, so every queued step would have failed with "no executor" in production | A test that did not register fakes |
| Job queue | A step skipped for lack of time was re-claimed by the same drain in a loop | Budget test |
| Geometry | The shared validator accepted out-of-range coordinates (only the API schema rejected them) | Geometry evaluation |
| Name matching | Glide letters (w, y) made Tamil and Latin spellings of the same name differ | Name evaluation (tuned on the same set; optimistic) |
| Chat | Crop de-duplication kept the last spelling instead of the first | Context tests |

### Intermittent test failures: root cause

Roughly one full-suite run in four failed with a stray 401 or 404 on an ordinary request, never in a single
file. The failing responses did not pass through the application's error handler. The body of one was
`{"type":"error","error":{"type":"authentication_error","message":"Invalid authentication"}}`, which is not this
application's format, and another local program (an editor helper) was listening on the same port number in the
operating system's ephemeral range. Test requests were occasionally answered by it. The shared test server now
chooses a port below the ephemeral range, bound to 127.0.0.1, and every test file uses it. 25 of 25 full runs
passed afterwards. This is a diagnosis supported by that evidence and by the result of the fix, not a proof.
The same collision is only a test-environment issue; the application itself was not at fault.

### Findings that need a decision, not a code change

- **Area is about 0.6% too large.** The server's area formula uses the equatorial radius of a sphere; against an
  ellipsoidal reference the difference is 0.60 to 0.65% in every case at Tamil Nadu latitudes. Correcting it would
  make newly computed areas incomparable with stored parcel and claim areas, so it needs a decision and a
  migration plan.
- **`v2-components` is not the default.** It needs product-owner sign-off (ADR-020) and the document policy per
  claimant relationship needs legal or insurer review.
- **Dependencies.** After removing one unused package and updating axios and mongoose, `npm audit --omit=dev`
  still reports 45 issues (5 critical, 8 high), mostly transitive through langchain, sharp and similar packages.
  They need a planned upgrade, not an automatic fix.
- **Two index migrations** are still required in production (see above).

### Not done
Live Gemini, Cohere, Chroma, S3, Atlas and Copernicus runs; any real-data experiment; building the Docker image;
running the GitHub Actions workflow; testing on Node 24; the IEEE class is not installed here, so the manuscript was
checked by compiling a copy with a stand-in class (no errors, no undefined citations) and has not been built with
the real template.
