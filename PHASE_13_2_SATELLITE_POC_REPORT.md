# Phase 13.2 — Satellite Verification Proof of Concept (PoC) Report

**Document type:** Phase deliverable report (non-production feasibility PoC)
**Status:** PARTIALLY VALIDATED — live satellite **discovery** validated against the primary
provider; pixel-level **NDVI processing BLOCKED** (no provider credentials configured); no
production integration performed.
**Author:** Engineering (Phase 13.2)
**Date:** 2026-10-09
**Companion documents:** `backend/PHASE_13_1_SATELLITE_FEASIBILITY_REPORT.md`,
`backend/PHASE_11_FINAL_REPORT.md`, `backend/PHASE_12_FINAL_REPORT.md`
**Related ADR(s):** ADR-019 (Agricultural Loss / Affected-Area Claim), Phase 11 evidence foundation
annex.

---

## 1. Executive Summary

Phase 13.2 built a **bounded, isolated, non-production** proof of concept (PoC) to validate the
Phase 13.1 recommendation to use **Copernicus Data Space Ecosystem (CDSE) Sentinel-2 (optical)** and
**Sentinel-1 (SAR)** imagery for future satellite corroboration of agricultural loss claims.

What was actually done and observed:

- A single **synthetic** ~1.08-acre paddy parcel near Thanjavur, Tamil Nadu was used; no real farmer,
  claim, or production parcel was touched.
- The PoC was implemented as an **isolated module** under `backend/poc/satellite/` plus a CLI runner
  and a focused unit-test file. **No production model, route, controller, service, engine, or
  config file was modified.**
- **Live discovery against the primary provider (CDSE) was validated**: three bounded, anonymous,
  read-only STAC catalogue requests (~2.6 s total) returned **20 Sentinel-2 L2A scenes** (2024-02-19
  → 2024-04-19) and **6 Sentinel-1 IW GRD scenes** (2024-03-05 → 2024-04-22) intersecting the test AOI.
- The best pre-event scene (2024-03-10) had **0.2 %** cloud cover and the best post-event scene
  (2024-04-19) had **23.8 %** cloud cover, so a cloud-free-enough pre/post pair exists for the chosen
  window.
- **NDVI computation was NOT performed live.** The Sentinel Hub Statistical API requires OAuth2
  client credentials, which are **not configured anywhere in this environment** (verified: the token
  endpoint returns HTTP 401 for a bogus client). The processing path is fully implemented and
  deterministically unit-tested with mocked responses, but it is reported as **BLOCKED** for live use.
- **18/18 focused PoC tests pass** and **537/545 full-suite tests pass**; the only 8 failures are the
  pre-existing, unrelated `tests/ai.503.test.js` environmental failures (no AWS credentials / live
  image mode), identical to the Phase 12 baseline.

**Overall verdict: PARTIALLY VALIDATED.** Imagery discovery, AOI handling, bounded request/retry
behaviour, evidence-contract compatibility, and failure classification are validated. End-to-end
scientific validation (actual biophysical change detection on real pixels) is **BLOCKED pending CDSE
Sentinel Hub credentials**, and is explicitly out of scope for this phase.

---

## 2. Scope, Objectives & Non-Goals

### 2.1 Objectives

1. Translate the Phase 13.1 architecture into a working — but strictly bounded and non-production —
   PoC.
2. Determine whether the recommended provider(s) and any credentials are actually available.
3. Exercise Sentinel-2 optical feasibility (discovery + intended NDVI pre/post comparison) and
   Sentinel-1 SAR feasibility (discovery).
4. Prove the PoC respects the existing evidence contract and claim-decision boundaries.
5. Distinguish and safely surface discovery / retrieval / quality / coverage / cloud / missing /
   provider / auth / quota / analysis / inconclusive failure states.
6. Produce a transparent report with exact evidence, commands, and results — never fabricated.

### 2.2 Non-Goals (explicitly out of scope)

- No production satellite adapter, no wiring into claim submission or the verification engine.
- No satellite evidence persisted into real claims; no production schema change.
- No new claim status, decision rule, or compensation logic.
- No high-resolution commercial providers (Planet / Maxar); Phase 13.1 deferred them.
- No bulk downloads, no expensive historical backfills, no unbounded queries.
- No commit / push / PR / deploy.

---

## 3. Constraints & Guardrails Observed

