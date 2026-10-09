# Phase 13.3 — Satellite Provider Adapter Foundation Report

**Document type:** Phase deliverable report (isolated adapter foundation — non-production)
**Status:** IMPLEMENTED & UNIT-TESTED (offline) — adapter foundation built and validated in
isolation; **live authenticated NDVI processing remains UNVALIDATED/BLOCKED** (no CDSE Sentinel Hub
credentials configured); **no production integration performed**; **no claim/decision surface
touched**.
**Author:** Engineering (Phase 13.3)
**Date:** 2026-10-09
**Companion documents:** `backend/PHASE_13_1_SATELLITE_FEASIBILITY_REPORT.md`,
`backend/PHASE_13_2_SATELLITE_POC_REPORT.md`, `backend/PHASE_11_FINAL_REPORT.md`,
`backend/PHASE_12_FINAL_REPORT.md`
**Related ADR(s):** ADR-019 (Agricultural Loss / Affected-Area Claim), Phase 11 evidence foundation
annex.

---

## 1. Executive Summary

Phase 13.3 converts the validated parts of the Phase 13.2 satellite PoC into a **production-quality,
strictly isolated satellite provider adapter foundation** that future satellite observations can be
connected to the existing Vivasayi AI verification architecture **through the established evidence
contract only**.

What was built and verified:

- A new, additive module directory `backend/services/satellite/` (`config.js`, `errors.js`,
  `provider.js`, `satelliteAdapter.js`, `index.js`) exposing a **small provider interface** over the
  single recommended provider (**Copernicus Data Space Ecosystem / Sentinel Hub — `cdse-sentinel`**).
- An **honest processing boundary**: the adapter always reports `analysisExecuted` and a
  `processingStatus` (`not_attempted` / `disabled` / `credentials_required` / `unsupported` /
  `executed` / `inconclusive` / `failed`). The presence of a *prepared* request is never treated as
  proof that processing ran.
- A **non-operative `SATELLITE` evidence payload** produced through the frozen Phase 11 foundation
  (`buildVerificationEvidence`), with `operative: false` and a persisted
  `metadata.liveProcessingValidated: false`. The adapter **does not persist** evidence and **cannot**
  change a claim state, approve/reject, compute compensation, or set acreage.
- **No fabrication**: missing provider metadata stays `null`; missing/unusable imagery becomes an
  explicit `INCONCLUSIVE`/`INSUFFICIENT` outcome, never a synthetic indicator.
- **22/22 focused adapter tests pass** (fully offline, injected transport) and **181/181** focused +
  PoC + regression tests pass. The full suite is **559 passed / 8 failed**, where the only 8 failures
  are the **pre-existing, unrelated** `tests/ai.503.test.js` environmental failures (identical to the
  Phase 12 / 13.2 baseline; baseline pass count 537 + 22 new = 559).

**Overall verdict: FOUNDATION COMPLETE (offline-validated).** The adapter's own logic, error
normalization, bounded request behavior, secret handling, evidence-boundary compatibility, and
provider isolation are validated. **Live authenticated Sentinel-2 NDVI processing is UNVALIDATED and
BLOCKED pending CDSE credentials**, and the adapter is deliberately **not wired into any live flow**.

A **latent bug in the Phase 13.2 PoC** was discovered during this phase (absent cloud metadata was
mapped to `0`, i.e. falsely cloud-free). It is **handled defensively inside the adapter** without
modifying the PoC, and is recorded as a known limitation (§12).

---

## 2. Repository Audit (what existed before this phase)

Before writing code, the existing satellite work and adjacent foundations were audited to avoid
duplicating abstractions and to preserve prior (uncommitted) work.

