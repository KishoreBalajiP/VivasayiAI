# Provenance of `satellite_case_studies_2026-10-16.json`

> **Reconstructed from code at commit `6dbe6b8`, not recorded at run time.** The 16 October 2026 run
> did not save its commit, configuration, thresholds or post-event scenes. Everything below is read
> from the repository code and from the result file as it stands. It describes what the code at
> `6dbe6b8` would have used. It cannot prove what the run actually used. Written 2026-10-16.

The result file is frozen: it is not edited, and its SHA-256 is pinned in `FROZEN_HASHES.json`.
From now on `scripts/live/satelliteCaseStudies.js` records most of this information itself, in a
`provenance` block and in per-case fields (thresholds, evalscript hash, all notes, scenes per
window, and whether the scene cap was reached). It also writes write-once, so a later run cannot
replace this file. **Post-event scenes are still not recorded** (status 2026-10-16): the script can
record them only from the adapter's `discovery.scenesByWindow`, and adapter 13.3.0 does not return
it yet (plan Part D, test PC-7, both open). Until it does, every case's `scenesByWindow.post` is
`null` and `scenesByWindowSource` is `derived_from_discovery_scenes_incomplete`.

> **Status update (2026-10-16, later the same day).** The adapter now returns
> `discovery.scenesByWindow` (`services/satellite/satelliteAdapter.js`, test PC-7 passes), so a future
> run records each case's post-event scenes and their cloud cover, with `scenesByWindowSource:
> "adapter"`. The adapter's version string is still `13.3.0`. It is part of the evidence fingerprint
> and was not changed, so a run's adapter version does not show whether it recorded post-event scenes;
> `scenesByWindowSource` does. The paragraph above and defects 1 and 2 below describe the code as it was
> when this file was written. This 16 October record is unchanged and still has no post-event scenes.
> No live re-run has been made.

## What the record itself contains

- `runDate` `2026-10-16` is the `--date` argument, not a timestamp. The record has no run start or
  end time, no git commit and no dirty flag.
- 12 cases: 3 squares (100 m sides) for each of 3 events and 1 harvest control. Every case has
  `postWindowComplete: true`, so the windows are fixed by the event dates and do not depend on the
  run date.
- Per case it keeps the outcome, scene count, `sceneCloudFractions`, the NDVI analysis (`before`,
  `after`, `deltaNdvi`, `analysisOutcome`, `reasons`), `requestCount`, `latencyMs` and at most 3
  notes. No case had more than one note, so the 3-note cut removed nothing.
- `resolutionCheck`: the production request returned `sampleCount` 400 over 4 intervals (100
  samples per interval) with a valid-pixel fraction of 0.78. The proof-of-concept request returned
  HTTP 400.

## Reconstructed from code at `6dbe6b8` (not recorded)

| Item | Value at `6dbe6b8` | Where |
|---|---|---|
| Adapter version | `13.3.0` | `services/satellite/config.js:13` (`SATELLITE_ADAPTER_VERSION`) |
| Evalscript hash | `f6ba1905fbe8` (sha1 of the NDVI evalscript, first 12 hex) | `services/satellite/ndviStatistics.js:38` (`EVALSCRIPT_HASH`) |
| NDVI-drop threshold for "supports loss" | 0.15 | `config/verificationPolicy.js:62` (`SHARED_TUNING.satellite.ndviDropSupport`) |
| Minimum valid-pixel fraction | 0.6 | `config/verificationPolicy.js:61` |
| Pre-event window | event −40 to −5 days | `config/verificationPolicy.js:59` (`preWindowDays: [40, 5]`) |
| Post-event window | event +1 to +20 days, capped at the run date | `config/verificationPolicy.js:60`, `services/satelliteVerification.service.js:23-37` |
| Scene cloud limit for parcel processing | 0.9 by default (`SATELLITE_PROCESSING_SCENE_CLOUD_MAX`); sent to the Statistical API as `maxCloudCoverage` 90 | `services/satellite/config.js:114`, `services/satellite/provider.js:221,255` |
| Discovery cloud limit | 0.3 (`SATELLITE_CLOUD_MAX`) | `services/satellite/config.js:108` |
| Scenes per STAC search (`maxScenes`) | 10 per window | `services/satellite/config.js:107`, `services/satellite/provider.js:142-155` |
| Default policy | `v1-legacy` | `config/env.js:122` |
| Policy hash, `v1-legacy`, code-default rules | `699b2c247a2b1c610c5f0191a529ae72bbb77e3ce91f7d997a31028cbfe1283d` | `config/verificationPolicy.js:119-131`. The hash also covers `CLAIM_WINDOW_DAYS`, `CLAIM_AREA_OVERAGE_FRACTION` and `CLAIM_OVERLAP_TOLERANCE_M`. Their values at run time were not recorded. |
| STAC and statistics endpoints | code defaults `https://catalogue.dataspace.copernicus.eu/stac`, `https://sh.dataspace.copernicus.eu/api/v1/statistics` | `services/satellite/config.js:21-24`; any environment override at run time is unknown |

