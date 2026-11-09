# RAG retrieval — 2026-11-09 — tablev1-cap100-dense

Local index `.rag-local\indexes\table-v1-cap100-2026-11-09` (table-v1, 534 chunks, 57 files), cached query vectors, exact squared-L2 search. Condition: tablev1-cap100-dense. Commit 587a24e (dirty tree). Rule specSha256 `fbefacaddcc0fb72ffec1a9a53da9efbadf1b60daac955dcd20bf078d5179b55` (matches the pin).

**Corpus composition (chunks):** csv_statistics 534.

Relevance is a mechanical, author-defined rule (expected filename pattern + district/crop terms), not human judgement.

| Metric | top-3 (production) | top-5 |
|---|---|---|
| Answerable (n=13): any relevant chunk | 76.9% (10/13) | 76.9% (10/13) |
| Answerable: top-1 relevant | 61.5% (8/13) | 61.5% (8/13) |
| Answerable: chunk precision | 35.9% (14/39) | 24.6% (16/65) |
| Answerable: expected file retrieved at all | 84.6% (11/13) | 84.6% (11/13) |
| Advisory (n=9): answer-bearing chunks | 0.0% (0/27) | 0.0% (0/45) |
| Advisory: chunks merely topical (crop term present) | 40.7% (11/27) | 42.2% (19/45) |
| Answerable: expected-file hits that are header-only chunks (no data rows) | 0.0% (0/32) | 0.0% (0/52) |
| All retrieved chunks from the KML geography file | 0.0% (0/66) | 0.0% (0/110) |
| Sensitivity, row text only: answerable any relevant chunk | 76.9% (10/13) | 76.9% (10/13) |
| Sensitivity, row text only: answerable chunk precision | 35.9% (14/39) | 24.6% (16/65) |
| Sensitivity, row text only: advisory topical chunks | 29.6% (8/27) | 31.1% (14/45) |

Top-1 distance: answerable median 0.7477, advisory median 1.3215.
Errors: 0. Full rows (filenames, distances, labels) in `rag_retrieval_2026-11-09_tablev1-cap100-dense.json`.

Limitations: The corpus is district-level agricultural STATISTICS (CSV/XLS tables) plus a Tamil Nadu KML geography file; it contains no agronomic advisory text, so advisory questions cannot be grounded in it whatever the retriever does. Relevance labels come from an author-written mechanical rule (filename pattern + term match), not human relevance judgements; a chunk can contain the district name and still not hold the requested number (chunking splits tables). Embeddings are English-only (embed-english-v3.0); the Tamil queries are included to show the effect, n=2. ~20 queries; rates have wide uncertainty. Local exact search, not the production HNSW index; the parity check (scripts/live/ragParity.js) shows whether local search reproduces the production baseline.