| Area | Finding | Reuse decision |
| --- | --- | --- |
| `backend/poc/satellite/satellitePoc.js` | Phase 13.2 PoC: `validateAoi`, `validateDateRange`, `fingerprintAoi`, `normalizeScene`, `createHttpClient`, `buildStatisticalRequest`, `parseStatisticalResponse`, `fetchCdseToken`, `fetchNdviStatistics`, `ndviDelta`, `classifyHttpError`, `SatellitePocError`, `MAX_SCENES_HARD_CAP`, `POC_OUTCOMES`, `runPoc`. Review-verified against official docs in Phase 13.2.1. | **Reuse** the pure/deterministic primitives; do **not** re-implement. |
| `backend/poc/satellite/config.js`, `runPoc.js`, `testPolygon.js` | PoC config, bounded CLI runner, synthetic TN parcel + pre/post windows. | Reuse test fixtures (`testPolygon.js`); leave runner untouched. |
| `backend/tests/satellitePoc.unit.test.js` | 18 PoC tests. | Must remain compatible (guarded by an adapter test). |
| `backend/utils/verificationEvidence.js` | Phase 11 pure vocabulary: `EVIDENCE_SOURCES` (incl. `SATELLITE`), `EVIDENCE_STATUSES`, `buildVerificationEvidence`, forbidden-key rules. | **Reuse** for evidence payload construction. |
| `backend/models/VerificationEvidence.js`, `services/verificationEvidence.service.js` | Owner-scoped, audited, idempotent evidence persistence (internal; no public route). | **Do NOT call** this phase (persistence is a future, separately-authorized step). |
| `backend/services/parcelGeometry.service.js` | Authoritative geometry validator. | Read-only reuse via PoC `validateAoi`. |
| `backend/models/LossClaim.js` | Frozen `CLAIM_STATES`, `CLAIM_EVENT_TYPES`. | Not imported by the adapter (asserted by test). |
| `backend/config/env.js`, `config/weather.js`, `services/weather.service.js` | Existing env + external-provider pattern (axios, timeout, User-Agent, TTL cache, graceful degradation). | Mirrored conceptually; adapter keeps its **own** isolated config to avoid coupling. |
| `backend/package.json`, `vitest.config.js`, `tests/setup.js` | `vitest run`; node env; 120 s test timeout; local mongod system binary. | Adapter tests are DB-free and network-free. |

**Conclusion of audit:** the correct move was to **wrap** the already-reviewed PoC primitives behind a
small production boundary — not to rewrite them and not to build a generic multi-provider framework.

---

## 3. Adapter Architecture & Design Decisions

### 3.1 Module layout (all additive, all isolated)

```
backend/services/satellite/
  config.js           # isolated config resolution + redaction (no secrets logged)
  errors.js           # bounded error vocabulary + classification/retryability
  provider.js         # provider capabilities, scene normalization, discovery, processing contract
  satelliteAdapter.js # orchestration, outcome vocabulary, evidence payload boundary
  index.js            # public surface (single import point)
```

Nothing outside this directory imports it, and it imports **no** claim model, engine, route, or AI
contract.

### 3.2 Key design decisions

1. **One provider, declared capabilities** — no generic framework, no multiple providers. Provider
   facts are declared as capabilities (`discovery`, `sarDiscovery`, `processing`, `sarProcessing:
   false`), so the rest of the system never assumes an operation exists just because a request can be
   constructed.
2. **Reuse, don't duplicate** — geometry/date validation, HTTP client, scene normalization, and the
   Statistical API request/response contract are reused from the PoC. The adapter adds capabilities,
   a normalized result contract, request correlation, and honest processing status.
3. **Two independent gates for live processing** — `SATELLITE_PROCESSING_ENABLED` (explicit opt-in,
   default `false`) **AND** configured credentials. A secret existing is never sufficient to trigger a
   billable provider call.
4. **Prepare ≠ execute** — `prepareProcessingRequest()` returns a bounded descriptor with
   `executed: false`; execution is a separate, gated step.
5. **Discovery is bounded** — one request per window, `limit` clamped to `MAX_SCENES_HARD_CAP`, no
   polling, no bulk downloads.
6. **SAR is optional and non-blocking** — SAR discovery runs only on request and never blocks the
   optical path (cloud mitigation is documented, not implemented).
7. **No persistence** — `toVerificationEvidence()` returns a validated plain payload only.
8. **Honesty flags are structural** — `analysisExecuted`, `processingStatus`, and
   `liveProcessingValidated: false` are present on the top-level result **and** persisted into the
   evidence metadata.

