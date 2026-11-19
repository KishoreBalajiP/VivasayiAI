# RAG retrieval revision: reviewer compliance report (2026-11-09)

**Purpose:** evidence for the IJRSI revision. Every number below comes from a write-once file in `docs/research/evaluation/live/rag/`. No human relevance judgement has been collected yet, so no human-relevance result exists.

Reviewer comment: "The retrieval is poor, only 2/13 answers were answered with a relevant chunk in the top 3, and many of the chunks in the expected file were found, but contained only headers."

## 1. Status of each reviewer requirement

| Requirement | Status | Evidence |
|---|---|---|
| Assess retrieval using human relevance judgements | **Human validation pending**: workflow implemented and tested, no labels collected | `docs/research/evaluation/human_relevance/ASSESSOR_INSTRUCTIONS.md`, `scripts/live/ragHumanEval.js`, RE-12..14. Blinded pool of 383 items in `.rag-local/human-eval/pool-2026-11-09/` |
| Establish and report a clear baseline | **Implemented and tested**, with the parity caveat in section 3 | `rag_retrieval_2026-10-16.json` unchanged (LF sha256 `7572a51b...`, matches `FROZEN_HASHES.json`) |
| Enrich the knowledge base with answer-bearing advice | **Implemented in a local research index only; externally blocked for production** by the need for TNAU permission | 2,046 advisory chunks from 110 TNAU pages/documents; `corpus/advisory_corpus_advisory-2026-11-09.manifest.json` |
| Eliminate header-only chunks | **Implemented and tested** | RC-1, RC-9; 0 header-only hits in the candidate runs |
| Row-level provenance and metadata | **Implemented and tested** | `row_numbers`, `evidence_type`; RE-8, RE-9 |
| Metadata-aware filtering and evidence-aware reranking | **Implemented and tested**; off by default | `rag/retrieve.js`, `RAG_RETRIEVAL_MODE=evidence`; RE-1..7, PL-13 |
| Production deployment and production evaluation | **Incomplete**, needs an owner decision | Production Chroma was only read. Chat still uses the old collection |
| Revised manuscript text | **Incomplete**: draft text in section 6; `.docx` unchanged | |

## 2. Root cause

1. The legacy chunker separated each table's header from its rows. In the baseline, 9 of the 11 expected-file hits in the top 3 were header-only.
2. The corpus held statistics and geography only, so advisory questions could not be grounded.
3. Retrieval was plain top-3 similarity, with no use of district, crop or evidence type.

## 3. Experiments

All runs used the 22 frozen queries, the cached Cohere `embed-english-v3.0` query vectors from 2026-10-16 (sha256 `b5118c90...`), exact local squared-L2 search, and the pinned rule (specSha256 `fbefacad...`). Each condition was run once. The reranker's weights were fixed before the first run and were not tuned afterwards.

**Mechanical labels only.** A chunk counts as relevant if its file matches the expected-file pattern and its text contains the required terms. This is the original author-defined rule, not a human judgement. It covers the 13 answerable queries only.

| Condition | Index | Top-1 | Top-3 | Top-5 | P@3 | P@5 | R@3 | R@5 | MRR |
|---|---|---|---|---|---|---|---|---|---|
| Frozen baseline (2026-10-16) | production, 450 chunks | 1/13 | 2/13 | 2/13 | 0.051 | 0.062 | n/a | n/a | 0.103 |
| Snapshot replay, dense | production snapshot, 450 | 1/13 | 2/13 | 2/13 | 0.051 | 0.062 | 0.052 | 0.066 | 0.103 |
| Snapshot, evidence rerank | same | 10/13 | 11/13 | 11/13 | 0.436 | 0.308 | 0.763 | 0.823 | 0.808 |
| table-v1, dense | 534 chunks | 8/13 | 10/13 | 10/13 | 0.359 | 0.246 | 0.735 | 0.741 | 0.692 |
| table-v1 + advisory, dense | 2,580 chunks | 7/13 | 10/13 | 10/13 | 0.359 | 0.246 | 0.735 | 0.741 | 0.641 |
| table-v1 + advisory, evidence rerank | 2,580 chunks | 11/13 | 11/13 | 11/13 | 0.410 | 0.277 | 0.826 | 0.832 | 0.846 |

Recall's denominator is every chunk in that index that the mechanical rule marks relevant, so it differs between indexes. The frozen run stored only snippets, so its recall is not computable.

Paired exact McNemar on hit@3 against the frozen baseline (n=13, underpowered): evidence rerank on the snapshot b=9, c=0, p=0.0039; table-v1 dense b=8, c=0, p=0.0078; table-v1 + advisory + evidence b=9, c=0, p=0.0039.

Files: `RAG_METRICS_2026-11-09.{json,md}` and `rag_retrieval_2026-11-09_*.json`, which include the full retrieved text. Index manifests are in `manifests/`.

**Parity with the frozen baseline: strict FAIL.** `rag_parity_2026-11-09_prod-snapshot.json` reports 7 differences, all distances, the largest 0.0022 against a tolerance of 0.001. There are no filename, rank, label or snippet differences. The tolerance was not changed. The dense replay reproduces the baseline's metrics exactly.

**Advisory queries (n=9): no metric is reported.** The frozen `answerBearingChunks` field is a hard-coded zero from when no advisory text existed, so it is not a measurement. Inspection of top-3 file names shows that retrieval now reaches TNAU advisory pages, and gives no evidence that they answer the question. Known weak cases: B9 (Tamil) lands on unrelated crops, B1 retrieves general paddy pages rather than a stem-borer page, and B5's third evidence-rerank hit is a coconut page.

