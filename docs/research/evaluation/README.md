# Evaluation protocol and reproducibility

This folder holds the experiments behind the research write-up. It separates four kinds of evidence, because
they answer different questions and must never be mixed:

| Kind | What it shows | Where |
|---|---|---|
| 1. Unit and integration tests | The code behaves as specified and does not regress | `tests/` (`npm test`) |
| 2. Synthetic benchmarks | A component enforces its rule and how it behaves on known inputs | `scripts/eval/`, `results/` |
| 3. Live-provider validation | The system works against real Gemini, Copernicus, MongoDB, S3 | **pending** (no credentials) |
| 4. Real-world research experiments | Accuracy on real claims, documents and imagery | **pending** (no data, no annotators) |

A passing test suite does not establish scientific accuracy. A successful API request does not establish
fraud-detection performance. Every result file carries its own `groundTruth` and `limitations`.

## Reproducing

```bash
npm ci --legacy-peer-deps
npm run eval -- --date=YYYY-MM-DD     # writes results/*.json and results/SUMMARY.md
npm test                              # includes tests of the harness itself
```

Everything is seeded and deterministic; the same commit gives the same numbers. The runner needs no
credentials and makes no network call (an in-memory MongoDB is used for the chat evaluation, and weather is a
stub). Environment, commit and whether the working tree was dirty are recorded in each result.

**Published results are not rewritten for a new row.** `npm run eval` overwrites `results/*.json`. So a row
added after publication goes to its own dated, write-once file:

```bash
# The v1.1-safe-ai row of the fusion benchmark (added 2026-10-16, ADR-022). It refuses to overwrite an
# existing file, and refuses to run unless the published rows of results/fusion.json still reproduce
# byte for byte (EV-16).
VIVASAYI_SKIP_DOTENV=1 node scripts/eval/fusion.eval.js --safe-ai-row --date=YYYY-MM-DD
```

`runFusionEvaluation()` now includes the `v1.1-safe-ai` row too, as the last row, so a later `npm run eval`
writes it into `results/fusion.json` as well. `scripts/eval/manuscriptTables.js` then requires the two
copies to agree. Test EV-16 (`tests/researchAlignment.unit.test.js`) checks that the published rows are
unchanged.

## What each evaluation measures

| Script | Question | Ground truth | Status |
|---|---|---|---|
| `geometry.eval.js` | Are area, containment, overlap and validity computed correctly? | Analytic rectangle arithmetic, independent of the code | Run |
| `names.eval.js` | Does the name matcher tell the same name in another script from a different name? | **Author-assigned labels** on 60 hand-built pairs | Run, optimistic (tuned on the same set) |
| `fusion.eval.js` | What does each evidence component change in the approval decision, and what does each policy (`v1-legacy`, `v2-components` and its ablations, `v1.1-safe-ai`) decide? | The design rule (same rule the gate implements) | Run; the `v1.1-safe-ai` row is in `results/fusion_v1.1_2026-10-16.json` |
| `chatContext.eval.js` | Does context resolution cut unnecessary follow-up questions without missing needed ones? | A written specification of "necessary"; **author-defined** | Run |
| `satellite.sim.eval.js` | How do the NDVI-change thresholds behave under noise and cloud? | The simulation's own parameters; **no imagery** | Run |
| `docExtraction.score.js` | Field-level accuracy of document reading | Manually verified labels | **Scorer only; no results** |

### Findings so far (full numbers in `results/SUMMARY.md`)

- Containment, overlap flagging and invalid-geometry detection are exact on the synthetic set. This validates the
  implementation against analytic geometry; it does not say how it agrees with real cadastral boundaries.
- **The server's area is about 0.6% larger than an ellipsoidal reference at Tamil Nadu latitudes**, in every
  case. The formula uses the equatorial radius of a sphere. Acreage feeds eligibility ratios and, potentially,
  compensation, so this is reported as a decision for the product owner (see limitations in the manuscript),
  not silently changed: stored parcel and claim areas would no longer be comparable with new ones.
- The shared geometry validator accepted longitude 200 (only the API schema rejected it). It now checks
  ranges itself.
- Against the previous "ends with ?" rule, the new context logic asks no unnecessary questions and misses no
  necessary ones on the specification, while the old rule asked unnecessarily in most cases and silently
  assumed a crop whenever a farmer had several. The specification and the new logic share an author; the
  baseline is a reimplementation of the old heuristic.
- In the fusion benchmark the legacy photo-only policy approves claims with missing, pending or inconsistent
  ownership evidence and overlap with another farmer; the gate does not. Removing the photographs or geometry
  requirement changes nothing, because the frozen engine rules already enforce those; the gate's own
  contributions are claimant rights and cross-farmer overlap.
