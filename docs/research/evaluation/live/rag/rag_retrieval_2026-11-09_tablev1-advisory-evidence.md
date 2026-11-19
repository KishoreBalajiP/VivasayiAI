# RAG retrieval — 2026-11-09 — tablev1-advisory-evidence

Local index `.rag-local\indexes\table-v1-cap100-advisory-2026-11-09` (table-v1+advisory-v1, 2580 chunks, 167 files), cached query vectors, exact squared-L2 search. Condition: tablev1-advisory-evidence. Commit 587a24e (dirty tree). Rule specSha256 `fbefacaddcc0fb72ffec1a9a53da9efbadf1b60daac955dcd20bf078d5179b55` (matches the pin).

**Corpus composition (chunks):** csv_statistics 534, other 2046.

Relevance is a mechanical, author-defined rule (expected filename pattern + district/crop terms), not human judgement.

| Metric | top-3 (production) | top-5 |
|---|---|---|
| Answerable (n=13): any relevant chunk | 84.6% (11/13) | 84.6% (11/13) |
| Answerable: top-1 relevant | 84.6% (11/13) | 84.6% (11/13) |
| Answerable: chunk precision | 41.0% (16/39) | 27.7% (18/65) |
| Answerable: expected file retrieved at all | 84.6% (11/13) | 84.6% (11/13) |
| Advisory (n=9): answer-bearing chunks | 0.0% (0/27) | 0.0% (0/45) |
| Advisory: chunks merely topical (crop term present) | 92.6% (25/27) | 91.1% (41/45) |
| Answerable: expected-file hits that are header-only chunks (no data rows) | 0.0% (0/16) | 0.0% (0/20) |
| All retrieved chunks from the KML geography file | 0.0% (0/66) | 0.0% (0/110) |
| Sensitivity, row text only: answerable any relevant chunk | 84.6% (11/13) | 84.6% (11/13) |
| Sensitivity, row text only: answerable chunk precision | 41.0% (16/39) | 27.7% (18/65) |
| Sensitivity, row text only: advisory topical chunks | 92.6% (25/27) | 91.1% (41/45) |

Top-1 distance: answerable median 0.772, advisory median 0.7667.
Errors: 0. Full rows (filenames, distances, labels) in `rag_retrieval_2026-11-09_tablev1-advisory-evidence.json`.

Limitations: The corpus is district-level agricultural STATISTICS (CSV/XLS tables) plus a Tamil Nadu KML geography file; it contains no agronomic advisory text, so advisory questions cannot be grounded in it whatever the retriever does. Relevance labels come from an author-written mechanical rule (filename pattern + term match), not human relevance judgements; a chunk can contain the district name and still not hold the requested number (chunking splits tables). Embeddings are English-only (embed-english-v3.0); the Tamil queries are included to show the effect, n=2. ~20 queries; rates have wide uncertainty. Local exact search, not the production HNSW index; the parity check (scripts/live/ragParity.js) shows whether local search reproduces the production baseline.
