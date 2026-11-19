# Final IJRSI Audit Report

## Scope

This report captures the final revision status for the IJRSI manuscript in the Vivasayi AI repository. It is grounded in the preserved historical evaluation files, the current manuscript source, and the verified retrieval behavior in the repository.

## Evidence available in repository

The repository retains the following core evidence:
- `IJRSI_REVISION_AUDIT.md` — reviewer-by-reviewer mapping to sections, evidence, missing evidence, and required follow-up.
- `RAG_ROOT_CAUSE_REPORT.md` — diagnosis of the retrieval and knowledge-base causes.
- `RAG_RETRIEVAL_REPRODUCTION_REPORT.md` — honest reproduction of the original retrieval evaluation.
- `RAG_RETRIEVAL_BASELINE_COMPARISON.md` — comparison of original baseline vs filter-adjusted replay.
- `docs/research/evaluation/live/rag_retrieval_2026-10-16.json` — historical baseline retrieval result.
- `docs/research/evaluation/live/rag_retrieval_2026-10-16.md` — human-readable baseline summary.
- `scripts/live/lib/ragEvalSpec.js` — frozen author-defined relevance rule; kept as historical evidence.
- `services/chat.service.js` — retrieval guardrail for malformed header-only chunks.
- `docs/research/manuscript/main.tex` — authoritative manuscript source.

## Verified findings

The repository currently supports the following evidence-based conclusions:
- The original retrieval baseline remains 2/13 answerable questions with a relevant chunk in the top three.
- The advisory corpus remains answer-bearing at 0/27 advisory chunks.
- Header-only chunks are a genuine defect in the pipeline, and the retrieval safeguard improves evidence hygiene by excluding them before model context assembly.
- The current filter-adjusted replay is not a fresh evaluation; it is a post-hoc safety analysis on the original retrieval set.
- The A12 “successful” result is a header-file match under the frozen author-defined relevance rule, not evidence of real agronomic advisory correctness.

## Manuscript revision status

The actual manuscript source `docs/research/manuscript/main.tex` has been revised to make these distinctions explicit. It keeps the original historical evaluation result, preserves the negative findings, and distinguishes a safety improvement from a retrieval-quality gain.

## Change log mapping reviewer comments to manuscript revisions

| Reviewer concern | Manuscript section | Revision made |
|---|---|---|
| Retrieval weakness and header-only chunks | Results, Discussion, Limitations | Added explicit statement that the filter replay is not a fresh evaluation and that the retrieval result remains weak |
| Advisory corpus absence | Results, Discussion, Limitations | Kept the 0/27 advisory answer-bearing finding and clarified that no agronomic advice claim is made |
| Satellite study limitations | Evaluation Design, Limitations | Preserved the feasibility-study framing and no independent damage labels limitation |
| Advisory chatbot validation gap | Evaluation Design, Limitations | Kept the author-created benchmark and explicit absence of agronomist validation |
| Policy outcome reporting and denominators | Results, Policies section | Preserved denominator logic and explicit decision semantics without overstating correctness |
| Claimant-rights evidence availability | System Design / Limitations | Explicitly kept claimant-rights evidence separate from model-derived evidence and reported its unavailability |

## Final assessment

The revision is scientifically conservative and evidence-based. It improves the system safety around malformed chunks, while maintaining the original negative results and explicitly disclosing that the true remaining constraint is missing answer-bearing advisory content and independent validation.
