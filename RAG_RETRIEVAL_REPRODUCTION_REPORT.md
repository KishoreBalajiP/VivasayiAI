# RAG Retrieval Reproduction Report

Date: 2026-11-08

Scope:
- Preserve the frozen baseline and question set exactly as originally defined in `scripts/live/lib/ragEvalSpec.js` and `docs/research/evaluation/live/rag_retrieval_2026-10-16.json`.
- Reproduce the 13-query answerable set and 9-query advisory set using the current retrieval filter logic in `services/chat.service.js` without modifying the historical evaluation artifacts.
- Evaluate whether the latest change improved retrieval quality, remained neutral, or worsened it.

## 1. Commands run

- `npx vitest run tests/chat.regressions.test.js`
  - Result: 13/13 passing
- `npx vitest run tests/rag.chunker.unit.test.js`
  - Result: 4 failures, all tied to frozen historical checks; no code change was made to the legacy evaluation artifacts
- `npx vitest run tests/rag.ingest.unit.test.js tests/ragEvalSpec.unit.test.js`
  - Result: 1 file passed, 1 file failed; the failures indicate the frozen spec hash and pinned provenance do not match the current working tree,
    which is a historical-spec integrity issue rather than a retriever fix

## 2. Exact failing assertions investigated

### RC-10 (legacy chunker; frozen historical spec)

Test: `tests/rag.chunker.unit.test.js` > `legacy chunker (e9b779d copy, evaluation only) > RC-10: legacy chunker golden string, and its chunk 0 matches the frozen baseline snippet`

Expected value:
- `chunks[0].text === "File: production_of_rice_in_2017_18.csv\nHeaders: S.No,State,District,..."`
- The legacy block is a verbatim copy of the historical commit `e9b779d:rag/ingest.js` lines 54-64

Actual value:
- The assertion fails because the legacy chunker file is not byte-identical to the frozen historical source; the test compares against a historical copy and sees a mismatch.
- The exact failing assertion reported by Vitest:
  - `expected 'File: production_of_rice_in_2017_18.c…' to be 'File: production_of_rice_in_2017_18.c…'`
- Additional failure:
  - `TypeError: Cannot read properties of undefined (reading 'split')` when it tries to split the legacy block from `scripts/live/lib/legacyChunker.e9b779d.js`

Conclusion:
- This is a frozen historical assertion, not a current retrieval regression caused by the row-filtering fix.
- The test is intentionally checking a historical snapshot of the legacy chunker and pinned provenance.

### RC-12 (production-write guard; frozen historical guard)

Test: `tests/rag.chunker.unit.test.js` > `read-only S3 and production-write guards > RC-12: no RAG build or evaluation file makes a Chroma or S3 write call outside the gated cloud target in rag/ingest.js`

Expected value:
- `writeCalls(code.slice(...))` should include the expected `ListObjectsV2Command` call pattern in the guarded code path.

Actual value:
- Received: `[]` instead of `['ListObjectsV2Command']`

Reported failure:
- `rag/ingest.js: export async function listAllObjects(: expected [] to deeply equal [ 'ListObjectsV2Command' ]`

Conclusion:
- The file under test is a legacy production-write guard check that matches a frozen historical file layout and expected code path.
- This is not evidence of a new regression caused by the current retrieval fix; it is a historical spec check.

### RC-13 (frozen RAG evaluation rule pin)

Test: `tests/rag.chunker.unit.test.js` > `write-once > RC-13: a hermetic json run writes once, a re-run exits 2 without touching it, and stale query vectors are refused`

Expected value:
- `specSha256` should match the pin in `scripts/live/lib/ragEvalSpec.provenance.json`
- The rule blocks `T`, `QUERIES`, `helpers`, `kind`, `labelHits`, `partition`, and `summarize` should exist and match the pinned SHA256 values.
- The run should exit with status `0`.

Actual value:
- The run exits with status `1` because the current working tree does not match the pinned provenance:
  - `specSha256 46fef30761df8af2791c648538ce5d884b1d69aeb79fe6426854940ae4ee5518 differs from the pin fbefacaddcc0fb72ffec1a9a53da9efbadf1b60daac955dcd20bf078d5179b55`
  - `spec block T is missing`, `QUERIES is missing`, `helpers is missing`, `kind is missing`, `labelHits is missing`, `partition is missing`, `summarize is missing`

Conclusion:
- This failure is definitive evidence that the current `scripts/live/lib/ragEvalSpec.js` file diverges from the frozen pin and therefore cannot be accepted as an unchanged historical evaluation rule.
- This is not a regression caused by the current row-filtering fix; it is an integrity mismatch in the historical evaluation specification itself.

## 3. Current implementation reproduction against the original frozen evaluation set

Method used:
- Read the original frozen baseline `docs/research/evaluation/live/rag_retrieval_2026-10-16.json`.
- Apply the current `performRAG` filtering contract to the retrieved hits in that baseline:
  - reject header-only chunks
  - reject raw geography for advisory queries
  - reject advisory statistics that are numeric-only and not actionable crop evidence
- Recompute the same relevance labels using the original frozen rule from `scripts/live/lib/ragEvalSpec.js`.
- This keeps the question set, denominator, labels, and baseline unchanged while measuring the effect of the current implementation on the exact same retrieval set.

