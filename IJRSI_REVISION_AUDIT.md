# IJRSI Revision Audit

## Scope and objective

This audit reviews the latest manuscript version in the repository, as represented by the current draft in [docs/research/manuscript/main.tex](docs/research/manuscript/main.tex) and its companion files in [docs/research/manuscript](docs/research/manuscript). It is a pre-edit audit only: no manuscript text, result files, or source code are modified here.

The project already records that the manuscript is not submission-ready. The manuscript README states that the draft is not ready for submission and notes the remaining blockers. The repository evidence supports this status: the current draft is a design-and-conformance paper with a limited live feasibility study, not a real-world crop-loss accuracy paper.

## Repository evidence inspected

The following repository artifacts were reviewed as part of the audit:

- [docs/research/manuscript/main.tex](docs/research/manuscript/main.tex): current manuscript text and final draft sections.
- [docs/research/manuscript/README.md](docs/research/manuscript/README.md): manuscript build and readiness status, including the explicit statement that this is not submission-ready.
- [docs/research/evidence-audit-2026-10-17/evidence_audit.md](docs/research/evidence-audit-2026-10-17/evidence_audit.md): broad assessment of what the repository supports and does not support.
- [docs/research/evidence-audit-2026-10-17/limitations.md](docs/research/evidence-audit-2026-10-17/limitations.md): blocked work, unsupported claims, and required evidence.
- [docs/research/evaluation/results/SUMMARY.md](docs/research/evaluation/results/SUMMARY.md): deterministic synthetic benchmark results.
- [docs/research/evaluation/live/SUMMARY_2026-10-16.md](docs/research/evaluation/live/SUMMARY_2026-10-16.md): live feasibility-study numbers and blocked runs.
- [docs/research/evaluation/live/rag/STATUS_2026-10-17.md](docs/research/evaluation/live/rag/STATUS_2026-10-17.md): RAG parity status and the reason the before/after evaluation was stopped.
- [docs/decisions/18_DECISIONS.md](docs/decisions/18_DECISIONS.md): ADR-022 / policy decision context for v1.1-safe-ai.
- [config/env.js](config/env.js): policy default and operational limits, including the default claim verification policy set to v1.1-safe-ai.
- [scripts/eval/fusion.eval.js](scripts/eval/fusion.eval.js): synthetic policy benchmark and factorial design.
- [scripts/live/ragRetrieval.live.js](scripts/live/ragRetrieval.live.js): live retrieval experiment and the frozen relevance rule.
- [scripts/live/chatContext.live.js](scripts/live/chatContext.live.js): live chat evaluation attempt, blocked by quota.
- [scripts/live/landDocExtraction.live.js](scripts/live/landDocExtraction.live.js): synthetic land-document extraction attempt, blocked by quota.
- Git history: repository log shows the relevant evolution from the early core claims pipeline, policy decisions, and the 2026-10-16 manuscript alignment work.

## Current manuscript status, as evidenced in the repo

The repository already contains a very careful, transparent set of limits and blocked-work disclosures:

- The paper is framed as a design and conformance paper, not a real accuracy paper.
- The manuscript explicitly says that no result is based on real claims, real farmers, or real documents.
- The manuscript and the evidence-audit package both state that live satellite evaluation lacks independent damage labels and is therefore a feasibility study.
- The manuscript and the evidence-audit package both state that live RAG retrieval was insufficient and that no advisory correctness claims are supported.
- The manuscript section on blocked evaluations already documents the quota issue for live chat and land-document extraction.
- The repository’s evidence audit says: “The evidence supports a system-design/conformance paper and a limited feasibility paper. It does not support a real-world accuracy paper...”

This means the journal decision is not surprising: the project already documents a mostly honest position, but it still needs a clearer, more journal-ready presentation of exactly what was measured, what was not, and what remains future work.

## Reviewer comment-by-comment analysis

### Summary table