### 3.3 Orchestration flow (`runSatelliteAnalysis`)

Configuration gate → provider/capability resolution → product selection → AOI validation →
window validation → provider construction → per-window optical discovery → optional SAR discovery →
empty/cloud/temporal-coverage quality gates → processing gate (prepare always; execute only when
enabled + credentialed) → terminal outcome + non-operative evidence payload. **Expected
provider/quality failures never throw** — they become outcomes.

---

## 4. Provider Interface & Normalized Result Contract

### 4.1 Provider interface (`createSatelliteProvider`)

```js
{
  name,                    // "cdse-sentinel"
  capabilities,            // declared capabilities object
  http,                    // bounded HTTP client (timeout + bound retries)
  requestCount(),          // number of provider requests made
  discover({ aoi, windows, collection, correlationId }),
  prepareProcessing({ aoi, window }),
  executeProcessing({ aoi, window }),
}
```

Provider-specific transport details (STAC `/search`, OAuth token, Statistical API) stay behind this
interface; the orchestrator never constructs raw provider request shapes itself.

### 4.2 Normalized scene descriptor (`normalizeDiscoveryScene`)

`sceneId`, `provider`, `collection`, `productType`, `productLevel`, `platformFamily`, `platform`,
`acquisitionTime`, `spatialCoverage` (bbox), `cloudCoverFraction`, `cloudCoverPercent`,
`cloudCoverSource`, `bands`, `spatialResolutionM`, `instrumentMode`, `orbitState`, `queryWindow`,
`sourceMetadata`. **Every field the provider did not return is `null`** (verified by a dedicated test).

### 4.3 Discovery result

`provider`, `providerVersion`, `collection`, `productType`, `spatialCoverage` (`{ bbox, crs:
"EPSG:4326" }`), `queryWindows`, `discoveryTimestamp`, `correlationId`, `sceneCount`, `empty`,
`scenes`, `requestCount`, `durationMs`.

### 4.4 Processing contract

Optical processing is **Sentinel-2 L2A NDVI** with `NDVI = (B08 − B04) / (B08 + B04)`, bands
`{ red: "B04", nir: "B08", mask: "dataMask" }`, resolution 10 m, **units reflectance [0,1]**
(Sentinel Hub evalscript default — no `/10000` rescale). SAR processing is declared unsupported this
phase.

---

## 5. Configuration & Credential Handling

`resolveSatelliteConfig(env)` (never throws at import), summarized:

| Concern | Variable(s) | Default |
| --- | --- | --- |
| Provider | `SATELLITE_PROVIDER` (fallback `SATELLITE_POC_PROVIDER`) | `cdse-sentinel` |
| Credentials | `CDSE_CLIENT_ID`/`CDSE_CLIENT_SECRET` (aliases `SENTINEL_HUB_*`) | none → `hasCredentials: false` |
| Adapter enabled | `SATELLITE_ENABLED` (fallback `SATELLITE_POC_ENABLED`) | `true` |
| **Live processing opt-in** | `SATELLITE_PROCESSING_ENABLED` | **`false`** |
| Request timeout | `SATELLITE_REQUEST_TIMEOUT_MS` (fallback `..._POC_TIMEOUT_MS`) | 8000 ms |
| Max retries | `SATELLITE_MAX_RETRIES` (fallback `..._POC_MAX_RETRIES`) | 1 |
| Max scenes | `SATELLITE_MAX_SCENES` (fallback `..._POC_MAX_SCENES`) | 10 (hard cap enforced) |
| Cloud threshold | `SATELLITE_CLOUD_MAX` (fallback `..._POC_CLOUD_MAX`) | 0.30 |
| Max window days | `SATELLITE_MAX_WINDOW_DAYS` (fallback `..._POC_MAX_WINDOW_DAYS`) | 120 |
| Endpoints | `SATELLITE_STAC_URL` / `..._TOKEN_URL` / `..._STATISTICS_URL` | CDSE defaults |

- **Never throws, never logs secrets.** `redactSatelliteConfig()` omits `clientId`/`clientSecret`
  entirely; `describeCredentialRequirement()` returns only variable **names**.
