# Faculty-review package

## Verified claim matrix

| Review claim | Traceable evidence | Status |
|---|---|---|
| Geometry and overlap rules conform to analytic cases | `docs/research/evaluation/results/geometry.json`, n=300/100 | Supported as analytic conformance |
| Evidence gate blocks specified invalid approvals | `fusion.json`, `fusion_v1.1_2026-10-16.json`, 192 scenarios | Supported as policy conformance, not accuracy |
| Safe-AI removes AI-only rejection in the factorial | dated safe-AI fusion row, 2 AI-alone cases | Supported on synthetic cases; no live v1.1 acceptance |
| Context logic follows its specification | `chatContext.json`, 29/44/11 cases | Supported against author-defined labels |
| Live satellite path is feasible but confounded | dated satellite case study, 12 runs | Feasibility only; harvest control false support retained |
| Current RAG grounds advisory answers | dated live RAG artifacts | Not supported: 0/27 advisory chunks answer-bearing |

## Reproduced metrics and commands

Historical metrics are reproduced by inspecting the raw JSON and by the evaluator's bounded run, but the bounded run used Node v22.14.0 and therefore is not a replacement for the Node v26.7.0 historical environment.

```powershell
# backend, historical procedure (requires the recorded environment)
npm ci --legacy-peer-deps
npm run eval -- --date=YYYY-MM-DD

# manuscript traceability
npm run manuscript:numbers

# tests (requires a working MongoDB binary and sufficient disk)
npm test -- --run --no-file-parallelism --reporter=verbose

# frontend
cd ..\tn-farming-assistant-frontend
npm ci
npm test -- --run
```

## Evidence-backed manuscript corrections

1. Keep the paper's wording that all deterministic benchmark results are synthetic, analytic, author-labelled, or specification-scored.
2. Keep the harvest-control false-support observation and state that the live satellite cases lack independent damage labels.
3. Do not add a RAG improvement result: the planned before/after experiment was stopped after baseline parity failed.
4. Do not report full current test success. The current environment cannot complete database-backed suites; prior acceptance artifacts are separate dated evidence.
5. Treat any live-chat, document-extraction, cadastral-accuracy, and crop-loss-accuracy statements as blocked or unsupported until their required labels and raters exist.

## Likely faculty questions

**Does 100% geometry precision/recall mean the system is accurate on farms?** No. The reference is analytic rectangle/polygon arithmetic, not cadastral ground truth.

**Does the satellite result prove damage detection?** No. The study has no independent labels; one harvest-control square produced false support, demonstrating phenology confounding.

**Why are some tests skipped?** Database-backed suites cannot start the cached MongoDB binary; the default path also attempts an unavailable/download-blocked binary acquisition. Disk exhaustion added independent transform failures.

**Why is the safe-AI result credible?** It is a deterministic policy-conformance result on two AI-alone scenarios, not a measured safety rate in deployed claims. It changed 12 synthetic decisions from rejection to hold.

**Was the improved RAG chunker shown to improve retrieval?** No. It is unit-tested, but the controlled live before/after comparison was stopped and must not be presented as an improvement.

**What is the paper's appropriate contribution?** An evidence-gated system design with conformance tests and a limited feasibility study, not validated real-world accuracy.

## Final readiness verdict

Suitable for faculty review as a system-design/conformance paper with a clearly bounded feasibility section. Not ready as a real-world accuracy paper.

Minimum remaining actions:

1. Use a supported, reproducible Node environment and a verified compatible MongoDB binary; free disk space and rerun backend/frontend tests with complete logs.
2. Resolve frozen-hash mismatches without rewriting historical hashes unless the underlying artifacts are independently verified and intentionally versioned.
3. Re-run the manuscript integrity check and regenerate only derived manuscript files under the verified historical environment.
4. For RAG, rebuild baseline and table-aware indexes in isolated locations, verify parity, then run the unchanged question/label set with held-out evaluation.
5. Obtain independent labels and qualified raters for satellite, document, and advisory claims.