- Satellite and weather evidence never change a decision (0 of 1,536 comparisons per policy), by design.
  This holds under all three policies; under `v1.1-safe-ai` they do not change a hold either.
- **`v1.1-safe-ai` (2026-10-16, `results/fusion_v1.1_2026-10-16.json`).** It approves exactly what
  `v1-legacy` approves (10 of 190 forbidden scenarios), so it does **not** reduce invalid approvals.
  It rejects none of the 2 scenarios in which only the AI reading stands against the claim; `v1-legacy`
  rejects both. Against `v1-legacy`, the only decisions that change are 12 rejections produced by the AI
  rule, which become holds for review. The factorial has no technical-failure factor, so the v1.1
  behaviour on provider failures is covered by tests (`tests/claim.verify.safeAi.test.js`), not by this
  benchmark. No acceptance or live run has used `v1.1-safe-ai` yet.

## Live feasibility study (16 October 2026)

Read-only against production data stores. Full results and disclosures are in [live/LIVE_RESULTS_2026-10-16.md](live/LIVE_RESULTS_2026-10-16.md).

- **Sentinel-2, 12 live runs:** 0 of 9 event squares supported loss, and 1 of 3 harvest-control squares gave a false "supports loss".
- **Retrieval, 22 queries:** a relevant chunk for 2 of 13 answerable questions, and 0 of 27 chunks could answer advisory questions.
- **Farmer journeys under `v1-legacy` and `v2-components`:** every step passes except live chat. The study
  predates `v1.1-safe-ai`; a hermetic v1.1 acceptance run (mock AI) has not been recorded yet.
- **Blocked:** live chat and document extraction (Gemini free-tier quota).

Post-event satellite scenes (dated note, 2026-10-16). The 16 October run did not record the post-event scenes. Since then the adapter returns `discovery.scenesByWindow` (test PC-7), and `scripts/live/satelliteCaseStudies.js` records it per case. Any future run therefore records the post-event scenes and their cloud cover. The 16 October record is unchanged: see [live/satellite_case_studies_2026-10-16.provenance.md](live/satellite_case_studies_2026-10-16.provenance.md).

## Manuscript

The manuscript (`docs/research/manuscript/`) takes every number from these result files through
`scripts/eval/manuscriptTables.js`. It is now also ported to the IEEE Access template
(`main-access.tex`), and is **not submission-ready**; see `docs/research/manuscript/README.md`.

## What is pending, and what it needs

| Pending experiment | Needs |
|---|---|
| Answer relevance, groundedness, citation correctness of the live assistant | A **billed** Gemini key (free tier: 20 requests/day); script ready (`scripts/live/chatContext.live.js`); a rubric and at least two expert raters (see below) |
| Land-document field extraction accuracy | 100+ document images (real with consent, or realistic), manually verified labels, Gemini key |
| Satellite agreement with damage | Acquisition now works live (12 runs). Still needs parcels with independently established damage labels (field survey or insurer assessment) and crop-calendar-aware windows |
| Duplicate-claim and ownership-mismatch detection on real data | Authorised access to official parcel records or a partner's anonymised claims |
| Unnecessary-question experience | A small user study with farmers (consent, Tamil-language materials) |
| Held-out evaluation of the name matcher | Names from real documents that were not used to tune the matcher |

## Annotation guidelines (for the pending experiments)

**Document fields.** For each image, two annotators independently transcribe the fields in
`scripts/eval/docExtraction.score.js` (`SCORED_FIELDS`) into the labels JSON. Leave a field `null` when it is
not on the document or is illegible; never infer it. Holder names are listed as written, in the script
used. Disagreements are resolved by a third annotator. Report inter-annotator agreement (Cohen's kappa for
presence, exact agreement for values) before reporting any model score.

**Assistant answers.** Raters see the farmer's profile, the question and the answer, not which system produced
it. Score 1 to 5 each for: relevance to the question, correctness for Tamil Nadu agriculture, appropriate use
of the farmer's own context, and unsupported claims (count them). Ask raters to mark any answer that would be
unsafe to follow. Randomise order; use at least two raters; report agreement.

**Claim ground truth.** A damage label needs an independent source (field survey record, insurer loss
assessment, or a documented agricultural-officer finding). A farmer's own statement, a photograph, or a
vegetation-index change is not ground truth for any of those.

## Threats to validity (summary)

- Author-defined labels and specifications make the synthetic results confirmatory, not independent.
- The name matcher was tuned on its own evaluation set; the score is optimistic.
- Synthetic scenarios are cleaner and less correlated than real claims.
- No result here is from a live provider; model behaviour under real prompts and images is untested.
- The NDVI thresholds are provisional. Normal seasonal change, and paddy being flooded early in the season, can
  produce a large NDVI change without damage.