- **Credentials absent in this environment** (`CDSE_CLIENT_ID`, `CDSE_CLIENT_SECRET`,
  `SENTINEL_HUB_*`, `SATELLITE_POC_*` all unset; `backend/.env` does not exist) →
  `hasCredentials: false`. No repeated authentication is attempted; the token endpoint is never called
  when credentials are missing (asserted by test).

---

## 6. Validation & Error Handling

- **Input validation** happens before any network call: authoritative AOI validation (reused) and
  bounded date-range validation (single window or pre/post pair; max span enforced).
- **Bounded error vocabulary** (`SATELLITE_ERROR_KINDS`): `CONFIG, VALIDATION, UNSUPPORTED, AUTH,
  QUOTA, TIMEOUT, NETWORK, PROVIDER, MALFORMED, INTERNAL`.
- **Retryability is bounded**: only `TIMEOUT`, `NETWORK`, `PROVIDER` are retryable. `AUTH`, `QUOTA`,
  `VALIDATION`, `CONFIG`, `UNSUPPORTED`, `MALFORMED` are **never** retried (asserted: a 401 yields a
  single attempt).
- **Malformed ≠ empty**: a STAC response without a `features` array is `MALFORMED_RESPONSE`; a valid
  response with an empty `features` array is a successful `IMAGERY_UNAVAILABLE`.

### Outcome → evidence-status mapping (one-way, read-only)

| Outcome | Evidence status |
| --- | --- |
| `INVALID_INPUT`, `CONFIG_DISABLED`, `UNSUPPORTED_*` | `NOT_CHECKED` |
| `AUTH_REQUIRED`, `QUOTA_EXCEEDED`, `PROVIDER_ERROR`, `MALFORMED_RESPONSE`, `TIMEOUT`, `IMAGERY_UNAVAILABLE` | `UNAVAILABLE` |
| `IMAGERY_FOUND` | `PENDING` |
| `CLOUD_OBSCURED`, `INSUFFICIENT_TEMPORAL_COVERAGE`, `INCONCLUSIVE` | `INSUFFICIENT` |
| `ANALYSIS_COMPLETE` | `AVAILABLE` |

`VERIFIED` is **never reachable** from satellite discovery/analysis this phase, and no outcome maps
onto a `CLAIM_STATE` (asserted by test).

---

## 7. Evidence Integration Boundary

- `toVerificationEvidence(...)` builds a canonical payload via the frozen Phase 11
  `buildVerificationEvidence` with `source: "SATELLITE"`, a one-way status mapping, and an
  `evidenceFingerprint` (sha1 over collection + windows + sorted scene ids + indicator +
  adapterVersion).
- `operative` is **derived and `false`** because `SATELLITE` is a non-operative/future source.
- Metadata carries `adapterVersion`, `provider`, collections, scene counts, query windows, cloud
  threshold, `indicator` (only if analyzed), `analysisExecuted`, `processingStatus`, `correlationId`,
  and **`liveProcessingValidated: false`**.
- **No forbidden metadata keys** (`url`, `token`, `authorization`) and no secret values are present
  (asserted by tests).
- **The adapter does not import or call the evidence persistence service.** Writing `SATELLITE`
  evidence into real claims remains a **future, separately-authorized** step layered on
  `services/verificationEvidence.service.js`.

---

## 8. Files Added / Modified

**Added (all new, additive):**

| File | Purpose |
| --- | --- |
| `backend/services/satellite/config.js` | Isolated config resolution + redaction |
| `backend/services/satellite/errors.js` | Error vocabulary + classification/retryability |
| `backend/services/satellite/provider.js` | Provider interface, capabilities, normalization, discovery, processing contract |
| `backend/services/satellite/satelliteAdapter.js` | Orchestration, outcomes, evidence boundary |
| `backend/services/satellite/index.js` | Public re-export surface |
| `backend/tests/satelliteAdapter.unit.test.js` | 22 focused offline tests |
| `backend/PHASE_13_3_SATELLITE_ADAPTER_REPORT.md` | This report |