| Guardrail | How it was honored |
|---|---|
| No credentials in source control | Credentials are read only from PoC-specific env vars; none exist; no `.env` present; `.env.example` unchanged. |
| Credentials never printed/logged/persisted | `redactPocConfig()` output and the runner summary contain no secret fields; a test asserts secrets never appear in results. |
| Bounded requests | Max 3 live requests (2 optical windows + 1 SAR); `maxScenes` cap 10 per query, hard cap 25; each HTTP call has an explicit timeout. |
| Bounded retries | At most `maxRetries` (default 1) additional attempts, and **only** on timeout/network/5xx. Auth/quota/4xx are never retried. |
| No live claim flow | PoC lives in `poc/satellite/`; it imports only pure utilities and axios; it imports no model/route/engine and writes nothing. |
| No authoritative-area replacement | The existing `services/parcelGeometry.service.js` is used **read-only** to document the test parcel's extent. |
| Never a negative finding on missing data | Missing/cloudy/failed cases map to `UNAVAILABLE`/`INSUFFICIENT`/`PENDING`, never to "damage". |
| No fabricated provider data | Blocked/missing/error cases produce empty scene lists and explicit reasons; asserted by test. |
| No silent provider switch | Primary CDSE is attempted first; the public fallback is only labeled as fallback and never advertised as primary success. |

---

## 4. Repository Audit (What Exists, What Was Touched)

Existing relevant infrastructure (inspected, not modified):

- `utils/verificationEvidence.js` — pure Phase 11 evidence foundation: frozen `EVIDENCE_SOURCES`
  (incl. `SATELLITE`), `EVIDENCE_STATUSES`, non-operative `FUTURE_EVIDENCE_SOURCES`, and
  `buildVerificationEvidence()`.
- `services/parcelGeometry.service.js` — the authoritative spherical-excess area/validation module.
- `services/weather.service.js` + `config/weather.js` — the established pattern for a bounded,
  timeout-guarded, gracefully-degrading external provider (pattern mirrored).
- `config/env.js`, `models/LossClaim.js` (`CLAIM_STATES`), `models/FarmProfile.js` (GeoJSON
  `Polygon`, EPSG:4326).
- `tests/helpers.js`, `tests/setup.js`, `vitest.config.js`, `package.json` test scripts.

**Files created (all new; no existing file changed):**

| File | Purpose |
|---|---|
| `backend/poc/satellite/config.js` | Isolated, non-throwing PoC config + redaction. |
| `backend/poc/satellite/testPolygon.js` | Synthetic TN test parcel + windows. |
| `backend/poc/satellite/satellitePoc.js` | Core PoC module (validation, discovery, processing, mapping, orchestration). |
| `backend/poc/satellite/runPoc.js` | Bounded live CLI runner (read-only). |
| `backend/tests/satellitePoc.unit.test.js` | 18 focused offline tests. |

**Explicit confirmation:** no production source, config, schema, route, controller, service, engine,
or doc was modified in Phase 13.2. The PoC is fully additive and isolated.

---

## 5. Isolation & PoC Module Architecture

**Location choice.** The repository has no existing `experiments/` directory. The PoC was placed
under a new `backend/poc/satellite/` namespace to keep it clearly separate from runtime code
(`services/`, `models/`, `routes/`, `src/`), mirroring the intent of the git-ignored ad-hoc
`t*-probe.mjs` scripts while being an intentional, reviewable artifact.

**Data flow:**

```
resolvePocConfig()            (config.js — env only, never throws, no secrets in output)
      │
      ▼
validateAoi()  ──►  validateDateRange()        (reuses parcelGeometry.service.js read-only)
      │
      ▼
searchScenes() [S2 pre][S2 post][S1 union]     (bounded STAC /search, timeout + bounded retry)
      │
      ├─ cloud / temporal coverage checks
      │
      ▼
fetchCdseToken() ─► fetchNdviStatistics()      (ONLY if CDSE OAuth creds present)
      │
      ▼
POC_OUTCOMES → EVIDENCE_STATUS_BY_OUTCOME → buildVerificationEvidence(source=SATELLITE, operative=false)
```

**Dependency injection.** Every provider interaction goes through an injected `transport`
(`{ get, post }`), so all tests run fully offline and deterministically. In live mode the transport
is an axios client with an explicit timeout and User-Agent.

**Public module surface** (from `satellitePoc.js`): `runPoc`, validators (`validateAoi`,
`validateDateRange`), NDVI helpers (`computeNdvi`, `ndviFromBandMeans`, `ndviDelta`), provider ops
(`searchScenes`, `fetchCdseToken`, `fetchNdviStatistics`, `buildStatisticalRequest`,
`parseStatisticalResponse`), error/outcome helpers, and `buildSatelliteEvidencePayload`. There is
**no** transition/approve/reject/override/engine function — asserted by test.

---

## 6. Test Parcel Definition & Geometry Handling