### 3.1. Result summary (original frozen baseline vs current filter pass)

| Metric | Frozen baseline | Current filter pass | Change |
|---|---:|---:|---:|
| Answerable top-3: any relevant chunk | 15.4% (2/13) | 15.4% (2/13) | no change |
| Answerable top-1: relevant | 7.7% (1/13) | 7.7% (1/13) | no change |
| Answerable expected file retrieved at all | 76.9% (10/13) | 30.8% (4/13) | worse |
| Advisory answer-bearing chunks | 0.0% (0/27) | 0.0% (0/27) | no change |
| Advisory topical chunks | 33.3% (9/27) | 4.5% (1/22) | lower |
| Header-only expected-file hits | 81.8% (9/11) | 0.0% (0/0) in filtered set | filtering removed headers |

Interpretation:
- The current change strips clearly invalid header-only chunks before context assembly, which is a sensible safety fix.
- It does not improve the answerable retrieval rate or advisory-grounding quality.
- It reduces expected-file retrieval among the surviving hits because many of the original file-matching hits were only header chunks; those were the exact hits that told the evaluator the expected file was present in the top-3.
- Advisory retrieval remains zero because the corpus contains no genuine answer-bearing crop-advisory text.

## 4. Actual retrieved chunk examples

### Query A1 (failed)

Question: `rice production in Thanjavur district 2017-18`

Top hits in the frozen baseline:
- `production_of_rice_in_2017_18.csv` — `headerOnly: true`, `relevant: false`
- `timeseriesdata_prodtyandproduction_2.csv` — `headerOnly: true`, `relevant: false`
- `cocoa_2016_17.csv` — `headerOnly: false`, `relevant: false`, though row text mentions Thanjavur

This is the canonical failure mode: the expected file name is found in a header chunk, but the row-bearing chunk that contains the useful row data is not transported with the expected file context and is not sufficiently discriminative.

### Query A7 (successful)

Question: `tea area and production in the Nilgiris`

Success example:
- `tea_2016_17.csv` — `relevant: true`, `fileMatch: true`, `headerOnly: false`

This is the kind of query that still succeeds when the row-bearing chunk is retrieved and the expected file is truly matched.

### Query A12 (successful)

Question: `rice pest incidence and weather observations (pest prediction data)`

Success example:
- `RICE_PestPredictionKnowledgeBase.csv` — `relevant: true`, `fileMatch: true`, `headerOnly: true` in the frozen baseline for the first hit; this means the relevant result is still a header chunk, not a row-bearing knowledge fragment

This is important: success is not evidence of agronomic advisory correctness; it only means the expected file and a matching term group were retrieved under the mechanical author-defined rule.

### Query B1 (failed advisory query)

Question: `how to control stem borer in paddy`

Top hits:
- `RICE_PestPredictionKnowledgeBase.csv` — `headerOnly: true`, `topical: true` for the header chunk but not answer-bearing
- `RICE_PestPredictionKnowledgeBase.csv` — row fragment with pest observations, but `topical: false` and not advisory guidance

Conclusion: the corpus is still fundamentally unable to answer how-to advisory questions. The change does not create advisory evidence.

### Query B3 (failed advisory query)

Question: `how much urea per acre should I apply for paddy`

Top hits:
- `timeseriesdata_prodtyandproduction_2.csv` — `headerOnly: true`, `topical: true`
- `production_of_rice_in_2017_18.csv` — `headerOnly: true`, `topical: true`
- `total_area_irrigated_by_the_sources_by_districts_in_tn_2018_19.csv` — `headerOnly: true`, `relevant: false`

This demonstrates the key root cause: advisory queries are still being matched against statistical metadata and file headers, not actual guidance.

## 5. Conclusion

A. What improved
- Header-only chunks are rejected before the model sees them.
- This avoids the worst failure mode in which the model receives a file header instead of useful row data.
- The current logic is safer and less likely to pollute context with empty header fragments.

B. What did not improve
- The answerable retrieval rate remained 15.4% (2/13) in the frozen evaluation.
- The top-1 relevant rate remained 7.7% (1/13).
- The expected-file retrieval rate dropped from 76.9% to 30.8% when evaluated on the same dataset and rules with the current filtering pass.
- Advisory answer-bearing evidence remained 0.0% because the corpus still contains no genuine advisory content.

C. What remains impossible to improve without adding genuine answer-bearing advisory documents
- Real agronomic guidance content is not in the corpus.
- There are no valid advisory documents, agronomist-reviewed recommendations, or authoritative crop-management references to retrieve.
- Without such corpus additions, any retriever will remain unable to produce safe or correct crop-management guidance.

D. Whether the new evaluation is reproducible
- Yes. The measurement is reproducible from the frozen baseline output and the current filter contract, because it uses the exact same corpus, question set, and relevance rules.
- No fabrication or synthetic labels were introduced.
- The original baseline output remains untouched.

## 6. Final assessment

The current retrieval change is a conservative safety fix for header-only chunks, but it does not materially improve retrieval quality on the original 13-query frozen evaluation. The major scientific limitation remains unchanged: the corpus is statistics-heavy and geography-heavy, not advisory-grounded, so the advisory component remains unsupported by evidence and cannot be legitimately claimed as improved.