**Modified:** none outside `backend/services/satellite/` and the new test file. The Phase 13.2 PoC
(`backend/poc/satellite/*`), all models, services, routes, controllers, the deterministic engine, the
AI contract, and `config/env.js` are **untouched**. No schema, dependency, or `package.json` change.

---

## 9. Exact Test Commands & Results

Focused adapter suite (offline, injected transport):

```
npx vitest run tests/satelliteAdapter.unit.test.js --no-file-parallelism
→ Test Files 1 passed (1) | Tests 22 passed (22)
```

Focused adapter + PoC + regression set:

```
npx vitest run tests/satelliteAdapter.unit.test.js tests/satellitePoc.unit.test.js \
  tests/verificationEvidence.unit.test.js tests/verificationEvidence.test.js \
  tests/claim.verificationEngine.test.js tests/claim.verificationEngine.phase9.test.js \
  tests/claimState.test.js tests/parcel.geometry.test.js --no-file-parallelism
→ Test Files 8 passed (8) | Tests 181 passed (181)
```

Full suite:

```
npx vitest run --no-file-parallelism
→ Test Files 1 failed | 21 passed (22) | Tests 8 failed | 559 passed (567)
```

The **8 failures are all in `tests/ai.503.test.js`** (image-upload presign returns 500 in this
environment), **identical to the Phase 12 / 13.2 baseline**. They are unrelated to satellite work and
are **not** regressions. Baseline was 537 passed / 8 failed; **537 + 22 new adapter tests = 559**.

### Test coverage (20 required scenarios)

| # | Scenario | Test |
| --- | --- | --- |
| 1 | Valid provider configuration | `resolves valid provider configuration and redacts secrets` |
| 2 | Missing credentials are safe | `handles missing credentials safely and never calls the token endpoint` |
| 3 | Invalid polygon | `rejects an invalid polygon before any network request` |
| 4 | Invalid/reversed date range | `rejects an invalid/reversed date range before any network request` |
| 5 | Unsupported product / processing | `rejects an unsupported product and an unsupported processing mode` |
| 6 | Normalized discovery result | `returns a normalized, traceable discovery result from a mocked provider` |
| 7 | Empty imagery vs API failure | `distinguishes a successful empty search from a provider failure` |
| 8 | Provider timeout | `normalizes a provider timeout as UNAVAILABLE` |
| 9 | Authentication failure | `normalizes authentication failure as UNAVAILABLE` |
| 10 | Quota / rate limit | `normalizes a quota/rate-limit response as UNAVAILABLE` |
| 11 | Malformed response | `normalizes a malformed provider response (never treats it as empty success)` |
| 12 | Bounded retries | `bounds retries to retryable kinds only` |
| 13 | Secret redaction | `never serializes credentials or tokens into the result` |
| 14 | No fabricated metadata | `never invents acquisition metadata the provider did not return` |
| 15 | No false processing claim | `reports processing as disabled and never claims it ran` + `prepares a bounded request descriptor but does not execute it when gated` |
| 16 | Inconclusive (no fabrication) | `returns inconclusive (not a fabricated indicator) when statistics are unusable` |
| 17 | Evidence payload compatibility | `produces a canonical, non-operative SATELLITE payload without persisting` |
| 18 | No decision authority | `exposes no decision API and uses only evidence statuses` |
| 19 | No live claim access | `never touches a claim: no claim identifiers in results and no DB/claim imports` |
| 20 | PoC intact | `does not break the Phase 13.2 PoC module surface or behavior` |

Plus: `executes bounded pre/post NDVI only when enabled and credentialed (mocked)`.

---

## 10. Production-Claim Boundaries — Unchanged (Confirmation)

- **No production file was modified** (only new files under `backend/services/satellite/`, a new test
  file, and this report).
- The adapter imports **no** claim model, evidence-persistence service, deterministic engine, AI
  contract, or route (verified by test and inspection). It **cannot** change a claim state,
  approve/reject, compute compensation, or set acreage.
- `EVIDENCE_SOURCES`, `EVIDENCE_STATUSES`, claim states, claim lifecycle, decision precedence, and the
  AI evidence contract are all **untouched**.
