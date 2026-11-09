| Condition | Top-1 | Top-3 | Top-5 | P@3 | P@5 | R@3 | R@5 | MRR |
|---|---|---|---|---|---|---|---|---|
| frozen-baseline | 1/13 | 2/13 | 2/13 | 0.051 | 0.062 | n/a | n/a | 0.103 |
| snapshot-dense | 1/13 | 2/13 | 2/13 | 0.051 | 0.062 | 0.052 | 0.066 | 0.103 |
| snapshot-evidence | 10/13 | 11/13 | 11/13 | 0.436 | 0.308 | 0.763 | 0.823 | 0.808 |
| tablev1-dense | 8/13 | 10/13 | 10/13 | 0.359 | 0.246 | 0.735 | 0.741 | 0.692 |
| tablev1+advisory-dense | 7/13 | 10/13 | 10/13 | 0.359 | 0.246 | 0.735 | 0.741 | 0.641 |
| tablev1+advisory-evidence | 11/13 | 11/13 | 11/13 | 0.410 | 0.277 | 0.826 | 0.832 | 0.846 |

Paired exact McNemar on hit@k against the first condition (n=13, underpowered):

| Candidate | k | b (ref miss, cand hit) | c (ref hit, cand miss) | p |
|---|---|---|---|---|
| snapshot-dense | 3 | 0 | 0 | 1.0000 |
| snapshot-dense | 5 | 0 | 0 | 1.0000 |
| snapshot-evidence | 3 | 9 | 0 | 0.0039 |
| snapshot-evidence | 5 | 9 | 0 | 0.0039 |
| tablev1-dense | 3 | 8 | 0 | 0.0078 |
| tablev1-dense | 5 | 8 | 0 | 0.0078 |
| tablev1+advisory-dense | 3 | 8 | 0 | 0.0078 |
| tablev1+advisory-dense | 5 | 8 | 0 | 0.0078 |
| tablev1+advisory-evidence | 3 | 9 | 0 | 0.0039 |
| tablev1+advisory-evidence | 5 | 9 | 0 | 0.0039 |
