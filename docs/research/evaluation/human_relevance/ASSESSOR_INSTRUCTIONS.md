# Relevance assessment: instructions for assessors

**Who:** at least two people working independently, with agronomy knowledge for the advisory questions (for example a TNAU or KVK extension worker or an agriculture graduate). A third person adjudicates. An AI model must not assign, suggest or pre-fill labels.

You receive `assessor_packet.csv`. Each row is one question and one text passage retrieved by some version of the system. The file does not tell you which version retrieved it or at what rank. Please do not try to find out, and do not discuss labels with the other assessor until both files are returned.

## Fill in these columns on every row you assess

| Column | What to enter |
|---|---|
| `label` | One grade from the table below |
| `notes` | Optional. Required when the label is `U` |
| `assessor_id` | Your assigned code, the same on every row |
| `assessor_type` | The word `human` |

## Grades

Judge only the passage in front of you. Do not use outside knowledge to fill gaps in it, and do not check whether the advice is agronomically correct. Correctness is a separate review.

| Grade | Meaning | Test |
|---|---|---|
| **2** | Answer-bearing | A farmer or reader could answer the question from this passage alone |
| **1** | Topical only | Same crop, place or subject, but the passage does not contain the answer |
| **0** | Not relevant | Wrong subject |
| **U** | Cannot judge | Garbled or truncated text, or outside your competence. Say why in `notes` |

Leave `label` empty if you did not assess a row. Empty means *unjudged*, which is different from 0.

### Examples of the distinction (illustrative; not from the assessment pool)

- Question "maize production in district X". A row giving maize production for district X: **2**. A row for a different district, or a table's column names only: **1**.
- Question "how to control pest Y in crop Z". A passage giving a control measure for Y on Z: **2**. A passage describing the life cycle of Y with no control measure, or a production statistic for Z: **1**. A passage on another crop's irrigation: **0**.

## After the labels are returned

```
node scripts/live/ragHumanEval.js check --key=<key.json> --a=<a.csv> --b=<b.csv> --out=<agreement.json>
```

This rejects any file whose `assessor_type` is not `human`, reports Cohen's kappa and lists the disagreements. The adjudicator resolves each listed item in a CSV with the columns `pool_id,label,assessor_id,assessor_type`. Then:

```
node scripts/live/ragHumanEval.js metrics --key=<key.json> --a=<a.csv> --b=<b.csv> --adjudicated=<adj.csv> --runs=<run1.json,run2.json,...> --out=<metrics.json>
```

Only grade 2 counts as relevant. Unjudged items are reported, never counted as irrelevant. Recall is relative to the assessed pool, so report it as pooled recall.
