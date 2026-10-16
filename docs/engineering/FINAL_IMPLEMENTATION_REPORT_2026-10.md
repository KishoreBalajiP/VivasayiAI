# Final implementation report — 16 October 2026

**Scope:**
- The backend in this repository and the farmer-facing frontend in `VivasayiAI-Frontend`.
- The admin panel is a separate, future task and was not changed.
- Nothing has been committed, pushed or deployed.
- The verification-components migration has been **dry-run only** against Atlas.

## Status legend

| Level | Meaning |
|---|---|
| **Implemented** | Code exists and is wired into the app. |
| **Tested** | Covered by automated tests that pass. These are deterministic: an in-memory database and mocked providers. |
| **Live** | Exercised against the real external provider on 16 October 2026. |
| **Real-world** | Validated on real farmers, claims or documents. Nothing is at this level yet. |

## Capability status

| Capability | Implemented | Tested | Live | Real-world |
|---|---|---|---|---|
| Profile, parcels, polygon validation, area | yes | yes | yes, via HTTP journey on a local DB | no |
| Claim lifecycle (create, idempotent replay, evidence upload, submit, withdraw, resubmit) | yes | yes | yes, via HTTP journey on a local DB with mock storage | no |
| Deterministic engine plus v1-legacy policy (default) | yes | yes | yes, via HTTP journey | no |
| v2-components gate with hold semantics | yes, **not enabled**: needs `CLAIM_VERIFICATION_POLICY=v2-components` and sign-off | yes (HD-1 to HD-9) | yes, via HTTP journey: the claim is held with claimant rights pending | no |
| Cross-farmer overlap as a review signal | yes | yes | no | no |
| Land-document AI extraction (advisory only) | yes | yes, with a mocked model | **blocked** by the Gemini quota | no |
| Official land record | provider-neutral adapter only; no authorised API | yes, mock | no API exists | no |
| Sentinel-2 pre/post NDVI (Copernicus Statistical API) | yes | yes, including a recorded live response | **yes: 12 runs** | no; case studies only |
| Weather (Open-Meteo) | yes | yes | yes, the forecast endpoint | no |
| Chat: intent, sufficiency, provenance, parcel selection, language | yes | yes | **blocked** by the Gemini quota; 503 handling confirmed live | no |
| RAG retrieval with source attribution | yes | yes | **yes: 22 queries**; poor relevance (see below) | no |
| Frontend: held checklist, polling, relationship step, ownership documents, appeal, chat sources and parcel, error messages (en/ta) | yes | yes (442 tests) | API shapes confirmed by the backend journey; **no browser e2e** | no |

## Changes in this final stage

### Backend: defects fixed
Each fix has a regression test.

- **NDVI parsing.** The parser read live responses at the wrong nesting level (`ndviStatistics.js`), so every live run returned "no valid statistics". Covered by test NS-13, which uses a real response fixture.
- **Scene cloud filter.** The 30% scene-level limit rejected all monsoon imagery. Parcel statistics now use `SATELLITE_PROCESSING_SCENE_CLOUD_MAX` (default 0.9). This is disclosed as a post-hoc change.
- **Evidence and ownership URL reads.** These used the strict evidence-write limiter; they now use the read limiter (test RL-6).
- **Gemini quota errors.** A 429 or 503 from Gemini was retried 6 times until the 25 s timeout and returned as a 500 "did not respond in time". Retries are now capped (`AI_MAX_RETRIES`, default 1), and the refusal returns 503 "AI service is busy" on text and image chat (tests PL-11, PL-12).
- **Stale decision on hold.** A claim held after resubmission still reported the previous round's decision. A hold now clears it; the old decision stays on the audit trail (test HD-9).
- **Live credentials in tests.** Tests could load live credentials from a developer `.env`. `vitest.config.js` now blanks every live credential.

### Frontend
Detail is in the frontend repository's diff. The frontend:
- types and uses the new `held`, components and policy fields;
- polls `GET /claims/:id/verification` every 10 s or more, and stops on a decision or hold;
- shows real areas instead of 0, and shows weather as supporting-only;
- adds a claimant-relationship wizard step, a land-documents section, an appeal panel, and a chat parcel selector and sources;
- shows distinct messages for 400, 403, 409, 413, 415 and 503, and sign-in messages for 401, 403, 409 and 502, in English and Tamil;
- no longer has the outdated image-only guard;
- has a flaky timing test fixed.

### Live-evaluation scripts
All are in `scripts/live/` and are read-only against production stores:
- `checkProviders.js`
- `satelliteCaseStudies.js`
- `ragRetrieval.live.js`
- `chatContext.live.js`
- `landDocExtraction.live.js`
- `localAcceptance.js`
- `liveSummary.js`

## Results

**Commands run:**
- **Backend `npx vitest run`:** 54 files, **904 / 904** pass.
- **Frontend:**
  - `npm run typecheck`: 0 errors.
  - `npm run lint`: 0 errors, 2 existing warnings.
  - `npx vitest run`: 26 files, **442 / 442** pass, on 3 consecutive runs.
  - `npm run build`: succeeds, with a chunk-size warning of 522 kB.
- **Manuscript:** compiles to 6 pages, with 0 LaTeX errors and 0 undefined citations.
- **Live:** see [LIVE_RESULTS_2026-10-16.md](../research/evaluation/live/LIVE_RESULTS_2026-10-16.md).

## Unresolved blockers

| Blocker | Effect | Needs |
|---|---|---|
| The Gemini key is free-tier (20 requests/day) | Live chat and document-extraction evaluations have no results; production chat would fail after 20 messages a day | A billed key, then rerun `chatContext.live.js` and `landDocExtraction.live.js` |
| No authorised Tamil Nadu land-record API | Claimant rights can be verified only by manual review | An authorised data agreement |
| Cognito hosted UI login | No automated browser e2e | A test user pool, or a test-only login path in a non-production stage |
| Knowledge base holds statistics tables only, and row chunks lose context | Advisory answers are not grounded | Advisory sources (for example TNAU agritech pages, with permission) and re-chunking with table context; re-ingestion writes to Chroma, so it needs authorisation |
| v2 policy, required-document table, area formula (+0.6%), claim write limit of 5/hour | Product and legal decisions | The product owner, and a legal or insurer reviewer |
| Migration `2026-10-verification-components` | Not applied; dry-run would backfill 1 bbox and rebuild 2 indexes | Explicit authorisation to run against Atlas |
| PDF land records | Cannot be attached; images only | A product decision and PDF handling in `/upload` |
