# Experiment protocol

## Questions

1. Do implemented geometry and claim-policy rules conform to their explicit specifications?
2. What does the current live satellite and retrieval path demonstrate without independent labels?
3. Which manuscript claims can be traced to raw observations?

## Inclusion and evidence classes

Existing deterministic evaluators and saved raw JSON were included. Synthetic, author-labelled, live-provider, and independent-reference evidence were kept separate. No production writes, claim submissions, or destructive Git operations were performed.

## Metrics

For binary metrics, positive class and denominator are stated in the source result and summarized in `results_summary.json`: precision = TP/(TP+FP), recall = TP/(TP+FN), specificity = TN/(TN+FP), false-support/approval rate = incorrect positive decisions / eligible negative cases. Conformance results use the written rule as the reference label; they are not real-world accuracy.

No confidence intervals are reported for author-defined synthetic benchmarks or unlabelled case studies. Independence and external validity are not established.

## Reproducibility policy

Original result files remain untouched. This package is additive and records both the existing baseline and the current execution blockers. Any future retrieval improvement must preserve the old questions and relevance labels and use a held-out set.