| Property | Value |
|---|---|
| Label | `SYNTHETIC-POC-PARCEL-THANJAVUR-TN` |
| Type | **Synthetic** (not a real parcel; not persisted) |
| Location | Thanjavur district, Tamil Nadu, India (paddy area) |
| CRS | WGS84 / EPSG:4326, GeoJSON `[longitude, latitude]` |
| Geometry | Closed single exterior ring, 0.0006° × 0.0006° |
| Approx. extent | **66 m × 67 m** (~0.44 ha) |
| Area (reported) | **1.0829 acres** — computed by the existing authoritative geometry validator |
| Event date (synthetic) | `2024-03-20T00:00:00Z` |
| Pre window | `2024-02-01` → `2024-03-15` |
| Post window | `2024-03-21` → `2024-04-30` |

The polygon is validated by `validateParcelGeometry()` (the only area authority). The PoC **never**
computes or replaces claim/parcel area; it only records the validator's result for documentation.
Invalid polygons (open rings, holes, non-polygons) are rejected before any provider call (tested).

---

## 7. Provider Access Determination

| Provider | Endpoint used | Access required | Determined status |
|---|---|---|---|
| **CDSE STAC catalogue (primary)** | `https://catalogue.dataspace.copernicus.eu/stac/search` | None observed for catalogue search | **AVAILABLE (live)** — anonymous search returned real features |
| **CDSE Sentinel Hub processing** | token `https://identity.dataspace.copernicus.eu/.../token`, stats `https://sh.dataspace.copernicus.eu/api/v1/statistics` | OAuth2 client credentials | **BLOCKED** — token endpoint returns HTTP 401 for a bogus client; no creds configured |
| **Planetary Computer STAC (fallback)** | `https://planetarycomputer.microsoft.com/api/stac/v1/search` | None (public, throttled) | **AVAILABLE (live, fallback only)** — confirmed reachable and returning features |

Credential availability check (presence only, no values printed): `CDSE_CLIENT_ID`,
`CDSE_CLIENT_SECRET`, `SENTINEL_HUB_CLIENT_ID`, `SENTINEL_HUB_CLIENT_SECRET`,
`SATELLITE_POC_ENABLED`, `SATELLITE_POC_PROVIDER` are all **absent**; `backend/.env` does not exist.

**Exact access requirement to unblock processing:** a CDSE Sentinel Hub account with an OAuth2
client (client id + client secret) granted the `sentinel-hub` / Processing API scope, supplied via
PoC-only env vars (`CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET`). No secret was requested, generated, or
stored during this phase.

---

## 8. Live Discovery Results (Primary Provider — CDSE)

Command:

```
node poc/satellite/runPoc.js
```

Observed result (real, read-only; 3 bounded requests; ~2.6 s):

- **Outcome:** `IMAGERY_FOUND`
- **Mode:** `discovery-only`
- **Evidence status (proposed):** `PENDING` (imagery discovered; processing not attempted)
- **Optical scenes:** 20 × Sentinel-2 L2A intersecting the AOI
- **SAR scenes:** 6 × Sentinel-1 IW GRD intersecting the AOI
- **Best pre-event scene:** `S2B_MSIL2A_20240310T045649_..._T44PKT` — 2024-03-10, cloud **0.2 %**
- **Best post-event scene:** `S2B_MSIL2A_20240419T045659_..._T44PKT` — 2024-04-19, cloud **23.8 %**
- **Sample S2 acquisitions:** 2024-02-19, 2024-02-24, 2024-02-29, 2024-03-05, 2024-03-10, …, 2024-04-19
- **Sample S1 acquisitions (IW, descending):** 2024-03-05, 2024-03-17, 2024-03-29, 2024-04-22
- **AOI:** 1.0829 acres, bbox `[79.1375, 10.7864, 79.1381, 10.787]`, 66 m × 67 m
- **Notes:** “Sentinel Hub processing credentials are not configured; live NDVI statistics were not
  retrieved. Imagery discovery succeeded.”

The fallback (Planetary Computer) was **not needed** because primary CDSE discovery succeeded, so
`fallbackUsed = false` (correct behavior — no silent provider switch).

> Note on discovery-vs-processing: STAC catalogue search is public, so **imagery discovery is
> genuinely validated live**. Pixel statistics (NDVI) are a *processing* operation gated by
> credentials and remain unvalidated live.

---

## 9. Sentinel-2 Optical Feasibility

- **Product:** Sentinel-2 L2A (surface reflectance; SCL available for cloud masking).
- **Bands used for NDVI:** B04 (Red, 665 nm, 10 m) and B08 (NIR, 842 nm, 10 m).
- **Revisit:** consistent with Phase 13.1 — multiple S2 acquisitions were returned within each
  ~6-week window (e.g. 6+ in the pre window), so temporal coverage is achievable in principle.
- **Cloud reality:** observed cloud covers ranged from 0.2 % to ~67 %. This directly confirms the
  Phase 13.1 limitation that monsoon-region optical availability is cloud-limited and must be
  handled by masking/thresholding and (ideally) SAR fusion.
