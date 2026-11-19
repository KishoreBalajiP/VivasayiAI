# RAG retrieval — 2026-11-09 — prod-snapshot-evidence

Local index `.rag-local\indexes\prod-snapshot-2026-11-09` (legacy-e9b779d (as ingested in production), 450 chunks, 60 files), cached query vectors, exact squared-L2 search. Condition: prod-snapshot-evidence. Commit 587a24e (dirty tree). Rule specSha256 `fbefacaddcc0fb72ffec1a9a53da9efbadf1b60daac955dcd20bf078d5179b55` (matches the pin).

**Corpus composition (chunks):** csv_statistics 196, xls_html_table 17, kml_geography 237.

Relevance is a mechanical, author-defined rule (expected filename pattern + district/crop terms), not human judgement.

| Metric | top-3 (production) | top-5 |
|---|---|---|
| Answerable (n=13): any relevant chunk | 84.6% (11/13) | 84.6% (11/13) |
| Answerable: top-1 relevant | 76.9% (10/13) | 76.9% (10/13) |
| Answerable: chunk precision | 43.6% (17/39) | 30.8% (20/65) |
| Answerable: expected file retrieved at all | 84.6% (11/13) | 84.6% (11/13) |
| Advisory (n=9): answer-bearing chunks | n/a | n/a |
| Advisory: chunks merely topical (crop term present) | n/a | n/a |
| Answerable: expected-file hits that are header-only chunks (no data rows) | 0.0% (0/17) | 0.0% (0/20) |
| All retrieved chunks from the KML geography file | 0.0% (0/39) | 0.0% (0/65) |
| Sensitivity, row text only: answerable any relevant chunk | 84.6% (11/13) | 84.6% (11/13) |
| Sensitivity, row text only: answerable chunk precision | 43.6% (17/39) | 30.8% (20/65) |
| Sensitivity, row text only: advisory topical chunks | n/a | n/a |

Top-1 distance: answerable median 1.2529, advisory median null.
Errors: 0. Full rows (filenames, distances, labels) in `rag_retrieval_2026-11-09_prod-snapshot-evidence.json`.

Limitations: The corpus is district-level agricultural STATISTICS (CSV/XLS tables) plus a Tamil Nadu KML geography file; it contains no agronomic advisory text, so advisory questions cannot be grounded in it whatever the retriever does. Relevance labels come from an author-written mechanical rule (filename pattern + term match), not human relevance judgements; a chunk can contain the district name and still not hold the requested number (chunking splits tables). Embeddings are English-only (embed-english-v3.0); the Tamil queries are included to show the effect, n=2. ~20 queries; rates have wide uncertainty. Local exact search, not the production HNSW index; the parity check (scripts/live/ragParity.js) shows whether local search reproduces the production baseline.
