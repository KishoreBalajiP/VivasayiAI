# Evaluation results (19 November 2026)

Every number here was produced by a script in this folder or the repository. Nothing was estimated by hand.

## 1. Farming assistant: 40 questions rated by two farmers

50 questions were prepared (`questions.csv`). 40 were answered by Vivasayi AI (`gemini-2.5-flash`, default retrieval mode). The other 10 (Q35, 37, 38, 41, 42, 43, 45, 46, 47, 50; 8 of them Tamil) could not be answered because the Gemini API daily quota was exhausted. They are excluded and reported here.

Two farmers rated each of the 40 answers independently (Correct / Partly correct / Wrong). Farmer 2 used the sheet numbers of `farmer_rating_sheet.md`, which `farmer_scores.py` maps to question numbers.

| | Farmer 1 | Farmer 2 | Mean |
|---|---|---|---|
| Correct / Partly / Wrong | 20 / 15 / 5 | 16 / 18 / 6 | 18 / 16.5 / 5.5 |
| Strict accuracy (Correct / 40) | 50.0% | 40.0% | **45.0%** |
| Lenient accuracy ((Correct + Partly) / 40) | 87.5% | 85.0% | **86.3%** |
| English / Tamil correct | 12/30, 8/10 | 11/30, 5/10 | |

- **Inter-rater agreement:** 60% exact, Cohen's kappa 0.347 (fair).
- **Stricter consensus** (the lower label when the farmers differ): 12 / 19 / 9, giving 30.0% strict and 77.5% lenient.
- **LLM judge (Claude), secondary and not human:** 19 / 11 / 10, giving 47.5% strict and 75.0% lenient (`answers_rated_40.csv`).

Files: `answers.csv` (all 50 rows), `answers_40.csv`, `farmer_rating_sheet.md` / `.csv`, `farmer_scores.json`, `answers_farmer_rated_40.csv`.

## 2. Claim verification: 192 prepared scenarios (design-rule ground truth, not real claims)

Policy `v2-components`: 2 valid claims approved, 150 inflated claims stopped, 40 held for an officer (all inflated), 0 inflated claims wrongly approved. Correct automatic decisions: 152/192 = **79.2%**. Identical to the report. File: `claim_results.json`.

## 3. Satellite NDVI rule: simulation only (no real imagery)

`scripts/eval/satellite.sim.eval.js` (seed 20261016) generates 11,200 cases with known truth:
- 7 true NDVI drops: 0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40
- 4 post-event clear-pixel fractions: 0.9, 0.7, 0.5, 0.3
- 400 trials per condition
- pre-event NDVI drawn from 0.50–0.85, Gaussian noise SD 0.03

Each case goes through the app's own `parseNdviStatisticalResponse` and `interpretNdviChange`. Source data: `docs/research/evaluation/results/satelliteSimulation.json`.

| Truth rule | Decided | Inconclusive | TP / FN / FP / TN | Accuracy | Precision | Recall | F1 | Kappa |
|---|---|---|---|---|---|---|---|---|
| Any drop > 0 = damaged | 5,600 | 5,600 (50%) | 2818 / 1982 / 0 / 800 | 64.6% | 1.000 | 0.587 | 0.740 | 0.289 |
| Only drops >= 0.15 = damaged | 4,000 | 4,000 (50%) | 2721 / 479 / 0 / 800 | 88.0% | 1.000 | 0.850 | 0.919 | 0.694 |

The 50% inconclusive rate is by design: half the conditions have only 30–50% clear pixels, below the 60% minimum. File: `satellite_sim_accuracy.json`.

**Real-field accuracy has not been measured:** no field-verified damage labels exist (`fields.csv`). `satellite_eval.py` is aligned with the backend rule and ready for such labels.

## Limitations

- Two raters, 40 questions; agreement only fair.
- 10 of the 50 questions are unanswered, which under-represents Tamil.
- Claim scenarios use the system's own design rule as ground truth.
- The satellite figures come from simulation and do not show that NDVI change identifies real crop loss.

## How each number was produced

| Result | Command | Output |
|---|---|---|
| Answers | `py -3 evaluation/assistant_eval.py --config evaluation/config.json --questions evaluation/questions.csv --out evaluation/answers.csv [--retry-errors]` (repo root, backend running, token from `node evaluation/make_token.mjs`) | `answers.csv` |
| Farmer scores | `py -3 farmer_scores.py` (in `evaluation/`) | `farmer_scores.json` |
| LLM-judge score | `py -3 score_assistant.py --rated answers_rated_40.csv` (in `evaluation/`) | `score_assistant_output_40.txt` |
| Claims | `VIVASAYI_SKIP_DOTENV=1 node evaluation/claim_eval.mjs` (repo root) | `claim_results.json` |
| Satellite simulation | `node evaluation/satellite_sim_accuracy.mjs` (repo root) | `satellite_sim_accuracy.json` |