- **NDVI method implemented:** `NDVI = (B08 − B04) / (B08 + B04)`; for the aggregate-statistics path
  the PoC uses the **ratio of band means** (documented approximation) and can compute a
  before/after delta once credentials exist.

**Live optical validation status:** discovery **VALIDATED**; NDVI processing **BLOCKED**.

---

## 10. Sentinel-1 SAR Feasibility

- **Product:** Sentinel-1 IW GRD (C-band SAR), as recommended in Phase 13.1 for cloud-independent
  observation.
- **Discovery validated live:** 6 scenes returned, all IW mode, consistent descending passes on a
  ~12-day cadence (two-satellite ~6-day potential), matching Phase 13.1 expectations.
- **PoC behavior:** SAR discovery is **best-effort** — a SAR failure never blocks optical analysis.
  SAR scenes carry no cloud cover, so they are excluded from the cloud-obscured decision.
- **Processing:** no SAR processing (backscatter change detection) is implemented in this phase; it
  is a candidate for a later phase (Phase 13.1 flagged it as future work).

**Live SAR validation status:** discovery **VALIDATED**; analysis not attempted (out of scope).

---

## 11. Pre/Post Event NDVI Comparison Design

1. Query S2 L2A separately for the pre-window and post-window (so both sides are represented),
   dedupe by scene id, and sort by acquisition time.
2. Reject the run as `CLOUD_OBSCURED` if **every** scene with a known cloud value exceeds the
   configured fraction (default 0.30).
3. Require ≥1 scene on each side, else `INSUFFICIENT_TEMPORAL_COVERAGE`.
4. If credentials exist, compute NDVI statistics for each window via the Sentinel Hub Statistical
   API and derive `deltaNdvi = NDVI(after) − NDVI(before)`; otherwise stop at `IMAGERY_FOUND`
   (mode `discovery-only`).
5. Any processing error yields `INCONCLUSIVE` (never a decision, never a negative finding).

The comparison is **experimental supporting evidence only** — it cannot and does not influence any
claim status, area, or compensation.

---

## 12. Quality, Failure & Failure-State Classification

The PoC distinguishes and safely surfaces every required failure class via `POC_OUTCOMES`:

| Situation | Outcome | Proposed evidence status |
|---|---|---|
| Invalid AOI / invalid date range | `INVALID_INPUT` | `NOT_CHECKED` |
| PoC disabled | `CONFIG_DISABLED` | `NOT_CHECKED` |
| Missing provider credentials (processing) | `IMAGERY_FOUND` (discovery-only) | `PENDING` |
| Auth failure | `AUTH_REQUIRED` | `UNAVAILABLE` |
| Quota exceeded (429) | `QUOTA_EXCEEDED` | `UNAVAILABLE` |
| Provider 5xx / network | `PROVIDER_ERROR` | `UNAVAILABLE` |
| Timeout | `TIMEOUT` | `UNAVAILABLE` |
| No imagery returned | `IMAGERY_UNAVAILABLE` | `UNAVAILABLE` |
| All scenes cloud-obscured | `CLOUD_OBSCURED` | `INSUFFICIENT` |
| One-sided/insufficient window | `INSUFFICIENT_TEMPORAL_COVERAGE` | `INSUFFICIENT` |
| Processing returned no valid stats / error | `INCONCLUSIVE` | `INSUFFICIENT` |
| Full success | `ANALYSIS_COMPLETE` | `AVAILABLE` |

None of these statuses is a claim lifecycle state (asserted against `CLAIM_STATES`). Missing or
cloud-obscured imagery is never translated into a negative agricultural finding.

---

## 13. Evidence Contract Compatibility & Claim-Decision Boundaries

- The PoC emits a **proposed** payload via the existing `buildVerificationEvidence()` with
  `source: "SATELLITE"` and `operative: false` (SATELLITE is a non-operative/future source in the
  Phase 11 foundation).
- `POC_OUTCOMES` map only onto the frozen `EVIDENCE_STATUSES`; they can never be copied into
  `claim.state`.
- The PoC **does not persist** anything and **does not import** any model, route, controller, or the
  deterministic verification engine. It cannot transition a claim, approve/reject, compute
  compensation, or override boundaries.
- Traceability fields included (provider, provider version, evidence version, evaluation version,
  AOI fingerprint, collections, scene counts) are non-PII and contain no signed URLs or tokens;
  forbidden metadata keys are structurally rejected by the foundation.
- Result payloads are also validated by the foundation's forbidden-key/size guards.

This is proven by tests: outcomes ∩ `CLAIM_STATES` = ∅; the module exposes no decision API; and
`buildVerificationEvidence({source:"SATELLITE"})` yields `operative: false`.

---

## 14. Cost, Quota & Resource Controls

