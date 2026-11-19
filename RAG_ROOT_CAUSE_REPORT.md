# RAG Root-Cause Report

## Scope and status

This report documents the technical causes of the RAG weakness identified in the IJRSI review without modifying production code or manuscript text. It is a diagnosis-only step and is intended to support the next approval gate before implementation changes begin.

The review evidence is already in the repository:

- [docs/research/evaluation/live/rag_retrieval_2026-10-16.md](docs/research/evaluation/live/rag_retrieval_2026-10-16.md) reports that the production collection had 450 chunks from 60 files, with the following composition: 196 CSV statistics chunks, 17 XLS/HTML-table chunks, and 237 KML geography chunks.
- That same report states: “The corpus is statistical tables and a geography file, not advisory text.”
- [scripts/live/lib/ragEvalSpec.js](scripts/live/lib/ragEvalSpec.js) defines the opaque mechanical relevance rule used for evaluation (expected file + terms), and it is the basis for the key metrics.
- [scripts/live/lib/legacyChunker.e9b779d.js](scripts/live/lib/legacyChunker.e9b779d.js) reproduces the original ingestion/chunking format used to build the production collection.
- [rag/ingestHelpers.js](rag/ingestHelpers.js) and [tests/rag.chunker.unit.test.js](tests/rag.chunker.unit.test.js) already show the corrected chunking expectations: every chunk must contain data rows, and header-only chunks are explicitly rejected.

## Executive summary

The repository shows that the main failure is not a single bug in the retriever alone; it is a combination of four structural issues:

1. The knowledge base is dominated by district-level statistics and geographic files, not advisory text.
2. The historical ingestion pipeline used a generic `RecursiveCharacterTextSplitter` over a large table text blob, which destroyed the association between rows, file identity, district, crop, and table meaning.
3. The legacy metadata was too weak to support retrieval relevance checks and ranking: many chunks were effectively “header-only” or “row fragments without file/crop context.”
4. The production retrieval step is a plain vector similarity query with a small top-k, and it does not re-rank or filter by domain metadata (crop/district/season/source type).

These issues explain why the observed metrics were poor:

- only 2/13 answerable questions retrieved a relevant chunk in the top three;
- expected-file hits were common (10/13), but many of those hits were header-only or lacked the needed row content;
- 0/27 advisory chunks were answer-bearing because the corpus contained no usable advisory text to retrieve.

## 1. End-to-end inspection of the retrieval pipeline

### 1.1 Document ingestion

The ingestion script is in [rag/ingest.js](rag/ingest.js). It:

- lists all keys in the S3 bucket;
- filters them through `shouldIngestKey()` in [rag/ingestHelpers.js](rag/ingestHelpers.js);
- accepts only CSVs and rejects farmer uploads, claim data, and non-agricultural files;
- reads each object and computes a chunk list.

The intended design is safe: it prevents upload or claim data from contaminating the knowledge base. That is important, but it also means the corpus is highly constrained by what is ingested.

The important point is that the ingestion path is not domain-aware beyond “CSVs that match the allowed naming rules.” It does not prioritize advisory-quality documents or answer-bearing documents over descriptive statistics tables.

### 1.2 Text extraction and parsing

The ingestion uses `parseCsv()` in [rag/ingestHelpers.js](rag/ingestHelpers.js), which is a proper RFC-4180-style CSV parser that handles quoted fields and embedded commas/newlines. This is a strength. It avoids the earlier bug where the parser split on raw line breaks and broke embedded commas or quotes.

The problem is not CSV parsing itself. The problem is the content type that is being fed into the system: mostly statistical tables rather than explanatory farm guidance.

### 1.3 Chunking and metadata

The legacy production chunker is reproduced in [scripts/live/lib/legacyChunker.e9b779d.js](scripts/live/lib/legacyChunker.e9b779d.js). It does the following:

- converts each CSV into the format:
  - `File: <key>`
  - `Headers: <header row>`
  - `Data:`
  - `Row n: <raw CSV row>`
- then passes the full text blob through `RecursiveCharacterTextSplitter` with:
  - `chunkSize: 1000`
  - `chunkOverlap: 200`
- metadata only includes:
  - `source`
  - `chunk_index`
  - `filename`

This is the core technical reason for the retrieval failure. The chunker splits a table at arbitrary character boundaries rather than preserving row boundaries, table structure, district associations, or crop metadata.

The newer chunker in [rag/ingestHelpers.js](rag/ingestHelpers.js) is explicit about the fix:

- every chunk must begin with `File:`, `Table:`, and `Columns:`;
- every chunk must contain at least one `Row n:` line;
- district/crop values are kept in metadata rather than in the file preamble;
- chunk grouping is by district when relevant.