- The backend-calculated affected-polygon area remains the **only** area authority; satellite pixels
  produce **no** acreage and **no** decision.
- No schema change, no dependency change, no rate-limit change, no background job introduced.
- Nothing was committed, pushed, deployed, or pushed to AWS; this phase is **local-only** and awaits
  review.

---

## 11. Live-Processing Validation Status

| Item | Status |
| --- | --- |
| Anonymous CDSE STAC **discovery** | Validated in Phase 13.2 (live) |
| Adapter **discovery** path | Unit-tested offline; reuses validated PoC primitives |
| **Live authenticated NDVI processing** | **NOT VALIDATED — BLOCKED** |
| CDSE Sentinel Hub credentials in this env | **Absent** (`hasCredentials: false`) |
| Adapter behavior without credentials | Reports `processingStatus: "credentials_required"` (or `"disabled"`) and `analysisExecuted: false`; never calls the token endpoint |
| `liveProcessingValidated` flag | Hard-coded `false` on every result and every evidence payload |

**Exact prerequisite to unblock live validation:** provision a CDSE Sentinel Hub OAuth2 client
(client id + secret with Sentinel Hub / Processing scope) into the PoC/adapter-only env vars
`CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (or `SENTINEL_HUB_*`), **and** set
`SATELLITE_PROCESSING_ENABLED=true`. This phase deliberately does **not** perform that step and does
**not** claim the processing path works.

---

## 12. Known Limitations & Remaining Work

1. **Live processing unvalidated** — end-to-end Sentinel-2 NDVI against a real authenticated response
   has **never** been observed here. Treat all processing as unproven until then.
2. **Latent PoC bug (documented, worked around)** — the Phase 13.2 `normalizeScene` maps an **absent**
   cloud property to `0` (because `Number(null) === 0`), which would falsely report a scene as
   cloud-free. The adapter computes the cloud fraction from the raw provider property instead, so
   missing metadata stays `null`; the **PoC was left untouched**. Recommended future fix: correct
   `normalizeScene` and re-run PoC tests.
3. **Optical-only science** — SAR (Sentinel-1) discovery is available but SAR analysis is declared
   `sarProcessing: false`; monsoon cloud cover remains the dominant optical limitation (documented,
   not mitigated).
4. **No cloud/SLC masking yet** — `dataMask` is requested but not used to reject cloudy pixels within
   a scene beyond the scene-level cloud threshold.
5. **No persistence / no integration** — evidence payloads are produced but never written; wiring into
   claim verification is explicitly out of scope this phase.
6. **BBox AOI** — requests use the AOI bounding box, not a clipped geometry (hardening option from
   Phase 13.2.1: use geometry-based AOI + `mosaickingOrder: "leastCC"` + explicit `units:
   "REFLECTANCE"`).
7. **Exact CDSE free-tier quota numbers unverified** — confirm at
   `documentation.dataspace.copernicus.eu/Quotas.html`; do not assume costs.
8. **No background/polling infrastructure** — asynchronous processing would need a job system; this is
   documented as a future need, not introduced.

---

## 13. Recommended Next Phase & Stop Point

**Recommended Phase 13.4 (proposed): live processing validation + persistence boundary, gated on
credentials.**

1. Provision CDSE Sentinel Hub credentials into the PoC/adapter-only env vars and set
   `SATELLITE_PROCESSING_ENABLED=true`; capture a **real** authenticated Statistical API response and
   real NDVI output; flip `liveProcessingValidated` only when genuinely observed.
2. Add SCL/`dataMask`-based cloud rejection and geometry-based AOI (Phase 13.2.1 hardening).
3. Define — behind explicit authorization — the **persistence boundary** that writes a non-operative
   `SATELLITE` evidence record via the existing `verificationEvidence.service.js` (owner-scoped,
   audited, idempotent), still without influencing claim decisions.
4. Only thereafter consider connecting satellite evidence as **supporting (non-authoritative)**
   evidence in the verification flow.

**STOP.** Phase 13.3 is complete and awaiting review. No commit, push, PR, deployment, or AWS change
was performed.
