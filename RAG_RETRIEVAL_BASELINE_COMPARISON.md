# RAG Retrieval Baseline Comparison

Date: 2026-11-08

This document compares the original frozen retrieval baseline to the current filtering logic without overwriting or modifying the original historical evaluation artifacts.

## Baseline source

- `docs/research/evaluation/live/rag_retrieval_2026-10-16.json`
- Frozen relevance rule: `scripts/live/lib/ragEvalSpec.js`
- Question set: original 22-query evaluation set (13 answerable, 9 advisory)

## Comparison summary

| Metric | Original baseline | Current filter pass | Result |
|---|---:|---:|---|
| Answerable any relevant chunk in top-3 | 15.4% (2/13) | 15.4% (2/13) | unchanged |
| Answerable top-1 relevant | 7.7% (1/13) | 7.7% (1/13) | unchanged |
| Answerable expected-file retrieval in top-3 | 76.9% (10/13) | 30.8% (4/13) | worse |
| Advisory answer-bearing chunks | 0.0% (0/27) | 0.0% (0/27) | unchanged |
| Advisory topical chunks | 33.3% (9/27) | 4.5% (1/22) | lower |

## Interpretation

The safety fix for header-only chunks is valid, but it is not a retrieval-quality improvement. When the baseline is re-evaluated with the current filter on top of the exact same retrieval results, the relevant-answer metric is unchanged and expected-file retrieval declines.

## Query examples

### Example of failure

A1: `rice production in Thanjavur district 2017-18`

Original top hits:
- `production_of_rice_in_2017_18.csv` — `headerOnly: true`, `relevant: false`
- `timeseriesdata_prodtyandproduction_2.csv` — `headerOnly: true`, `relevant: false`
- `cocoa_2016_17.csv` — row hit, but not the expected file and not relevant

### Example of success under the frozen relevance rule

A7: `tea area and production in the Nilgiris`

- `tea_2016_17.csv` — `relevant: true`, `fileMatch: true`, `headerOnly: false`

### Advisory failure mode

B1: `how to control stem borer in paddy`

- the top hit is a header-only `RICE_PestPredictionKnowledgeBase.csv` file header
- the row-bearing result is still not advisory guidance
- result: no answer-bearing chunk

## Conclusion

The current retrieval change is a necessary guardrail for malformed chunks, but it does not increase the quality of the original retrieval under the frozen evaluation. The retrieval weakness is primarily a corpus problem: the corpus is not built for advisory retrieval, and the evaluation remains dominated by statistical files and geography rather than agronomic guidance.