- **Live requests actually made:** 3 (2 optical windows + 1 SAR). No downloads of scene pixels.
- **Approx. data volume:** negligible — only JSON feature metadata (tens of KB); no imagery bytes.
- **Processing cost:** **zero**, because processing did not run (credentials absent). Had it run, it
  would consume CDSE Sentinel Hub Processing Units (PUs): `1 PU = 512×512 px, 3 bands, 1 sample/pixel,
  ≤16-bit`, with documented minimums (0.005 PU Process API / 0.01 PU Statistical API).
- **Quota stance:** CDSE free monthly quota resets on the 1st and is not carried; over-quota yields a
  slower interface (`429` is handled as `QUOTA_EXCEEDED`). **Exact current free-tier numbers are not
  stated here because they were not verified in this phase** — confirm at
  `https://documentation.dataspace.copernicus.eu/Quotas.html` before any cost commitment.
- **No cost figure is invented anywhere in this report or the code.**
- **Escalation guard:** the module cannot issue bulk or history-wide queries (`maxScenes` cap +
  hard cap 25 + bounded windows ≤ 120 days).

---

## 15. Automated Tests — 12 Required Scenarios & Results

Command:

```
npx vitest run tests/satellitePoc.unit.test.js --no-file-parallelism
```

Result: **18 passed / 18** (all offline, deterministic; provider responses injected).

| # | Required scenario | Test |
|---|---|---|
| 1 | Valid polygon handled | “accepts the synthetic test polygon and reports a bounded extent” |
| 2 | Invalid polygon rejected | “rejects invalid polygons (open ring, zero area, non-polygon)” |
| 3 | Date-range validation | “validates date ranges and rejects reversed, future, and over-long windows” |
| 4 | Missing credentials handled safely | “reports missing credentials safely and never calls the token endpoint” + “never serializes a credential value” |
| 5 | Provider timeout safe | “handles a provider timeout as UNAVAILABLE without throwing” |
| 6 | Auth / quota error safe | “handles provider auth and quota errors as UNAVAILABLE…” + “classifies errors and wraps the token call…” |
| 7 | Missing imagery → unavailable/inconclusive | “reports missing imagery as UNAVAILABLE (never a negative agricultural finding)” |
| 8 | Cloud-obscured ≠ damage | “treats fully cloud-obscured imagery as INSUFFICIENT, not as damage” |
| 9 | No fabricated data as success | “never fabricates scene data when discovery fails” |
| 10 | Traceable provider/product/version metadata | “computes a pre/post NDVI comparison with traceable … metadata” |
| 11 | Cannot modify claim status / invoke engine | “uses only evidence statuses and never a claim lifecycle state” + “produces non-operative SATELLITE evidence only and exposes no engine/decision API” |
| 12 | Existing claim verification unchanged | “keeps the frozen operative/future source split and non-operative SATELLITE” |

Additional coverage: bounded-retry semantics (retry only timeout/network/5xx; never retry 401),
single-sided-window handling, and defensive NDVI/Statistical-API parsing.

> **Honesty note:** mocked provider success proves the PoC’s own logic, **not** that any live
> provider works. Live proof is limited to discovery (Section 8).

---

## 16. Regression Test Results

Relevant existing tests (unmodified):

```
npx vitest run tests/verificationEvidence.unit.test.js tests/verificationEvidence.test.js \
  tests/claim.verificationEngine.test.js tests/claim.verificationEngine.phase9.test.js \
  tests/claimState.test.js tests/parcel.geometry.test.js --no-file-parallelism
```

Result: **141 passed / 141** (6 files).

Full suite:

```
npx vitest run --no-file-parallelism
```

Result: **537 passed / 8 failed / 545** (21 files).
The 8 failures are **all** in `tests/ai.503.test.js` and are the **pre-existing, unrelated**
environmental failures (they require real AWS/AI credentials or live image mode). This matches the
Phase 12 baseline exactly (519 passed / 8 failed / 527) plus the 18 new PoC tests. **No regression
was introduced.**

---

## 17. Acceptance Criteria Assessment & Overall Status

| Acceptance criterion | Status |
|---|---|
| Isolated, non-production PoC exists and is additive | ✅ Met (`poc/satellite/`) |
| No production files modified; no claim flow wired | ✅ Met |
| Provider/credential availability determined | ✅ Met (CDSE discovery available; processing requires creds) |
| Test polygon documented (source, coords, CRS, validity, extent) | ✅ Met |
| Sentinel-2 optical exercised | ✅ Discovery live; ⛔ NDVI processing blocked |
| Sentinel-1 SAR feasibility exercised | ✅ Discovery live |
| Pre/post NDVI comparison designed + unit-validated | ✅ Met (design + mocked tests); ⛔ not live |
| Failure states distinguished & safely surfaced | ✅ Met |
| Evidence contract compatible; claim boundaries intact | ✅ Met (tested) |
| Cost/resource controls documented, no invented costs | ✅ Met |
| Automated tests (12 scenarios) + regressions | ✅ Met (18 + 141; full 537/545) |
| No credentials in source / never printed | ✅ Met |
| No commit/push/PR/deploy | ✅ Met |

