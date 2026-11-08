# Response to IJRSI Reviewers

## Overview

We revised the manuscript to distinguish what was genuinely improved from what remains a limitation, and we preserved the original historical evaluation artifacts and result files. The paper now explicitly states that the retrieval safeguard is conservative, that the filter-adjusted replay is not a fresh evaluation, and that the advisory knowledge base remains inadequate for agronomic advice without genuine answer-bearing documents.

## Reviewer 1: Claim verification and RAG retrieval

Original concern: the retrieval evaluation and evidence base were weak; header-only chunks and a missing advisory corpus undermined the paper.

Manuscript changes:
- Clarified that the live retrieval result remains 2/13 answerable questions with a relevant chunk in the top three.
- Kept the original baseline values and did not overwrite historical evaluation files.
- Added a clear distinction between a post-hoc filter replay and a fresh evaluation.
- Explicitly documented that the A12 “successful” hit is a file-name match to a pest-prediction table header under the author-defined rule and is not evidence of agronomic advice.
- Retained the limitation that no retrieved chunk could ground an advisory question and that 0/27 advisory chunks were answer-bearing.

Status: the manuscript now presents this as a corpus and evidence limitation, not as a new success claim.

## Reviewer 2: Satellite evaluation

Original concern: only 12 parcel squares were analysed and no independent crop-damage labels were available.

Manuscript changes:
- Kept the live satellite section as a feasibility study, not as validation of crop-damage detection.
- Preserved the explicit limitation that the squares were selected near documented events without independent ground labels.
- Kept the study's denominators and event counts explicit.

Status: the manuscript states the limitation without overstating the result.

## Reviewer 3: Advisory chatbot and agronomic safety

Original concern: author-created questions and no independent agronomist validation.

Manuscript changes:
- Kept the advisory evaluation as author-designed and explicitly not expert-validated.
- Stated that no agronomic safety or correctness claim is made for advisory outputs.
- Kept the knowledge-base limitation explicit: the advisory corpus is not answer-bearing.

Status: the limitation is documented as a scientific gap, not hidden as a capability claim.

## Reviewer 4: Reporting and denominator transparency

Original concern: tables and text must state denominators and policy outcomes clearly.

Manuscript changes:
- Kept the synthetic policy outcomes tied to the actual denominators.
- Preserved the distinction between invalid approvals, AI-alone rejections, and holds for review.
- Kept the claimant-rights evidence status explicit: no authoritative land-rights data source is available to the project.

Status: denominator reporting remains transparent and conservative.

## Reviewer 5: Evidence-gated architecture and claimant-rights role

Original concern: the paper should explain the role of authoritative claimant-rights evidence and the limits of model-only readings.

Manuscript changes:
- Kept the system architecture and policy sections explicit that claimant rights are separate from AI evidence and cannot be verified by a model reading alone.
- Preserved the distinction between model-derived evidence and authoritative evidence.

Status: the manuscript maintains the evidence-gated decision framing.

## Scientific integrity statement

The revised manuscript does not claim new accuracy, agronomic validation, or improved retrieval quality. Instead, it states the following with evidence:
- the retrieval safety fix removes malformed header-only chunks;
- the overall answerable retrieval result remains poor;
- advisory answer-bearing evidence remains absent;
- the filter-adjusted replay is a post-hoc safety check, not a new evaluation;
- the paper's contribution remains evidence-gated claim verification, profile-aware advisory architecture, conformance evaluation, and live feasibility.

We did not fabricate labels, citations, independent validation, or agricultural advice.

## Final status

The revised manuscript is a scientifically conservative IJRSI revision. It reports the real limitations, preserves the original negative findings, and distinguishes what is improved in software safety from what remains unavailable without a genuine advisory corpus and independent validation.