| Reviewer concern | Existing manuscript section(s) | Relevant implementation / experiment | Evidence already available | Additional work genuinely required | Recommended response type | Realistically feasible by Nov 12? |
|---|---|---|---|---|---|---|
| Claim verification: synthetic benchmark, only two approvable scenarios, need true claims | Introduction; System Design; Evaluation Design; Results; Limitations; Conclusion | [scripts/eval/fusion.eval.js](scripts/eval/fusion.eval.js); verification policy logic in [config/env.js](config/env.js); [docs/research/evaluation/results/SUMMARY.md](docs/research/evaluation/results/SUMMARY.md) | Synthetic factorial, rule design, policy comparisons, v1.1-safe-ai row | Real claims, independent labels, claimant-rights evidence, real adjudication | Explicit limitation + targeted clarification; no claim of real accuracy | No, not in full |
| Satellite evaluation: only 12 squares; no independent crop-damage labels; documentation gaps; seasonality omitted | Satellite evidence; Evaluation Design; Results; Disclosures; Limitations | live satellite study and adapter logic; [docs/research/evaluation/live/SUMMARY_2026-10-16.md](docs/research/evaluation/live/SUMMARY_2026-10-16.md) | 12 live runs; 9 event squares; 3 harvest controls; recorded methodological caveats | Independent parcel-level damage labels, crop calendars, pre-registered windows, more complete square selection/config record | Explicit limitation + documentation clarification; perhaps a small reproducibility appendix or run log | Partially: documentation and tighter disclosure are feasible; real validation is not |
| Advisory chatbot: questions designed by the authors; no agronomist validation; no separate safety/correctness evaluation | Profile-aware advisory chat; Evaluation Design; Blocked Evaluations; Discussion; Limitations | [scripts/live/chatContext.live.js](scripts/live/chatContext.live.js); RAG + chat pipeline; author-defined evaluation sets | The chat pipeline is implemented and some author-defined evaluation exists, but no live results were recorded due quota exhaustion | Agronomist-rated answers in English and Tamil; safety rubric; blinded evaluation; citation correctness | New experiment required; can be framed as future work if no data available | No, not fully |
| RAG retrieval: poor top-3 relevance; header-only chunks; need human relevance judgments and a stated baseline | Results; Retrieval paragraph; Discussion; Limitations | [scripts/live/ragRetrieval.live.js](scripts/live/ragRetrieval.live.js); [scripts/live/lib/ragEvalSpec.js](scripts/live/lib/ragEvalSpec.js); [docs/research/evaluation/live/rag/STATUS_2026-10-17.md](docs/research/evaluation/live/rag/STATUS_2026-10-17.md) | Retrieval metrics already in repo; baseline parity failed; fixed rule documented; header-only issue identified | Human relevance judgments, answer-bearing corpus content, stable retrieval baseline, after/before comparison with a valid corpus | Clarification + limitation; new experiment if the authors choose to pursue it | Partially: a documentation fix is feasible; true human judgment baseline is not |
| Reporting: policy outcomes and denominators; role and availability of authoritative claimant-rights evidence | Results; System Design; Discussion; Limitations | policy and evidence tables in [docs/research/manuscript/main.tex](docs/research/manuscript/main.tex); [config/env.js](config/env.js); the claim verification rule engine | Policy outcomes are reported, but denominators and claimant-rights evidence availability must be made more explicit | Clear denominator explanation and explicit statement that authoritative land-record proof is currently unavailable | Clarification and documentation update | Yes, strongly feasible |

## Detailed comment-by-comment analysis

### 1. Claim verification: synthetic benchmark, only two approvable scenarios, need independent validation using true claims

- Existing manuscript section(s): Introduction, System Design, Evaluation Design, Results, Limitations, Conclusion and Future Work.
- Relevant implementation/experiment: [scripts/eval/fusion.eval.js](scripts/eval/fusion.eval.js), [config/verificationPolicy.js](config/verificationPolicy.js), and the policy default in [config/env.js](config/env.js). The manuscript cites the synthetic factorial and the policy row `v1.1-safe-ai` and discusses the results.
- Evidence already available in repo:
  - The synthetic evaluation is deterministic and has a design-rule ground truth rather than a real-world ground truth.
  - The manuscript clearly states the policy comparison: `v1-legacy` and `v1.1-safe-ai`.
  - The repository states that the `v1.1-safe-ai` row changes only AI-only rejections and holds, while the invalid-approval rate remains 10/190 under the legacy and safe-AI rows.
  - [docs/research/evidence-audit-2026-10-17/evidence_audit.md](docs/research/evidence-audit-2026-10-17/evidence_audit.md) explicitly says the evidence supports a design/conformance paper, not a real-world accuracy paper.