### Overall status: **PARTIALLY VALIDATED**

- **Validated live:** primary-provider imagery discovery (S2 + S1), AOI/geometry handling, bounded
  requests/retries, evidence-contract compatibility, failure classification, claim-safety.
- **Blocked:** live Sentinel-2 NDVI computation (and therefore real pre/post biophysical change
  detection) — requires CDSE Sentinel Hub OAuth2 credentials that are not configured.
- **Not attempted (by design):** any production integration, persistence, or decision influence.

**Exact requirement to reach full validation:** provision CDSE Sentinel Hub OAuth2 client credentials
into the PoC-only env vars and re-run `node poc/satellite/runPoc.js`; this PoC should then progress
from `IMAGERY_FOUND` to `ANALYSIS_COMPLETE` for the same synthetic parcel.

---

## 18. Limitations, Risks, Assumptions, Unresolved Items & Next Steps

**Limitations**
- Discovery relies on the public STAC catalogue; STAC anonymous access rules may change.
- NDVI uses ratio-of-band-means as an approximation; true per-pixel statistics require the
  Statistical API.
- The chosen window/parcel is synthetic and near cloud-prone monsoon conditions; results are not a
  statistical claim about any real field.
- SAR scenes are discovered but not processed.

**Risks**
- Credential/quota governance for live processing is unverified.
- Persistent monsoon cloud can defeat optical-only change detection → SAR fusion is the documented
  mitigation.
- Cloud-cover metadata is scene-level, not AOI-level; a scene may be clear scene-wide yet cloudy over
  the parcel.
- Provider API/collection names and quota policies can change; treat all endpoints as configurable.

**Assumptions**
- Sentinel-2 L2A and Sentinel-1 GRD remain freely available via CDSE.
- EPSG:4326 GeoJSON remains the geometry convention.
- The existing evidence foundation remains the canonical contract.

**Unresolved items**
- Exact CDSE free-tier quota numbers (confirm at the Quotas page).
- Whether commercial-use terms are fully satisfied by the intended CDSE tier (Phase 13.1 flagged this).
- Statistical API response shape details (implemented defensively; not live-validated).

**Recommended next steps (future phases only — not performed here)**
1. Provision PoC credentials and complete live NDVI validation on the synthetic parcel.
2. Add AOI-level (not scene-level) cloud masking using SCL/s2cloudless.
3. Add Sentinel-1 backscatter change detection and optical/SAR fusion.
4. Only after scientific validation: design a governed, non-operative SATELLITE evidence adapter,
   behind an ADR, that still cannot influence decisions until explicitly authorized.

---

### Appendix A — Verification commands run

| # | Command | Result |
|---|---|---|
| 1 | `npx vitest run tests/satellitePoc.unit.test.js --no-file-parallelism` | 18 passed |
| 2 | `node poc/satellite/runPoc.js` | `IMAGERY_FOUND`; 20 S2 + 6 S1 scenes; ~2.6 s; 3 requests |
| 3 | `npx vitest run tests/verificationEvidence.unit.test.js tests/verificationEvidence.test.js tests/claim.verificationEngine.test.js tests/claim.verificationEngine.phase9.test.js tests/claimState.test.js tests/parcel.geometry.test.js --no-file-parallelism` | 141 passed |
| 4 | `npx vitest run --no-file-parallelism` | 537 passed / 8 failed / 545 (8 = pre-existing `ai.503`) |

### Appendix B — Files created (this phase)

- `backend/poc/satellite/config.js`
- `backend/poc/satellite/testPolygon.js`
- `backend/poc/satellite/satellitePoc.js`
- `backend/poc/satellite/runPoc.js`
- `backend/tests/satellitePoc.unit.test.js`

### Appendix C — Explicit confirmation

No production code, configuration, schema, route, controller, service, engine, or documentation was
modified. No satellite evidence was persisted into any claim. No credentials were created,
requested, printed, logged, or committed. No commit, push, PR, or deployment was performed. The PoC
is experiment-supporting evidence only and **must not** be represented as a validated production
capability.

---

# Addendum — Phase 13.2.1: Live Satellite Analysis Validation

