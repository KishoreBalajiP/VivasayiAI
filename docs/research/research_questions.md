# Research questions and hypotheses

Defined **before** interpreting results, and restricted to questions that can be tested with data that exists
or is realistically obtainable. Each states the baseline, the measure, the acceptance criterion, and what is
needed to run it. A question that cannot be tested yet is marked pending, not answered.

| # | Question | Hypothesis | Baseline | Measure and acceptance criterion | Status |
|---|---|---|---|---|---|
| RQ1 | Does resolving context from the farmer's own records reduce unnecessary follow-up questions without missing necessary ones? | The new logic asks fewer unnecessary questions and misses no more necessary ones than the previous rule | The previous "ends with ?" rule, reimplemented | Unnecessary-follow-up rate and missed-necessary rate against a written specification; accept if unnecessary is lower and missed is not higher | **Tested on a synthetic specification.** Real-user and rater-based version pending |
| RQ2 | Does profile-aware, retrieval-grounded answering improve answer relevance and groundedness over a generic assistant? | Yes | The same model with no farmer context and no retrieval | Expert ratings (relevance, correctness, unsupported-claim count), at least 2 raters, paired comparison | **Pending** (needs Gemini key and raters) |
| RQ3 | Does combining claimant-rights evidence, geometry and cross-farmer overlap with deterministic fusion prevent invalid approvals that photograph-only review would allow? | Yes for claims with missing or inconsistent ownership evidence and for overlap with another farmer | The legacy photograph-and-geometry policy | Invalid-approval rate and wrongful-block rate on labelled claims | **Tested as rule conformance on synthetic scenarios only.** Real-claim version pending |
| RQ4 | Does pre/post-event satellite evidence add information over photographs alone? | Possibly, only where imagery is clear; unknown otherwise | Photographs-only assessment | Agreement with independent damage labels, inconclusive rate, acquisition success | **Pending** (needs Copernicus credentials and labelled events). Threshold behaviour only is simulated |
| RQ5 | How do missing data, cloudy imagery and an unavailable land-record provider affect outcomes? | They produce `unavailable` / `inconclusive` / holds, never silent approvals or rejections | n/a | Behavioural: proportion of cases reaching each outcome under injected failures | **Tested** in the adversarial test suite (15 scenarios) and the fusion benchmark |
| RQ6 | Does the deterministic engine give consistent, auditable decisions? | Identical evidence gives identical decisions, each tied to a policy version and evidence snapshot | A single-model decision | Determinism tests; every decision records policy hash and evidence references | **Tested** (unit and integration) |
| RQ7 | Does AI document reading plus deterministic comparison detect inconsistent documents? | Detects inconsistencies in holder name, district, area and instruction-like text | Manual comparison | Field-level F1 and inconsistency-detection precision/recall on labelled documents | **Pending**; the comparison step is tested on synthetic cases only |

## What these questions deliberately do not claim

- That the system detects fraud. Overlap, name and document findings are review signals, not verdicts.
- That NDVI change identifies crop loss or its cause.
- That AI document reading proves ownership or authenticity.
- Any improvement over the state of the art. No comparison to published systems has been run.