## 4. Limitations

- **Circularity of the rerank result.** The reranker boosts district and crop matches, and the mechanical rule checks district terms. The gain from 2/13 to 11/13 under reranking is partly built into that alignment. Human labels are required to confirm it.
- **Development on the test set.** The query patterns and advisory crop seeds were written knowing the 22 queries. A new held-out query set written by the authors is advisable.
- **Row cap.** The candidate indexes keep the baseline's 100-row-per-file cap, for comparable coverage and because of the Cohere trial rate limit. An uncapped table-v1 corpus has 11,567 chunks and was not evaluated, so deep rows of the yield-data file are not covered.
- **Corpus differences.** Candidates use the 57 CSVs and drop the KML file and the two XLS exports. Part of the change comes from that.
- **Corpus gaps.** Crawl limits left many individual pest pages out: "stem borer" appears in only 5 chunks. Three URLs returned 404 (`expert_system/paddy/climate.html`, `agriculture/CropProduction/Oilseeds/oilseeds_groundnut.html`, `agriculture/crop_prot.html`), and three pages produced no usable text. ICAR, KVK and state department documents were not acquired.
- **Source content.** Some TNAU pages are old and carry an information-only disclaimer. Correctness of the advice has not been reviewed by an agronomist.
- **Language.** The embedding model is English-only, and 2 of the 22 queries are Tamil.
- **Scope of the claim.** This measures retrieval quality, not the quality of generated answers. Local exact search is not the production HNSW index.
- **Copyright.** TNAU pages are marked "All Rights Reserved" and no open licence was found. Raw text, indexes and the assessor packet stay in the gitignored `.rag-local/`. Permission is needed before production use or redistribution.

## 5. Tests (Windows, Node 22.14, 2026-11-09)

- `npx vitest run` on the 8 focused RAG/chat/integrity files: **108 passed, 0 failed**.
- `npx vitest run` on the full suite: **1,124 passed, 5 failed; 74 files passed, 8 failed**. MongoMemoryServer needed `MONGOMS_DOWNLOAD_DIR` pointed at a fresh binary because the cached one failed its MD5 check.

Remaining failures, none in files changed by this work:

| Test | Observed cause |
|---|---|
| HX-6, MK-3b, WK-8 | POSIX assumptions: file mode 0600 and graceful SIGTERM do not hold on Windows |
| DS-5b | Child process printed nothing instead of `stored`; not diagnosed further |
| RA-4 | The retrieval paragraph differs between `main.tex` and `main-access.tex` |
| 4 suites: `e2eHarness.unit`, both `migration.*`, `verificationWorker.loop` | SyntaxError on importing `scripts/worker.js` or `hermeticBackend.js` under vitest. `node --check scripts/worker.js` passes; a shebang transform issue is suspected, unconfirmed |

An attempt to run these on a clean checkout of HEAD produced no output, so it is not confirmed that all of them predate this work.

Defects repaired from the earlier 8 failures: frozen-spec and fixture checks broke under CRLF checkouts (the verifier now normalises CRLF only, and RS-4 proves a content change still fails), and a Windows symlink privilege error in a test. Commit 6dbe6b8 is present in this repository, so the git-history check runs and passes.

## 6. Draft text for the paper (fill in human results when available)

> The original evaluation reported that 2 of 13 answerable queries had a relevant chunk in the top 3, under a mechanical rule combining an expected file pattern with required district or crop terms. Most expected-file hits were header-only chunks produced by the original chunker. We preserved those results unchanged and replayed the same 22 queries with identical cached query vectors on a read-only snapshot of the deployed collection. The replay reproduced the baseline's metrics and rankings; seven retrieved-chunk distances differed by at most 0.0022, exceeding our pre-set tolerance of 0.001.
>
> We introduced row-preserving table chunking with row-level provenance, a separately labelled advisory corpus of 2,046 chunks from Tamil Nadu Agricultural University sources, and a deterministic retrieval step that separates advisory from statistical evidence and reranks candidates using exact district and crop matches. Under the same mechanical rule, top-3 retrieval rose from 2/13 to 11/13 and MRR from 0.103 to 0.846 for the combined system. Because the reranker uses signals related to this rule, and because the system was developed against these queries, these figures are not an estimate of human-judged relevance. The sample is small (n = 13). Human relevance assessment by independent assessors [PENDING: agreement, top-k, Precision@k, pooled Recall@k, MRR]. The advisory corpus and reranker have not been deployed to production, and we do not evaluate generated answer quality.

## 7. Changed files

Code: `rag/ingestHelpers.js`, `rag/ingest.js`, `rag/localIndex.js`, `services/chat.service.js`, `scripts/live/ragRetrieval.live.js`, `scripts/live/verifyRagSpec.js`, `scripts/eval/checkManuscriptNumbers.js`, `.gitattributes`.
New: `rag/retrieve.js`, `rag/advisorySources.js`, `rag/buildAdvisoryIndex.js`, `scripts/rag/acquireAdvisory.js`, `scripts/live/ragMetrics.js`, `scripts/live/ragHumanEval.js`, `scripts/live/lib/ragHumanEval.js`, `tests/rag.retrieve.unit.test.js`.
Tests updated: `tests/rag.chunker.unit.test.js`, `tests/ragEvalSpec.unit.test.js`, `tests/researchIntegrity.unit.test.js`, `tests/chat.pipeline.test.js`.
Nothing was committed, and the frozen baseline and production collection were not changed.