**Document type:** Phase 13.2.1 follow-up addendum to the Phase 13.2 PoC report (above).
**Status:** LIVE PROCESSING **STILL BLOCKED** — credential prerequisite not satisfied. No live NDVI
was produced. Implementation re-audited against official provider documentation and confirmed
technically correct; all safe local tests pass; no production file touched.
**Date:** 2026-10-09
**Scope:** Complete the *live* validation portion of Phase 13.2 using the **existing** PoC (no
duplication, no new adapter). This addendum **preserves** all Phase 13.2 findings; it does not
rewrite them.

> **Honesty statement.** Nothing in this addendum is a live NDVI result. Every number below is either
> (a) an actual measured value (request counts, durations, discovery scene lists, test pass counts),
> (b) an actual live provider response (STAC discovery), or (c) explicitly-labeled engineering
> inference. No mocked value is presented as live, and no NDVI/damage figure is fabricated.

## 13.2.1.1 Credential Availability (checked; presence only, no values printed)

| Variable | Status |
|---|---|
| `CDSE_CLIENT_ID` | **absent** |
| `CDSE_CLIENT_SECRET` | **absent** |
| `SENTINEL_HUB_CLIENT_ID` | **absent** |
| `SENTINEL_HUB_CLIENT_SECRET` | **absent** |
| `SATELLITE_POC_ENABLED` | **absent** |
| `SATELLITE_POC_PROVIDER` | **absent** |
| `backend/.env` | **does not exist** |

Determination: **no usable provider credentials are present in this environment.** Per Phase 13.2.1
rules, no credentials were requested in chat, generated, or stored; the presence check prints
booleans, never values.

## 13.2.1.2 Authentication Result

**No authentication attempt was made in Phase 13.2.1.** Because credentials were confirmed absent
*first*, the PoC short-circuits before any token call (`liveProcessingAttempted: false`). This is the
required behaviour: repeated auth attempts against a missing/known-bad client are prohibited, and the
OAuth2 flow is never weakened or bypassed. (The Phase 13.2 probe in which the token endpoint returned
HTTP 401 for a deliberately bogus client is **not** repeated here.)

Safe re-confirmation from the bounded runner: the token endpoint is **not** contacted when
`hasCdseCredentials` is false.

## 13.2.1.3 Live-Processing Result & Exact Blocker

| Field | Value |
|---|---|
| Live NDVI processing attempted | **No** (`liveProcessingAttempted: false`) |
| Outcome | `IMAGERY_FOUND` (mode `discovery-only`) |
| Proposed evidence status | `PENDING` (non-operative `SATELLITE`) |
| Provider error surfaced | None — the run stops *before* the processing stage |
| Blocker classification | **Credential/authorization prerequisite not satisfied** (not a provider outage, quota, or data-quality failure) |
| What is NOT claimed | Live NDVI, biophysical change, or crop damage — none were produced |

**Exact prerequisite to unblock (single, bounded action):** provision a **CDSE Sentinel Hub OAuth2
client** (client id + client secret, granted the Sentinel Hub / Processing API scope) into the
**PoC-only** environment variables `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` (or the `SENTINEL_HUB_*`
aliases), then re-run `node poc/satellite/runPoc.js`. No production env var, secret store, or config
file should be modified for this.

## 13.2.1.4 Implementation Re-Audit vs. Official Documentation

The implemented token/processing path was checked against current official Sentinel Hub / CDSE docs
(no code change required):

- **OAuth2 token flow** matches exactly: `POST` to
  `https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token` with
  `grant_type=client_credentials`, `client_id`, `client_secret` (form-urlencoded), reading
  `access_token` as a Bearer token. ✅ Confirmed against CDSE Authentication docs.
- **Statistical API request** is well-formed: `input.bounds` (`bbox` + `properties.crs`),
  `input.data[].type = "sentinel-2-l2a"`, `dataFilter.timeRange`/`maxCloudCoverage`,
  `aggregation.timeRange`, `aggregationInterval`, `evalscript`, and `resx`/`resy`. ✅ Confirmed
  against the Statistical API reference.
- **Statistical API response** parsing matches the documented shape
  `{ data: [ { interval, outputs: { default: { bands: { B0..Bn: { stats: { mean } } } } } } ] }`.
  ✅ The parser reads named band outputs and never assumes extra fields.
- **`dataMask` requirement** is honored: Statistical API evalscripts must return a `dataMask`
  output; the PoC returns it as the final band and uses its mean as the valid-pixel fraction.
  ✅ Confirmed.
- **NDVI bands & scaling** are correct: NDVI = `(B08 − B04) / (B08 + B04)` with Red = B04 and
  NIR = B08. In Sentinel Hub, Sentinel-2 L2A evalscript values default to **REFLECTANCE in [0,1]**
  (DN = `10000 × reflectance`), so **no `/10000` rescaling is applied** — applying one would be a
  bug. ✅ Confirmed against S2 L2A data-options docs.