- Additional work genuinely required:
  - Independent claims with adjudicated outcomes.
  - Authoritative claimant-rights evidence (official land records, if available under the jurisdiction).
  - A real-world, labelled claim dataset with ground truth determined by a non-author entity.
- Assessment:
  - The current draft already states the core limitation. The paper should not claim approved-claim accuracy or fraud-detection performance. The remainder is a matter of making the limitation more explicit and narrower.
- Recommended response: explicit limitation and targeted clarification, not a claim of real-world accuracy.
- Feasible before Nov 12? No, not the true-claims validation itself. The paper can clarify and narrow scope, but the real validation cannot be completed without data and labels.

### 2. Satellite evaluation: only 12 parcel squares; no independent crop-damage labels; square selection and run configuration insufficiently documented; seasonality is not accounted for

- Existing manuscript section(s): System Design (satellite evidence); Evaluation Design; Results; Disclosures; Limitations and Threats to Validity.
- Relevant implementation/experiment: the live satellite study summary in [docs/research/evaluation/live/SUMMARY_2026-10-16.md](docs/research/evaluation/live/SUMMARY_2026-10-16.md), with the methodological notes and the post-hoc scene filter disclosure in [docs/research/manuscript/main.tex](docs/research/manuscript/main.tex).
- Evidence already available in repo:
  - The manuscript reports 12 live runs in total: 9 event squares and 3 harvest-control squares.
  - It also explains that no independent crop or damage labels exist.
  - It documents the scene-parameter change after observation and the limitation that the fixed NDVI window is confounded by crop phenology and sparse post-event observation.
  - The evidence audit explicitly calls this a feasibility study, not a damage-detection accuracy study.
- Additional work genuinely required:
  - Independently labelled parcel-level damage outcomes.
  - Crop-calendar and seasonality metadata.
  - Clearer square selection and run configuration notes, with pre-registration or a reproducible run manifest.
- Assessment:
  - The current manuscript already recognizes the central issue: no independent ground truth and no calibrated seasonal model. What is missing is a stronger and more explicit statement about the operational limits of the 12-square result and a tighter run log.
- Recommended response: explicit limitation plus better documentation of square choice and run configuration. If no new data can be collected, the paper should stay framed as a feasibility study.
- Feasible before Nov 12? Partially. The manuscript can and should be tightened to explain the study design and configuration limitations. Full seasonal validation with independent labels is not realistic by the deadline.

### 3. Advisory chatbot: farmer questions were designed by the authors; no independent agronomist validation; no separate evaluation of agronomic safety and correctness

- Existing manuscript section(s): Profile-aware advisory chat; Evaluation Design; Blocked Evaluations; Discussion; Limitations; Conclusion and Future Work.
- Relevant implementation/experiment: [scripts/live/chatContext.live.js](scripts/live/chatContext.live.js), the chat pipeline, and the author-defined evaluation sets in the same script. The paper also says live chat was blocked by provider quota.
- Evidence already available in repo:
  - The repository contains author-defined chat-context logic evaluation and a live chat driver, but no completed live-model answer-quality evaluation.
  - The current manuscript says live chat was prepared but could not run because of free-tier quota exhaustion.
  - [docs/research/evidence-audit-2026-10-17/limitations.md](docs/research/evidence-audit-2026-10-17/limitations.md) lists expert-rated answers, agronomist raters, and a rubric as required evidence.
- Additional work genuinely required:
  - Bilingual, blinded expert ratings.
  - Formal safety rubric (e.g. risky agronomic advice, unsafe recommendation, abstention behavior).
  - Separate correctness and harmfulness evaluations.
- Assessment:
  - The current manuscript is already honest in saying that live language-model behaviour is unmeasured and that the deployed knowledge base is not advisory-rich. The concern is not a hidden result; it is a genuine limitation that should remain explicit.
- Recommended response: explicit limitation and a future-work statement; no claim that the assistant is agronomically validated.
- Feasible before Nov 12? No, not the expert validation itself. The paper may still be revised to clarify the current status and what the safe claim is: context resolution and routing are implemented, but agronomic quality and safety remain unmeasured.