This newer behavior is already tested in [tests/rag.chunker.unit.test.js](tests/rag.chunker.unit.test.js), which explicitly checks that each chunk contains a row and that chunks do not become header-only artifacts. The repo therefore already documents the root cause and the expected fix.

### 1.4 Metadata quality

The legacy metadata is too weak for robust semantic retrieval. It stores only a filename and chunk index, not:

- district,
- crop,
- season,
- row range,
- file/table title,
- file kind (statistics vs advisory vs geography),
- answer-bearing content type,
- document source class.

This matters because the retrieval run is based on plain embedding similarity. If the correct row is split away from the table heading and the relevant district/crop terms do not survive in the same chunk, the retrieval system cannot reliably rank the correct chunk near the top.

This is exactly what the repo’s retrieval note says: the main failure mode is that the right file is often retrieved by a header chunk, but the data-bearing row is a separate chunk with neither the file name nor the crop context needed for correct association.

### 1.5 Embedding and vector retrieval

The production chat flow in [services/chat.service.js](services/chat.service.js) does the following:

- embeds the user question with Cohere `embed-english-v3.0`;
- queries Chroma with `nResults: AIConfig.ragTopK` (default top-3);
- concatenates the retrieved documents into a single context block;
- sends that block to the model.

This is a retrieval-only system with no metadata filters, no re-ranking, and no domain-aware fallback. It is vulnerable when:

- the relevant data is spread across multiple chunks,
- row content strongly depends on file-level context,
- the corpus contains mostly statistics and not answer-bearing advice,
- the query asks about a crop or district not represented in the same chunk.

The production RAG quality therefore depends almost entirely on corpus composition and chunk design. It does not have a robust fallback when the retrieved chunks are unhelpful.

### 1.6 Context construction and answer generation

The prompt builder in [src/ai/PromptBuilder.js](src/ai/PromptBuilder.js) wraps the retrieved context as data for the LLM. The problem is not in the prompt wrapper itself; it is in the fact that the retrieved context is often poor or irrelevant. When the model receives mostly header fragments or unrelated rows, answer generation cannot recover a reliable response.

The answer layer is not the root cause of low retrieval quality, but it amplifies the issue because the retrieved context is not organized for grounded generation.

## 2. Exact technical reasons for header-only chunks and poor retrieval

The repository already contains the direct evidence for the root causes. The main reasons are as follows.

### Reason 1: the production corpus is not advisory-bearing

From [docs/research/evaluation/live/rag_retrieval_2026-10-16.md](docs/research/evaluation/live/rag_retrieval_2026-10-16.md):

- corpus composition: 196 CSV statistics chunks, 17 XLS/HTML-table chunks, 237 KML geography chunks;
- advisory answer-bearing chunks: 0.0% (0/27);
- the report explicitly says: “The corpus is statistical tables and a geography file, not advisory text.”

This means an advisory question has no valid “ground truth document” in the corpus to retrieve. Retrieval can only fail by design.

### Reason 2: the legacy chunker strips context through arbitrary splitting

[legacyChunker.e9b779d.js](scripts/live/lib/legacyChunker.e9b779d.js) does a generic split of the entire CSV content into 1000-character chunks with 200-character overlap. It does not keep file/table/columns and row structure in a consistent chunk body.

This causes two failure modes:

- header chunks that describe the file but contain no row data;
- row chunks that are detached from the table and crop/district context they depend on.

The result is exactly the pattern reported in the retrieval summary: expected-file hits often contain only a header, and the actual district-bearing row remains in a separate chunk.

### Reason 3: the legacy chunk metadata is insufficient for relevance and filtering

The old metadata includes only `source`, `chunk_index`, and `filename`. There is no `district`, `crop`, `table`, `row_start`, or `row_end` in the production corpus schema. This makes it impossible to cleanly filter or re-rank by domain variables even when the query contains them.

### Reason 4: the retrieval step uses similarity only and a small top-k

[services/chat.service.js](services/chat.service.js) performs a pure embedding query with `nResults: 3`. The system is therefore sensitive to these failure conditions:

- weak semantic match between the query and the relevant row fragment;
- chunk boundary loss;
- missing table-level context;
- no metadata or lexical filtering.

The current setup cannot recover when the correct chunk is “nearby in file but not near in chunk structure.”

### Reason 5: the corpus contains both geographic and statistical files without an advisory layer

The corpus contains KML geography files and statistics tables, but no agronomy guide, extension bulletin, or farmer-safe advice text. This is not a retriever bug; it is a knowledge-base content problem.

### Reason 6: some queries are multilingual; the embedding model is English-only