Optional (not applied in this phase, listed as future hardening): set evalscript `units:
"REFLECTANCE"` explicitly, add `dataFilter.mosaickingOrder: "leastCC"` to prefer the least-cloudy
pixel per interval, AOI-level masking via SCL/s2cloudless, and geometry-based AOI instead of bbox
for non-rectangular parcels. These were **not** implemented because they cannot be live-validated
without credentials, and unvalidated changes to the processing path are out of scope.

## 13.2.1.5 Selected Product & Acquisition Dates (from live discovery)

Discovery is **live and real**; acquisition dates below are actual provider metadata. The
preferred/selected pair is documented, but **no pixels were processed**:

- **Optical (preferred):** Sentinel-2 L2A — best pre `S2B_MSIL2A_20240310T045649_..._T44PKT`
  (2024-03-10, cloud **0.2 %**); best post `S2B_MSIL2A_20240419T045659_..._T44PKT` (2024-04-19,
  cloud **23.8 %**).
- **SAR (discovered only):** Sentinel-1 IW GRD, e.g. descending passes 2024-03-05, 2024-03-17,
  2024-03-29, 2024-04-22.
- **AOI:** synthetic `SYNTHETIC-POC-PARCEL-THANJAVUR-TN`, 1.0829 acres, bbox
  `[79.1375, 10.7864, 79.1381, 10.787]`, 66 m × 67 m.

## 13.2.1.6 Actual Metrics

| Metric | Value | Type |
|---|---|---|
| Live NDVI (pre/post) | **none produced** | blocked (no credentials) |
| Live `deltaNdvi` | **none produced** | blocked (no credentials) |
| Optical scenes discovered | 20 (real) | live provider response |
| SAR scenes discovered | 6 (real) | live provider response |

There are **no live NDVI numbers to report**, and none are fabricated. Mocked NDVI values exist only
inside `tests/satellitePoc.unit.test.js` (offline) and are **not** live results.

## 13.2.1.7 Data-Quality & Scientific Limitations

Unchanged from Phase 13.2 and reconfirmed: cloud-cover metadata is **scene-level, not AOI-level**;
the monsoon window is cloud-prone (observed scene cloud 0.2 %–~67 %); NDVI over the aggregate path
uses the ratio of band means (an approximation) rather than full per-pixel statistics; SAR is
discovered but not processed; the parcel is synthetic. No result here supports any statement about
real crop damage, and missing/cloud-obscured imagery is never a negative agricultural finding.

## 13.2.1.8 Request Count & Duration (this phase's safe re-run)

| Run | Requests | Duration | Result |
|---|---|---|---|
| `npx vitest run tests/satellitePoc.unit.test.js --no-file-parallelism` | 0 network | ~1.2 s | 18/18 passed |
| Regression set (6 files) | 0 network | ~10.6 s | 141/141 passed |
| `node poc/satellite/runPoc.js` (bounded, read-only) | **3** | **~3.1 s** | `IMAGERY_FOUND`, `PENDING`, `liveProcessingAttempted: false` |

No imagery bytes were downloaded; only JSON metadata. No retries or repeated auth requests occurred.

## 13.2.1.9 Files Changed in Phase 13.2.1

- **Modified:** this report (`backend/PHASE_13_2_SATELLITE_POC_REPORT.md`) — Phase 13.2.1 addendum
  appended only; original Phase 13.2 content preserved verbatim.
- **Created:** none.
- **Code changed:** none — the PoC re-audit required no code change (implementation already matches
  official docs).

## 13.2.1.10 Production-Untouched Confirmation

No production code, config, schema, route, controller, service, model, or engine was modified. No
satellite evidence was persisted into any claim. No claim status was created or altered. No
credentials were created, requested, printed, logged, or committed. No commit, push, PR, deploy, or
AWS configuration change was performed. Claim-decision boundaries and the frozen evidence contract
remain intact (`SATELLITE` stays non-operative; every PoC outcome maps only to a frozen evidence
status).

## 13.2.1.11 Phase 13.3 Readiness

| Item | State |
|---|---|
| Isolated PoC + unit tests | Ready |
| Live discovery path | Validated live |
| Processing path | Implemented + doc-verified, **not** live-validated |
| SAR follow-up | Discovered only; analysis correctly **deferred to Phase 13.3** according to plan |
| Open prerequisite | CDSE Sentinel Hub OAuth2 client credentials (PoC-only env) |
| Blocking condition for Phase 13.3 scientific work | Resolve the credential prerequisite; otherwise Phase 13.3 live-analysis work remains **BLOCKED** and must not proceed on mocked data |

**Phase 13.2.1 conclusion:** the live-validation portion is **complete to the extent the environment
permits** — the sole unmet prerequisite is provider credentials, which are absent by design and were
**not** worked around. Per the phase stop conditions, work halts here pending review. No mocked output
is presented as live evidence.