### 4. RAG retrieval: only 2/13 answers retrieved a relevant chunk in the top three; many chunks in expected files contained only headers; need human relevance judgments, a stated baseline and answer-bearing knowledge-base content

- Existing manuscript section(s): Results (Retrieval paragraph), Discussion, Limitations, Conclusion and Future Work.
- Relevant implementation/experiment: [scripts/live/ragRetrieval.live.js](scripts/live/ragRetrieval.live.js) and the retrieval rule in [scripts/live/lib/ragEvalSpec.js](scripts/live/lib/ragEvalSpec.js). The parity stop is recorded in [docs/research/evaluation/live/rag/STATUS_2026-10-17.md](docs/research/evaluation/live/rag/STATUS_2026-10-17.md).
- Evidence already available in repo:
  - Live retrieval result: 2/13 answerable questions had a relevant chunk in the top-3; 10/13 retrieved the expected file in top-3; 9/11 expected-file hits were header-only chunks; 0/27 advisory chunks were answer-bearing.
  - The manuscript itself already identifies the ingestion and chunking issue: rows are chunked without enough file/crop context and some hits are header-only rows.
  - The repository says the baseline parity check was stopped before any before/after comparison could be used. This is a critical scientific limitation, not a hidden success.
- Additional work genuinely required:
  - Human relevance judgments on the same queries.
  - A valid baseline and a full before/after comparison.
  - Answer-bearing knowledge-base content in the corpus itself.
- Assessment:
  - The project does not currently have the necessary evidence to claim a strong RAG result. It does have evidence that the current deployed corpus and chunking strategy are not sufficient for answer quality.
- Recommended response: a stronger limitation statement plus a clear baseline and retrieval-quality statement; if the authors decide not to do additional RAG work, they should avoid any suggestion that the retrieval layer is validated for helpful advisory answers.
- Feasible before Nov 12? Partially. The manuscript can be revised to present the current evidence more clearly and to avoid unfounded claims. A human-judged baseline and a valid after/before comparison are not realistic without more corpus work and adjudication.

### 5. Reporting: explain policy outcomes and denominators in tables; explain the role and availability of authoritative claimant-rights evidence

- Existing manuscript section(s): Results (Evidence fusion), System Design (documents and claimant relationship), policy discussion, Limitations and Threats to Validity.
- Relevant implementation/experiment: [scripts/eval/fusion.eval.js](scripts/eval/fusion.eval.js), [config/env.js](config/env.js), and the policy sections in [docs/research/manuscript/main.tex](docs/research/manuscript/main.tex).
- Evidence already available in repo:
  - The manuscript presents the policy comparison and states the invalid-approval rate and hold behavior.
  - The repository also states that no authoritative claimant-rights source is available, and the official-record adapter reports `unavailable`.
  - The manuscript already says that the gate makes approval more cautious and holds when evidence is pending, rather than approving or rejecting absent evidence.
- Additional work genuinely required:
  - Make the policy denominator and comparison logic more explicit in the table captions and the prose.
  - State clearly that claimant-rights evidence is currently unavailable in deployment and therefore cannot be treated as observed data.
- Assessment:
  - This is likely the most tractable reviewer concern. The manuscript already contains the facts; the revision is primarily a reporting and clarity issue.
- Recommended response: update tables/captions and add a brief paragraph explaining the role and current unavailability of authoritative claimant-rights evidence.
- Feasible before Nov 12? Yes, very feasible.

## Evidence available in the repository

1. Synthetic benchmark evidence
   - Deterministic policy and geometry conformance are present.
   - [docs/research/evaluation/results/SUMMARY.md](docs/research/evaluation/results/SUMMARY.md) reports the following key synthetic numbers:
     - Geometry: containment, overlap, and invalid-geometry detection are exact on the analytic benchmark.
     - Fusion: the legacy photograph-only policy has invalid approvals of 10/190 and AI-alone rejections of 2/2; the safe-AI policy still approves 10/190 invalid scenarios and rejects 0/2 AI-alone scenarios; the only changed decisions are 12 AI-rule rejections converted to holds.
     - Chat context: author-defined specification scored no unnecessary follow-up questions and no missed necessary questions.
     - Name matching: 60/60 on the same author-labelled set, with the note that the tuning was done on that same set.