The evaluation uses `embed-english-v3.0` and the same model is used in production. The repo explicitly notes that the Tamil queries are included to show the effect, and that the current embedding model is English-only. This is a real limitation for Tamil-language retrieval quality.

## 3. Current agricultural knowledge base: suitable versus unsuitable content

### 3.1 Suitable sources for statistical retrieval

The repository includes sample agricultural statistic tables that are appropriate for factual district-level retrieval, such as:

- [tests/fixtures/rag/production_of_rice_in_2017_18.csv](tests/fixtures/rag/production_of_rice_in_2017_18.csv)
- [tests/fixtures/rag/Tamilnadu agriculture yield data.csv](tests/fixtures/rag/Tamilnadu%20agriculture%20yield%20data.csv)
- [tests/fixtures/rag/neem.csv](tests/fixtures/rag/neem.csv)
- [tests/fixtures/rag/pest_observations.csv](tests/fixtures/rag/pest_observations.csv)

These files are domain-appropriate because they contain crop, district, season, and production values. They are useful for retrieval questions like:

- rice production by district;
- crop area and production;
- district-wise crop statistics;
- crop-specific observations on production or pest incidence.

These are suitable for factual retrieval, but not for agronomic “how-to” advice unless they are paired with reliable advisory material.

### 3.2 Unsuitable or weak sources for advisory retrieval

The repository also contains clear examples of documents that are not suitable for advisory retrieval:

- [tests/fixtures/rag/header_only.csv](tests/fixtures/rag/header_only.csv): deliberately a header-only CSV, which the tests verify must yield no chunks. This is a direct example of a useless document for retrieval.
- KML geography files: the production retrieval summary explicitly states that the corpus includes a geography file and that these are not answer-bearing advisory documents.
- XLS or HTML exports: the evaluation summary says there are 17 XLS/HTML-table chunks, which may contain tabular data but are often noisy or not directly suitable for farmer guidance.
- The production corpus is described as agricultural statistics plus a geography file, not a crop-advisory knowledge base.

### 3.3 What is missing in the current knowledge base

The repository evidence is consistent about what is missing:

- no agronomic advisory text or extension bulletins;
- no ground-truthed “how-to” guidance for paddy, banana, tomato, sugarcane, irrigation, pest management, or disease management;
- no anchor documents with explicit crop and life-stage context;
- no trustworthy advisory source set with attribution and review status.

This is the strongest explanation for the `0/27` advisory answer-bearing result.

## 4. Provenance and reproduction evidence from the repository

The repository already contains the exact evidence for the claim that the issue is architectural rather than a hidden scoring mistake.

### Evidence from the live evaluation summary

[docs/research/evaluation/live/rag_retrieval_2026-10-16.md](docs/research/evaluation/live/rag_retrieval_2026-10-16.md) states:

- 2/13 answerable queries retrieved a relevant chunk in the top three;
- 10/13 answerable queries retrieved the expected file in the top three;
- 9/11 expected-file hits were header-only chunks;
- 0/27 advisory chunks were answer-bearing;
- the overall conclusion: “The corpus is statistical tables and a geography file, not advisory text.”

This is the clearest direct record of the system’s failure mode.

### Evidence from the chunker tests

[tests/rag.chunker.unit.test.js](tests/rag.chunker.unit.test.js) verifies that:

- every chunk contains at least one `Row n:` line;
- chunks begin with `File:`, `Table:`, and `Columns:`;
- district values appear only through their data rows;
- a header-only file yields no chunks at all.

This shows that the codebase already recognizes the correct chunking contract. The likely production issue is that the currently used production corpus was built under the older legacy format, not the newer, safer chunking specification.

## 5. Proposed improvements before implementation

The following improvements are the correct direction; they are listed here as design proposals, not as changes already made.

### 5.1 Improve chunk quality

- Keep row-level data rows together with table context.
- Guarantee every chunk includes:
  - file name,
  - table name,
  - district/crop context,
  - row range,
  - a clear data-bearing body.
- Reject header-only and empty chunks at ingestion time.
- Split large tables by district or crop group rather than by arbitrary text length.

### 5.2 Improve metadata

Add a richer metadata schema, for example:

- `filename`
- `source_type` (`statistics`, `advisory`, `geo`, `extension`, `manual`)
- `district`
- `crop`
- `season`
- `table_name`
- `file_kind`
- `row_start`
- `row_end`
- `source_url` or source citation
- `language`
- `review_status`

This metadata should be attached to every chunk and used in retrieval filters or re-ranking.

### 5.3 Improve crop and topic context

- Normalize crop names across English/Tamil and common variants.
- Add explicit crop labels to documents and chunks.
- Use district and crop filters during retrieval when a query mentions either.
- Include season or crop stage when it is relevant to the question.

