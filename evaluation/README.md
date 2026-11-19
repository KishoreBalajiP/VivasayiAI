# Vivasayi AI - Evaluation Kit

This kit tests Vivasayi AI the way the papers we compare with tested their systems, and
produces overall accuracy, a confusion matrix, precision, recall, F1 and kappa.

| Part | Compared with | Method used by them | What this kit does |
|---|---|---|---|
| Farming assistant | KrishokBondhu (72.7%), AgroLLM (95.2%) | Real questions, each answer marked by a judge | `assistant_eval.py` asks Vivasayi AI 50 questions and saves the answers for a judge; `score_assistant.py` computes accuracy |
| Satellite check | Bocchino et al. (74%), Chakraborty et al. (84.12%) | Predictions compared with field-verified damage using a confusion matrix | `satellite_eval.py` runs our NDVI rule on labelled fields and computes the confusion matrix |

Claims cannot be tested on real data (government/insurance data is confidential), so the
claim module keeps its 192 prepared test cases.

---------------------------------------------------------------------------------------
## Setup (once)

    pip install -r requirements.txt

---------------------------------------------------------------------------------------
## TEST 1 - Farming assistant (about half a day + judge time)

### Step 1. Get a login token
The backend accepts its own 15-minute access token (`Authorization: Bearer ...`, HS256, signed
with `SESSION_JWT_SECRET`). Two ways to get one:

- **Local backend (recommended):** `node evaluation/make_token.mjs` (run from the repository root)
  prints a token for a dedicated evaluation user. `config.example.json` already calls it through
  `token_command` and refreshes it every 10 minutes. It works only against a backend that has the
  same `SESSION_JWT_SECRET`, i.e. your local server.
- **Deployed backend:** sign in in the browser, open DevTools > Network, copy the
  `Authorization: Bearer ...` value of any backend request into `token`, and remove
  `token_command`. It expires after 15 minutes.

Copy `config.example.json` to `config.json` (it is gitignored). The script uses the real contract:
`POST /chatsessions/new {"title"}` -> `data.session._id`, then
`POST /chat {"message", "language": "en"|"ta", "chatId"}` -> reply text in `data.response`.

### Step 2. Ask all questions (from the repository root, with the backend running)
    py -3 evaluation/assistant_eval.py --config evaluation/config.json --questions evaluation/questions.csv --out evaluation/answers.csv
    # smoke test: add --limit 3     re-ask only failed rows: add --retry-errors

Each question is sent in a NEW chat session so earlier questions do not affect later ones.
If the assistant asks a follow-up question instead of answering, the script records it in
the `followup` column. That is allowed: the judge rates the final answer.

### Step 3. Judge
Give `answers.csv` (or the Claude Sheet "Vivasayi AI - Assistant Accuracy Test") to a judge
who did NOT build the system: agriculture faculty, a TNAU / agri student or an agriculture
officer. For each answer they write in the `rating` column:

    Correct         - advice is right and usable for a Tamil Nadu farmer
    Partly correct  - right direction but missing or slightly wrong detail
    Wrong           - wrong, unsafe or not useful

Rules for the judge (write these in the report):
- Judge only agricultural correctness, not grammar.
- Use TNAU Agritech Portal / Crop Production Guide as the reference when unsure.
- Rate every answer; do not skip.

### Step 4. Score
    python score_assistant.py --rated answers_rated.csv

Prints: total, correct, partly, wrong, Overall accuracy = Correct / Total,
and "lenient" accuracy = (Correct + Partly) / Total, plus English vs Tamil accuracy.
Report the STRICT accuracy as the main number (same as KrishokBondhu's "high-quality").

---------------------------------------------------------------------------------------
## TEST 2 - Satellite check (2-5 days, most time goes to collecting ground truth)

### Step 1. Build ground truth  ->  `fields.csv`
You need 30-60 fields whose real condition is known. Columns:

    field_id, lat, lon, event_date (YYYY-MM-DD), label (damaged / not_damaged), source

Where to get them (write the source for every row):
- Fields you or relatives visited after a flood/cyclone, with a phone photo + GPS.
- Village-level lists in district crop-loss reports / news for Michaung (Dec 2023,
  Chennai, Tiruvallur, Kancheepuram) and the Dec 2023 southern floods (Thoothukudi,
  Tirunelveli). Pick the field point on satellite basemap inside that village.
- NOT_DAMAGED controls: fields in the same district outside the flooded area, same dates.
Keep roughly half damaged and half not damaged. Do NOT pick points after looking at NDVI -
fix the list first, then run the script.

### Step 2. Run
    python satellite_eval.py --fields fields.csv --out satellite_results.csv

For each field it downloads Sentinel-2 L2A (Microsoft Planetary Computer, free, no login),
takes a 50 m x 50 m box around the point, masks cloud/shadow with the SCL layer, and applies
the SAME rule as Vivasayi AI:
- before window: 40 to 5 days before the event; after window: 1 to 20 days after
- at least 60% clear pixels in both windows, else INCONCLUSIVE
- mean NDVI drop >= 0.15 -> DAMAGED, else NOT_DAMAGED

### Step 3. Results
The script prints and saves:
- Confusion matrix (predicted vs ground truth) on fields with a decision
- Overall accuracy, precision, recall, F1, Cohen's kappa  (same metrics as the papers)
- Inconclusive rate (fields with too much cloud) - report it separately, do not hide it

---------------------------------------------------------------------------------------
## What to send back for the report
1. `answers_rated.csv` + judge name/designation
2. `satellite_results.csv` + `fields.csv` (with sources)
3. The printed summaries from both scorers

Only real, completed results go into the report.