2. Live feasibility evidence
   - [docs/research/evaluation/live/SUMMARY_2026-10-16.md](docs/research/evaluation/live/SUMMARY_2026-10-16.md) reports:
     - 12 live satellite squares total.
     - 0/9 event squares supported loss.
     - 1/3 harvest-control squares falsely supported loss.
     - Retrieval: 2/13 answerable queries retrieved a relevant chunk in the top-3; 0/27 advisory chunks were answer-bearing.
     - Live chat was not completed because the free-tier quota was exhausted.

3. Limitations and blocked work evidence
   - [docs/research/evidence-audit-2026-10-17/evidence_audit.md](docs/research/evidence-audit-2026-10-17/evidence_audit.md) states that the evidence supports a system-design/conformance paper and a limited feasibility paper, not a real-world accuracy paper.
   - [docs/research/evidence-audit-2026-10-17/limitations.md](docs/research/evidence-audit-2026-10-17/limitations.md) lists the concrete missing evidence required for real-world performance claims.
   - [docs/research/manuscript/README.md](docs/research/manuscript/README.md) explicitly states that the manuscript is not submission-ready.

4. Policy and design evidence
   - [docs/decisions/18_DECISIONS.md](docs/decisions/18_DECISIONS.md) records the policy decisions around safe-AI behavior.
   - [config/env.js](config/env.js) shows that v1.1-safe-ai is the current default policy.
   - The manuscript and code explicitly say that satellite and weather are optional and non-decisive.

## Missing evidence that cannot be invented

The following evidence is missing from the current repository and cannot be created credibly by a manuscript revision alone:

- Independent real-claim labels for crop loss or claimant qualification.
- Independent crop-damage labels for parcel squares.
- Independent agronomist validation of farmer-facing advisory chat.
- Human relevance judgments for retrieval on the live knowledge base.
- A valid human-rated baseline and answer-bearing advisory knowledge-base content.
- Authoritative claimant-rights records from an official source.
- A labelled, held-out set for name matching and document extraction.
- Real-world external validation by agronomists, officials, or crop scientists.

## Proposed manuscript changes

These revisions are appropriate to the evidence already in the repository and do not require fabricated data:

1. Tighten the manuscript claim from “feasibility study” to a clearer “design and conformance study with limited live feasibility evidence.”
2. Repeat the central limitation explicitly: no real claims, no real crop-damage labels, and no expert agronomic validation.
3. Add a brief explanation of the authoritative claimant-rights evidence gap: no official Tamil Nadu land-record API is available to the project, so the system currently reports this status as unavailable rather than as verified evidence.
4. Clarify that the live satellite study is case-based, not label-based, and use stronger wording such as “supports or does not support loss in the study conditions,” not “detects damage.”
5. Explain the RAG result in the same terms the repo uses: retrieval quality on the present corpus is weak, and the current corpus does not contain enough answer-bearing advisory content.
6. Make all result tables show the denominator explicitly and explain whether the denominator is “all scenarios,” “answerable queries,” “event squares,” or “advisory queries.”
7. Keep the future work list as a real future-work list, not a disguised claim of already-existing evidence.
8. Add a short statement that the policy comparison demonstrates rule behavior under deterministic conditions, not real-world accuracy.

## Additional experiments worth conducting within the deadline

The following are the experiments most worth attempting before November 12, 2026, assuming the authors do not have external datasets or human panels already available:

### High-value, realistic additions

1. Better denominator and reporting clarification in the paper itself.
   - Fully explain which policy outcomes are compared, what the denominator is, and what is held out.
   - This is low-cost, high-value, and directly supported by the current results.

2. Expanded reproducibility appendix for the 12-square live satellite study.
   - Document the exact selection logic, square geometry, event dates, post-event windows, cloud masks, and scene configuration.
   - This can substantially improve reviewer confidence without adding new labels.

3. A sharper discussion of the current knowledge base and retrieval failure modes.
   - Document which file types dominate the corpus and why retrieval fails on advisory queries.
   - The repo already contains the evidence; this is mostly documentation and interpretation.

4. A short, explicit comparison of the RAG answer-bearing corpus content vs the retrieval metric.
   - Produce a file-level summary: which chunks were data-bearing, which were header-only, and which files are advisory-ready.
   - This is feasible with existing files.