### 5.4 Improve retrieval relevance

- Use metadata-aware filtering before similarity ranking.
- Re-rank by file-level match and row content match.
- Prefer answer-bearing documents over pure statistics when the query is advisory.
- Keep top-k larger than 3 for some workflows; then re-rank the candidate set per domain filters.

### 5.5 Improve knowledge-base organization

The knowledge base should be split into discrete, labelled collections or sections:

1. statistical district/crop data;
2. advisory agronomic guidance;
3. crop calendars and seasonal guidance;
4. geographic context (only when directly useful);
5. claimant or policy guidance (if the app needs it).

This separation is necessary because the current corpus mixes statistical tables and geography without an advisory layer.

### 5.6 Preserve source attribution

Any future knowledge-base improvement must keep the provenance trail intact:

- file name,
- source caption or URL,
- document type,
- date/edition,
- language,
- review status.

This requirement is already consistent with the app’s current design objective of returning sources to the client and attributing evidence.

## 6. Risks and limitations

The repository itself already captures the major risks:

- the corpus currently contains little to no answer-bearing advisory information;
- the production collection was built with a legacy chunker that is prone to context loss;
- direct mechanical relevance labels are not equivalent to expert judgment;
- the embedding model remains English-oriented and therefore weak for Tamil-language retrieval;
- no valid before/after retrieval evaluation is currently available because the parity baseline was stopped.

This means any improvement claim must be treated as a proposal until a fresh, reproducible retrieval evaluation is run under the same rules and with the same question set.

## 7. Files most likely to require modification in the next implementation stage

This is the likely modification list for the implementation phase after approval:

- [rag/ingestHelpers.js](rag/ingestHelpers.js): chunking policy, metadata schema, district/crop extraction.
- [rag/ingest.js](rag/ingest.js): ingestion flow, filtering, chunk assembly, consistent metadata handling.
- [services/chat.service.js](services/chat.service.js): retrieval behavior, metadata-aware filtering, improved source reporting.
- [src/ai/AIConfig.js](src/ai/AIConfig.js): retrieval depth, embedding configuration, and retrieval policy constants.
- [config/ragConfig.js](config/ragConfig.js): collection configuration and any metadata-aware retrieval settings.
- [rag/localIndex.js](rag/localIndex.js): local index verification and diagnostic tools for parity/regression checks.
- [scripts/live/ragRetrieval.live.js](scripts/live/ragRetrieval.live.js): evaluation harness to preserve the original outputs and compare new results without overwriting evidence.
- [scripts/live/lib/ragEvalSpec.js](scripts/live/lib/ragEvalSpec.js): evaluation rules, if a new controlled experiment is run.
- [tests/rag.chunker.unit.test.js](tests/rag.chunker.unit.test.js): extend to assert row-bearing chunks, metadata completeness, and relevance-friendly chunk structure.

## 8. Test plan for the next implementation stage

The next implementation stage should not claim improved retrieval without running the tests and evaluation plan below.

### 8.1 Unit tests

- every chunk contains at least one row and no header-only chunk is produced;
- metadata includes `filename`, `district`, `crop`, `table name`, and `row range` when available;
- chunk IDs remain deterministic across identical inputs;
- CSV parsing remains correct for quoted cells and embedded commas/newlines;
- KML/XLS exports are excluded or handled separately rather than silently mixed into the advisory layer.

### 8.2 Retrieval-oriented regression checks

- run the evaluation queries in the existing frozen set;
- keep the original baseline results untouched;
- compare new results in a dated, write-once output directory;
- report the same metrics used in the baseline: answerable-relevant hit rate, expected-file rate, precision, header-only rate, and advisory answer-bearing rate.

### 8.3 Knowledge-base integrity checks

- verify that advisory documents are present and labelled as `source_type = advisory`;
- verify that statistics documents are labelled separately from geography files;
- verify that there are no empty or header-only chunks in the final index.

## 9. Final assessment

The repository evidence points to a single dominant conclusion: the RAG weakness is primarily a corpus + chunking + metadata problem, not a single isolated retrieval bug.

The production knowledge base is mostly statistical and geographic, not advisory. The historical chunker split data into arbitrary text fragments and dropped important context, and the retrieval step asks the model to answer from top-k fragments without metadata-aware filtering or re-ranking.

This root cause is consistent with the exact reviewer findings and with the repository’s own evaluation outputs. It is also consistent with the more recent safeguard work already present in the codebase: the newer table-chunker contract explicitly rejects header-only chunks and preserves row structure and metadata.

No implementation change has been made here. This report is the pre-approval diagnosis step and forms the basis for the next implementation proposal and change plan.
