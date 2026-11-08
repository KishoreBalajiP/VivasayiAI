# RAG Implementation Plan

## Status

This document is the Stage 2 implementation plan for the IJRSI revision work. It follows the diagnosis in [RAG_ROOT_CAUSE_REPORT.md](./RAG_ROOT_CAUSE_REPORT.md) and is intentionally a planning document only. No production code or manuscript text is changed in this step.

## Goal

Improve retrieval quality and knowledge-base composition so the system can return answer-bearing advisory content instead of header-only, poorly contextualized statistics fragments. The work must preserve the existing APIs, routes, schemas, and unrelated application behavior, and must not claim improved retrieval performance without reproducible evaluation.

## Implementation principles

- Preserve original evaluation outputs and historical datasets.
- Do not overwrite or rewrite prior result artifacts.
- Prefer source-aware, metadata-aware retrieval over raw embedding similarity alone.
- Keep the knowledge base grounded in verifiable agricultural sources and preserve attribution.
- Treat statistical and geographic files as distinct from advisory content.
- Add tests for every behavior change before enabling the new path.
- Keep the fallback behavior safe when evidence is missing.

## Root-cause summary

The root cause is a system-level mismatch between the corpus and the retrieval design:

1. The production knowledge base is dominated by statistical tables and geography rather than advisory text.
2. The legacy chunker split rows within large CSV text blobs, which broke row/file/table associations and generated header-only chunks.
3. Metadata was too weak to support crop/district/season-aware retrieval.
4. Retrieval used a small top-k similarity search with no metadata filtering or reranking.
5. The system’s answer generation assumes useful evidence exists; without an advisory corpus, it cannot produce reliable agronomic answers.

## Proposed implementation plan

### Phase 1: knowledge-base curation and source audit

Objective: separate advisory material from statistics/geographic data and create a source hierarchy that retrieval can reason about.

Actions:
- Inventory the current corpus by document type: advisory, statistics, geography, policy, claims evidence, etc.
- Identify which sources are answer-bearing and which are unsuitable for advisory retrieval.
- For advisory sources, record provenance fields such as source name, URL, document type, publication date, and review status.
- Exclude non-advisory statistics or geography from the advisory retrieval path unless they are explicitly needed as context.
- Retain a separate statistics/geography collection or strict filtering layer, rather than combining all categories into a single vector index.

Planned files:
- rag/ingestHelpers.js
- rag/ingest.js
- config/ragConfig.js
- src/ai/AIConfig.js
- docs/research/evaluation/live/ (new dated evaluation outputs)

#### Decision gates
- Only include agricultural advisory documents that are verifiable and publicly attributable.
- If a trusted advisory corpus cannot be assembled before the revision deadline, document the limitation and keep the retrieval architecture safe, but do not fabricate recommendations or citations.

### Phase 2: chunking and metadata hardening

Objective: ensure every chunk is row-bearing, crop-aware, and source-aware.

Actions:
- Keep the existing safe `table-v1` chunk contract as the default for CSV ingestion.
- Ensure every chunk contains a row, file name, table title, and column metadata, and no chunk is emitted with only headers.
- Preserve row boundaries and district/crop/season context in metadata instead of losing it in a generic text blob.
- Add deterministic chunk IDs and stable metadata fields for retrieval filters.
- Standardize metadata names and types across ingestion and retrieval.
- Reject malformed or empty data rows before indexing.

Planned files:
- rag/ingestHelpers.js
- rag/ingest.js
- tests/rag.chunker.unit.test.js
- config/ragConfig.js (if ingestion options change)

Expected improvements:
- Fewer header-only chunks.
- Better row-to-context alignment.
- Reduced retrieval errors caused by broken row associations.

### Phase 3: retrieval and re-ranking redesign

Objective: replace plain similarity-only retrieval with a metadata-aware retrieval path.

Actions:
- Separate retrieval stages for:
  - advisory-only content
  - statistics/geography context if required
  - policy or claimant-rights evidence when the user asks for a claim-related answer
- Add crop, district, and season metadata filters when available.
- Limit retrieval candidates to sources with matching scope and answer-bearing content.
- Use a small, deterministic top-k with metadata-aware candidate filtering before ranking.
- Rerank only if the reranker is transparent, reproducible, and evaluated under the same fixed query set.
- Keep retrieval conservative: if the system cannot find strong evidence, return a fallback answer instead of hallucinating.

Planned files:
- services/chat.service.js
- src/ai/AIConfig.js
- config/ragConfig.js
- possibly a new retrieval helper module if the current service becomes too monolithic

