# Satellite evidence: limitations

**Status (2026-10-17).** The Sentinel-2 adapter is implemented and automated-test verified against fixtures (including a recorded live response). It was exercised live in **12 case-study runs on 16 October 2026**, through the production adapter but from a research script, not from the app's claim flow. It has **not** been validated against labelled damage, and authenticated processing is **off by default**. Nothing about satellite is real-world validated.

## 1. Role: supporting evidence only

Satellite imagery never blocks, delays or changes a claim decision, under any policy (owner decision D1, ADR-022).

| Guarantee | Where it is enforced |
|---|---|
| The engine never waits for the satellite job | `NON_BLOCKING_STEPS = ["satellite"]`, `services/verificationJobs.service.js:70`; applies to all three policies |
| A satellite result never re-triggers the engine | `DECISION_INPUT_STEPS` excludes satellite (line 91) |
| No policy requires the satellite component | `allOptional` in `config/verificationPolicy.js`; `v2-components` does not list satellite as required |
| A dead satellite job opens no review case | `SUPPORTING_STEPS`, line 72 |
| No decision changed by satellite or weather | Synthetic fusion benchmark: 0 of 1,536 comparisons under `v1.1-safe-ai` (`docs/research/evaluation/results/fusion_v1.1_2026-10-16.json`), PV-5 |

NDVI change is not proof of cause. A drop can come from harvest, flooding, ploughing or senescence; no change can mean the field was already bare.

## 2. Live feasibility study (16 October 2026)

12 runs of `scripts/live/satelliteCaseStudies.js` through the production adapter, 100 m squares ([LIVE_RESULTS_2026-10-16.md](../research/evaluation/live/LIVE_RESULTS_2026-10-16.md), `satellite_case_studies_2026-10-16.json`):

| Group | Squares | Supports loss | No change | Inconclusive |
|---|---|---|---|---|
| Near 3 documented flood or cyclone events | 9 | 0 | 5 | 4 |
| Harvest control, Thanjavur, February 2024 | 3 | **1 (false)** | 1 | 1 |

- The control's false "supports loss" came from a ΔNDVI of about −0.25 across the harvest. A fixed pre/post window cannot tell harvest from damage.
- Land cover and crop in the event squares were not verified; several were bare or flooded before the event.
- The recorded scene cloud fractions cover the pre-event window only. The provenance of the run was reconstructed from code afterwards (`satellite_case_studies_2026-10-16.provenance.md`), not recorded at run time.
- The scene-cloud limit for parcel statistics was raised from 0.3 to 0.9 **after seeing these results** (disclosed). The NDVI thresholds were not changed.

## 3. Configuration that limits what it can see

| Limit | Default | Effect |
|---|---|---|
| Processing switch | `SATELLITE_PROCESSING_ENABLED=false` | **Discovery runs (anonymous), processing does not.** A claim with imagery found shows `unavailable / analysis_not_enabled`, never `passed`. Processing needs this flag **and** `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` |
| Adapter switch | `SATELLITE_ENABLED=true` | `false` switches discovery off too (`unavailable / not_enabled`) |
| Scene cap | `SATELLITE_MAX_SCENES=10` | One catalogue search per window, at most 10 scenes each (`services/satellite/provider.js:155`). Scenes beyond the cap are never considered |
| Discovery cloud limit | `SATELLITE_CLOUD_MAX=0.3` | Tile-level cloud for discovery quality |
| Processing scene cloud limit | `SATELLITE_PROCESSING_SCENE_CLOUD_MAX=0.9` | Tile-level cloud when selecting scenes for parcel statistics; per-pixel SCL masking decides the parcel itself |
| Valid pixels | `minValidPixelFraction: 0.6` (policy) | Mostly masked pixels give `inconclusive` |
| Drop threshold | `ndviDropSupport: 0.15` (policy) | Provisional and uncalibrated. In simulation a 0.15 drop is detected about half the time |
| Windows | pre `[event − 40 d, event − 5 d]`, post `[event + 1 d, min(event + 20 d, today)]` (`SHARED_TUNING.satellite`) | Provisional, not tuned per crop or event type |

## 4. Timing

`services/satelliteVerification.service.js` (`buildClaimWindows`, `runSatelliteVerificationForClaim`):

- **Post-event window not open yet** (the event was today): nothing is recorded and the job asks to run again the day after the window opens. The farmer sees `pending / waiting_for_post_event_imagery`, with `nextCheckAt` only when a job is really scheduled.
- **Post-event window open but not complete:** the result so far is recorded and the job is rescheduled to event + 21 days, when the window is complete. A claim submitted soon after the event therefore gets its final satellite result about three weeks later, long after the decision.
- **Transient provider errors** (quota, timeout, provider error) are recorded as `UNAVAILABLE` and retried 1 h later, without using an attempt, while the job's `rescheduleCount` is below 3. The window reschedules count towards the same 3, so a claim that was already rescheduled twice for its window gets only one transient retry.
- When the job keeps failing it dies after 5 attempts; no review case is opened. The farmer sees `failed / technical_issue`, or the earlier result with the note `latest_check_failed`.

## 5. What the farmer sees

The progress contract maps every satellite situation to a status with a fixed truth table; first match wins and the catch-all is `unavailable / provider_unavailable`, never `passed`. The full table is in [PROGRESS_CONTRACT_v1.md](../architecture/PROGRESS_CONTRACT_v1.md#satellite). The rules that matter:

- `passed` (`vegetation_drop_consistent_with_damage`) only when an analysis actually ran and returned `SUPPORTS_LOSS`.
- `NO_CHANGE` is `inconclusive` (`no_clear_vegetation_change`), never `failed`: it never counts against the farmer.
- Cloud, no imagery, too few images: `inconclusive`. Provider failures: `unavailable`.
- Every satellite object carries `supportingOnly: true`. NDVI values, provider names and job details never reach the farmer.
- The tracker's `SatelliteCard` always shows the supporting-only note and the observation windows; `passed` uses the neutral info tone ("Supports your report"), never a success tone, and no status uses the danger tone (frontend `src/components/claims/SatelliteCard.tsx`).

Reviewers see the internals (`deltaNdvi`, the adapter outcome, scenes) in `GET /admin/claims/:claimId/verification-diagnostics`.

## 6. Before relying on it more

- Validate against field-verified, labelled parcels (not done).
- Handle harvest and paddy flooding (for example crop calendars, or SAR, which the adapter only discovers today).
- Record post-event cloud cover and the scene cap per run (the new provenance code does; it needs an owner-approved live re-run).
- Keep it supporting-only until then.
