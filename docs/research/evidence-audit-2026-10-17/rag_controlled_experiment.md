# Controlled RAG experiment plan

The existing production corpus and question set remain frozen. No production collection is modified.

## Baseline

Use the legacy chunker and a locally rebuilt baseline index. First require byte/hash parity with the pinned baseline; the current parity checks fail, so this is the immediate blocker.

## Improved condition

Use the already implemented `table-v1` chunker in an isolated local index. Each chunk must retain file/table/column context and at least one data row. Do not tune the query set or relevance labels.

## Evaluation

Run the same 22 queries and labels, report answerable retrieval Recall@3, Precision@3, expected-file rate, header-only rate, advisory answer-bearing rate, MRR/nDCG only where labels support them, and latency only from actual measurements. Compare baseline and improved conditions on identical query vectors and corpus snapshots. Record index manifests, hashes, commands, Node version, and exclusions.

## Current status

Not run. The 2026-10-17 status record says the owner stopped the evaluation after both baseline parity checks failed; the diagnostic showed local ranking reproduces the snapshot's Chroma ranking, so the frozen baseline itself could not be reproduced. No improvement claim is made.