### Worth trying only if external resources are already available

5. A small human relevance study on the existing RAG query set.
   - Only if a minimal expert or domain-qualified panel is available before the deadline.
   - This would still not solve the real-world accuracy problem, but it could improve the retrieval interpretation.

6. A small agronomist review of a limited number of responses using a fixed rubric.
   - This is only feasible if an agronomist team is already available or a pre-existing review panel can be mobilized quickly.
   - Otherwise this is not likely to be done in time.

### Not realistic before the deadline

- Real-claim validation with authoritative claimant-rights evidence.
- Independent crop-damage labels for satellite evaluation.
- A full real-world advisory-quality validation with blind agronomist ratings.
- A proper legal/official land-record evaluation against authenticated claimant-rights data.
- A re-chunked and re-evaluated RAG corpus with human relevance judgments and an approved retrieval baseline.

## Scientific-integrity risks

The repository and manuscript already show the main scientific-integrity issues plainly. The revision should guard against the following:

1. Overclaiming design conformance as real-world accuracy.
   - The synthetic benchmark is real evidence of rule compliance, not evidence of actual claim outcomes.

2. Presenting a small, unlabelled feasibility study as proof of crop-damage detection capability.
   - The live satellite study is not an independent test of damaged-vs-undamaged farmland.

3. Treating author-defined relevance or author-defined benchmark labels as independent expert ratings.
   - This is acceptable for a conformance paper, not for a real-world accuracy claim.

4. Exaggerating the role of RAG when the retrieval quality is poor and the corpus is not answer-bearing for advisory questions.
   - The manuscript should keep the current results in the foreground.

5. Implicitly treating the safe-AI policy as a proof of fairness or correct decision making in real life.
   - The repository already states that it protects against model-only adverse decisions and technical failures, without creating real-world accuracy.

6. Omitting the claimant-rights evidence gap.
   - If the manuscript implies the gate is operating on authoritative claimant proof when no such source is available, that would be misleading and scientifically weak.

## Prioritized revision checklist

### Priority 1 — mandatory clarification

- [ ] Make the core scope explicit: design/conformance + limited feasibility, not real-world accuracy.
- [ ] State clearly that the study does not use real claims or real damage labels.
- [ ] Explain the role and current unavailability of authoritative claimant-rights evidence.
- [ ] Tie the policy tables directly to their denominators (all scenarios, AI-alone scenarios, reply/no-reply, etc.).
- [ ] Add a sentence describing why the live satellite study is not equivalent to a real field-validation study.

### Priority 2 — manuscript tightening

- [ ] Add a sharper limitation sentence for the advisory chatbot: no agronomist validation, no separate safety evaluation, and live chat was blocked by quota.
- [ ] Add a sharper limitation sentence for the RAG layer: current retrieval quality is poor, the corpus is not sufficiently answer-bearing, and the baseline parity work was stopped.
- [ ] Clarify that the 12-square satellite result is a case study under fixed windows with no independent damage labels.
- [ ] Make the “future work” section clearly future work and not a proxy for existing evidence.

### Priority 3 — optional but valuable before submission

- [ ] Add a brief appendix or supplementary note describing the exact square selection logic and run configuration for the live satellite study.
- [ ] Add a file-level RAG content analysis showing how many chunks are header-only versus data-bearing.
- [ ] Add a one-paragraph summary explaining why the current corpus content prevented a stronger retrieval signal.

### Priority 4 — not realistic before the editorial deadline

- [ ] Real-world claim validation with independent claimant-rights adjudication.
- [ ] Full agronomist validation of the advisory chatbot.
- [ ] Independent field-level crop damage validation.
- [ ] Human relevance judgments and a valid before/after RAG evaluation on a new corpus.

## Bottom line

The repository evidence supports a strong revision narrative: the current paper is already honest about its design conformance and feasibility limits, but it needs clearer reporting and narrower claims. The main burden is not to create new data; it is to tighten the manuscript so it states clearly what was measured, what remains blocked, and what requires future work. The strongest short-term revision path is documentation and reporting clarity, not data fabrication.

The paper is not yet ready to claim real-world crop-loss accuracy or agronomic advisory correctness. That is consistent with the current repository evidence and with the manuscript’s own explicit limitations.