### Phase 4: prompt context construction and evidence gating

Objective: make the LLM see evidence that is relevant, attributable, and safe.

Actions:
- Pass structured metadata alongside context text to the answer generator.
- Keep the prompt builder source-aware and context-limited.
- Explicitly separate evidence from recommendations.
- Use a fallback response when no answer-bearing evidence is retrieved.
- Prevent advisory answers from using statistical or geographic rows as if they were agronomic guidance.

Planned files:
- services/chat.service.js
- src/ai/PromptBuilder.js
- src/ai/PromptTemplates.js
- src/ai/ResponseCleanup.js

### Phase 5: evaluation and regression safeguards

Objective: verify the fix with reproducible evidence rather than claims.

Actions:
- Preserve the original evaluation files and historical outputs.
- Create a new dated evaluation output path for the revised retrieval run.
- Use the same fixed query suite and the same relevance rule to compare before/after behavior.
- Run unit tests for chunking and metadata quality.
- Run the targeted RAG evaluation for the revised collection.
- Report the outcome honestly: improved retrieval only if the metrics actually improve under the same evaluation setup.

Planned files:
- docs/research/evaluation/live/rag/
- docs/research/evaluation/live/
- tests/rag.chunker.unit.test.js
- scripts/live/lib/ragEvalSpec.js

## Files likely to require modification

This list is the planned implementation surface. No production code changes are made in this pre-implementation planning stage.

- rag/ingestHelpers.js
- rag/ingest.js
- services/chat.service.js
- src/ai/AIConfig.js
- src/ai/PromptBuilder.js
- src/ai/PromptTemplates.js
- config/ragConfig.js
- tests/rag.chunker.unit.test.js
- docs/research/evaluation/live/ (new dated outputs)
- docs/research/knowledge-base/ (if a curated advisory dataset is introduced)

## Test plan

### 1. Targeted unit tests

Run the existing chunker tests and keep them green:
- tests/rag.chunker.unit.test.js

Specific checks to preserve and extend:
- every chunk must contain at least one row;
- header-only chunks are rejected;
- metadata is scalar and stable;
- chunk IDs are deterministic;
- district/crop metadata stays attached to row-bearing chunks;
- chunks do not include unrelated rows in a single context block.

### 2. Retrieval evaluation

Use a fixed evaluation suite and preserve all original outputs as historical evidence. Then run a new dated comparison.

Minimum checks:
- answerable questions with relevant chunk in top 3;
- expected-file hit analysis;
- proportion of header-only hits;
- proportion of advisory chunks that are answer-bearing;
- source attribution and metadata match quality.

### 3. Regression checks

- Ensure chat routes still work without new API changes.
- Ensure the ingestion flow still accepts the same configuration keys and defaults.
- Ensure non-RAG flows remain unaffected.

### 4. Safety checks

- Verify a missing-evidence fallback keeps answers conservative.
- Verify no fabricated advisory claims are inserted into the corpus.
- Verify source metadata is retained with retrieved content.

## Risks and limitations

1. Advisory corpus availability may be limited.
   - The repository currently lacks a substantial, answer-bearing agronomic advisory corpus.
   - If trusted sources cannot be assembled in time, the retrieval architecture must improve, but the corpus limit remains a real scientific constraint.

2. Retrieval metrics may remain weak if the corpus is dominated by statistics and geography.
   - A better chunker and metadata schema help materially, but they cannot compensate for a weak corpus.

3. English/Tamil query mismatch may remain.
   - The current embedding stack and retrieval logic may not align well with Tamil-language farmer queries.

4. Reranking may not be justified before the deadline.
   - A reranker may be useful, but a meaningful evaluation is required before claiming improvement.

5. Source quality is a real scientific constraint.
   - The system should never invent local agronomic rules or use unverified government or extension advice without provenance.

## Proposed execution order

1. Audit the current advisory corpus and classify sources.
2. Harden chunking and metadata in the ingestion path.
3. Add tests for chunk correctness and metadata integrity.
4. Implement metadata-aware filtering in the retrieval path.
5. Keep the answer-generation fallback conservative.
6. Run the original + revised evaluation under the same fixed query set.
7. Only then claim improved retrieval quality.

## Final decision gate

Proceed to implementation only after the source inventory and retrieval design are reviewed, and only if the planned changes remain scoped to the RAG and knowledge-base revision without modifying unrelated app behavior or the manuscript text.
