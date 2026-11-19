# RAG retrieval comparison — 2026-11-08 current filter pass

This timestamped report was generated without altering the original 2026-10-16 baseline JSON or the frozen evaluation spec.

## Source baseline

- `docs/research/evaluation/live/rag_retrieval_2026-10-16.json`
- original question set and denominators preserved
- current `performRAG` filtering applied only to the retrieved hits, not to the original evaluation files

## Current filter-adjusted summary

| Metric | Original baseline | Current filter pass |
|---|---:|---:|
| Answerable any relevant in top-3 | 15.4% (2/13) | 15.4% (2/13) |
| Answerable top-1 relevant | 7.7% (1/13) | 7.7% (1/13) |
| Answerable expected-file retrieval in top-3 | 76.9% (10/13) | 30.8% (4/13) |
| Advisory answer-bearing chunks | 0.0% (0/27) | 0.0% (0/27) |
| Advisory topical chunks | 33.3% (9/27) | 4.5% (1/22) |

## Evidence extracted from actual retrieved chunks

- A1: header-only expected file, no valid row-bearing evidence, no relevance
- A7: successful answerable retrieval on `tea_2016_17.csv`
- A12: success under the mechanical file-term rule, but the top hit is still a header chunk
- B1/B3: advisory queries are matched to weather or production headers, not agronomic advice

## Result

The current filter improves safety but does not improve measurable retrieval relevance under the original evaluation. The remaining limitation is structural: the corpus lacks answer-bearing advisory knowledge, so retrieval quality is still bounded by the underlying data mix and not by the retriever alone.
