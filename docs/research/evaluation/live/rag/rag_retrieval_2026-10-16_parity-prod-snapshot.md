# RAG retrieval — 2026-10-16 — parity-prod-snapshot

Local index `.rag-local/indexes/prod-snapshot-2026-10-16` (legacy-e9b779d (as ingested in production), 450 chunks, 60 files), cached query vectors, exact squared-L2 search. Condition: parity-prod-snapshot. Commit 6dbe6b8 (dirty tree). Rule specSha256 `fbefacaddcc0fb72ffec1a9a53da9efbadf1b60daac955dcd20bf078d5179b55` (matches the pin).

**Corpus composition (chunks):** csv_statistics 196, xls_html_table 17, kml_geography 237.

Relevance is a mechanical, author-defined rule (expected filename pattern + district/crop terms), not human judgement.

| Metric | top-3 (production) | top-5 |
|---|---|---|
| Answerable (n=13): any relevant chunk | 15.4% (2/13) | 15.4% (2/13) |
| Answerable: top-1 relevant | 7.7% (1/13) | 7.7% (1/13) |
| Answerable: chunk precision | 5.1% (2/39) | 6.2% (4/65) |
| Answerable: expected file retrieved at all | 76.9% (10/13) | 84.6% (11/13) |
| Advisory (n=9): answer-bearing chunks | 0.0% (0/27) | 0.0% (0/45) |
| Advisory: chunks merely topical (crop term present) | 33.3% (9/27) | 24.4% (11/45) |
| Answerable: expected-file hits that are header-only chunks (no data rows) | 81.8% (9/11) | 68.8% (11/16) |
| All retrieved chunks from the KML geography file | 0.0% (0/66) | 1.8% (2/110) |
| Sensitivity, row text only: answerable any relevant chunk | 15.4% (2/13) | 15.4% (2/13) |
| Sensitivity, row text only: answerable chunk precision | 5.1% (2/39) | 6.2% (4/65) |
| Sensitivity, row text only: advisory topical chunks | 18.5% (5/27) | 15.6% (7/45) |

Top-1 distance: answerable median 1.0305, advisory median 1.3406.
Errors: 0. Full rows (filenames, distances, labels) in `rag_retrieval_2026-10-16_parity-prod-snapshot.json`.

Limitations: The corpus is district-level agricultural STATISTICS (CSV/XLS tables) plus a Tamil Nadu KML geography file; it contains no agronomic advisory text, so advisory questions cannot be grounded in it whatever the retriever does. Relevance labels come from an author-written mechanical rule (filename pattern + term match), not human relevance judgements; a chunk can contain the district name and still not hold the requested number (chunking splits tables). Embeddings are English-only (embed-english-v3.0); the Tamil queries are included to show the effect, n=2. ~20 queries; rates have wide uncertainty. Local exact search, not the production HNSW index; the parity check (scripts/live/ragParity.js) shows whether local search reproduces the production baseline.