**Is the 0.9 scene cloud limit consistent with the record?** Yes, as far as the record can show.
Every recorded pre-event scene for the three `south_tn_floods_2023` squares had a cloud fraction of
at least 0.5283. All three squares still got pre-event statistics: two were analysed, and the third
failed only on the post-event window. The Statistical API filters scenes by `maxCloudCoverage`, so
the limit in effect was at least about 0.53. This assumes the API filters on the same tile cloud
cover that the catalogue reports. The record cannot confirm the exact value.

**File times.** `services/satellite/config.js`, `services/satellite/satelliteAdapter.js` and
`services/satellite/provider.js` have a modification time of 2026-10-16 15:11:14. The result file's
is 15:12:09, 55 s later. `services/satellite/ndviStatistics.js` has 15:09:58. Modification times
show only the last write. They do not show what changed, or whether the run loaded the final
content. Git has only "initial commit" entries for these files, so git cannot settle it either.

## Defects in the record (not fixed for this file; status for future runs given per item)

1. **Cloud fractions cover the pre-event window only.** `sceneCloudFractions` comes from
   `run.discovery.scenes`. In adapter 13.3.0 that holds only the first (pre-event) window's search,
   while `scenes` counts both windows (`services/satellite/satelliteAdapter.js:457-494`). The
   post-event scenes' ids, dates and cloud cover were never recorded. So a statement that the
   post-event window was cloudy is an inference, not a measurement. **Not yet fixed for future
   runs:** it needs the adapter to return `discovery.scenesByWindow` (plan Part D, test PC-7).
2. **Scene counts are capped.** The STAC search returns at most 10 scenes per window, so a window
   with 10 scenes may have had more. Future runs record `sceneCapReached` per window; for the
   post-event window that also waits on `discovery.scenesByWindow`.
3. **Dropped by the script.** The adapter returned `analysis.thresholds` and
   `analysis.evalscriptHash` (`satelliteAdapter.js:690,696`), but the script's `summarizeRun` did not
   keep them. Fixed for future runs: `summarizeRun` now keeps both, and all notes.

## Scenes per window, derived from the record

Pre-event = length of `sceneCloudFractions`. Post-event = `scenes` minus pre-event. The post-event
counts are derived. No post-event scene was recorded individually.

| # | Event | Centre | Scenes | Pre-event | Post-event (derived) | Pre cap (10) reached | Post cap reached | Outcome / analysis |
|---|---|---|---|---|---|---|---|---|
| 1 | south_tn_floods_2023 | 77.905, 8.635 | 11 | 7 | 4 | no | no | ANALYSIS_COMPLETE / NO_CHANGE |
| 2 | south_tn_floods_2023 | 77.935, 8.62 | 11 | 7 | 4 | no | no | INCONCLUSIVE (post-event window: no valid statistics) |
| 3 | south_tn_floods_2023 | 77.96, 8.6 | 11 | 7 | 4 | no | no | ANALYSIS_COMPLETE / NO_CHANGE |
| 4 | cyclone_michaung_2023 | 80.15, 13.3 | 18 | 10 | 8 | yes | no | ANALYSIS_COMPLETE / NO_CHANGE |
| 5 | cyclone_michaung_2023 | 80.18, 13.35 | 11 | 7 | 4 | no | no | ANALYSIS_COMPLETE / NO_CHANGE |
| 6 | cyclone_michaung_2023 | 80.12, 13.25 | 18 | 10 | 8 | yes | no | ANALYSIS_COMPLETE / INCONCLUSIVE (post_event_too_few_valid_pixels) |
| 7 | cyclone_fengal_2024 | 79.43, 11.905 | 11 | 7 | 4 | no | no | INCONCLUSIVE (post-event window: no valid statistics) |
| 8 | cyclone_fengal_2024 | 79.56, 11.96 | 11 | 7 | 4 | no | no | INCONCLUSIVE (post-event window: no valid statistics) |
| 9 | cyclone_fengal_2024 | 79.38, 11.85 | 11 | 7 | 4 | no | no | ANALYSIS_COMPLETE / NO_CHANGE |
| 10 | thanjavur_harvest_control_2024 | 79.2, 10.8 | 20 | 10 | 10 | yes | yes | ANALYSIS_COMPLETE / SUPPORTS_LOSS |
| 11 | thanjavur_harvest_control_2024 | 79.3, 10.85 | 18 | 10 | 8 | yes | no | ANALYSIS_COMPLETE / NO_CHANGE |
| 12 | thanjavur_harvest_control_2024 | 79.1, 10.75 | 12 | 8 | 4 | no | no | ANALYSIS_COMPLETE / INCONCLUSIVE (pre_event_too_few_valid_pixels) |

## Re-running

A re-run would only add a new file. It would never replace this one or its numbers. It would record
the provenance block, the thresholds and all notes:
`node scripts/live/satelliteCaseStudies.js --date=<date> --tag=provenance`. It would record the
post-event scenes and their cloud cover **only if** the adapter returns `discovery.scenesByWindow`
by then (PC-7 passing); with adapter 13.3.0 it would not, and the script warns about it. Do not spend
CDSE quota on a re-run meant to measure post-event cloud before that lands. It needs CDSE
credentials and owner approval, and live data may have changed since 16 October 2026. Compare its
outcomes case by case with this file and report any drift.
