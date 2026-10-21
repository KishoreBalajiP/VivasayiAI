# Vivasayi AI research evidence audit

Audit date: 2026-10-17 (Asia/Calcutta). Repository scope: `tn-farming-assistant` and `tn-farming-assistant-frontend`.

## Overall verdict

The evidence supports a **system-design/conformance paper** and a limited **feasibility paper**. It does not support a real-world accuracy paper or a submission-ready claim of agricultural, fraud-detection, document-extraction, or crop-loss accuracy.

The strongest evidence is deterministic synthetic conformance testing and a read-only live feasibility study. The live study has no independent damage labels, no expert-rated answers, and no completed document-extraction evaluation.

## Claim-to-evidence matrix

| Claim | Evidence | Data / n | Metric / observed result | Verdict and limitation |
|---|---|---:|---|---|
| Geometry validation detects invalid polygons and containment correctly | `docs/research/evaluation/results/geometry.json`, geometry evaluator | Analytic synthetic cases; n=300 containment/overlap, n=100 validity | Precision=1, recall=1; valid rejection=0/100 | **Supported for analytic conformance**; not cadastral accuracy |
| Cross-farmer overlap is flagged | `geometry.json` | Synthetic analytic cases; n=300 | Precision=1, recall=1 | **Supported for rule conformance**; real shared-boundary/cadastral cases absent |
| Evidence fusion prevents invalid approval under the gated policy | `fusion.json`, `fusion_v1.1_2026-10-16.json` | Author-defined factorial; 190 forbidden + 2 AI-alone scenarios | v2 invalid approvals=0/190; v1.1 equals legacy at 10/190 | **Supported as design-rule conformance**; not decision accuracy |
| Safe-AI avoids AI-only rejection | `fusion_v1.1_2026-10-16.json`, safe-AI tests | Synthetic factorial; 2 AI-alone scenarios | legacy rejects 2/2; v1.1 rejects 0/2; changes 12 decisions to holds | **Partially supported**; technical-failure factor not in factorial and no live acceptance run |
| Context-aware chat reduces unnecessary follow-ups | `chatContext.json`, evaluator | Author-defined specification; n=44 unnecessary, n=11 necessary, n=29 intent | new unnecessary=0/44; missed necessary=0/11; intent=29/29 | **Supported only against author-defined specification**; no user study |
| Name matcher is accurate | `names.json` | Author-labelled, tuned on same set; n=60 | 60/60 after tuning | **Partially supported**; optimistic, no held-out set |
| Satellite threshold detects crop damage | `satelliteSimulation.json`; live case-study JSON | Simulation; 400 per condition. Live: 12 runs | 0/400 false support in simulation no-change; 199/400 at 0.15 drop; 399/400 at 0.30. Live: 0/9 event squares supported loss; 1/3 harvest controls false-supported | **Feasibility only**; no independent damage labels, phenology confounding, post-hoc scene filter change |
| Live retrieval grounds agricultural advice | `live/rag_retrieval_2026-10-16.md` and related JSON | 22 queries; 13 answerable, 9 advisory; 450 chunks | relevant top-3=2/13; advisory answer-bearing=0/27; expected-file top-3=10/13, 9/11 header-only | **Unsupported for advisory quality**; retrieval baseline parity failed and before/after was stopped |
| Land-document extraction has field-level accuracy | `scripts/eval/docExtraction.score.js` only | No labelled results | Not measured; Gemini quota blocked | **Blocked** |
| Live advisory answer correctness/groundedness/citation correctness | live evaluation status and README | No completed rated answers | Not measured; quota and rubric/raters missing | **Blocked** |
| Real claim, ownership, duplicate, or fraud-detection accuracy | No independent real labels | n=0 | Not measured | **Unsupported** |

## Provenance and environment

- Backend commit: `14d92e2` (`develop`, upstream tracking branch gone); working-tree status was clean at audit inspection.
- Frontend commit: `4f17eeb` (`develop`, ahead 5); working-tree status was clean at audit inspection.
- Node reported by the shell: `v22.14.0`. Existing generated results identify Node `v26.7.0`; this is an environment mismatch that must be resolved for exact reproduction.
- Python was not available on PATH.
- Dependency manifests and lockfiles exist for both repositories; `node_modules` was present.
- No credentials or environment-variable values were copied into this package.

## Execution audit

| Command | Outcome | Interpretation |
|---|---|---|
| `npm run eval` in backend | Started, emitted dotenv loading, then stalled; manually stopped with exit code 1 | No new evaluation result; existing dated artifacts retained |
| `npm test -- --runInBand` in backend | Vitest started, no test report before stall; manually stopped with exit code 1 | No new pass-rate claim |
| `npm test -- --run` in frontend | Vitest started, no test report before stall; manually stopped with exit code 1 | No new pass-rate claim |

| `npm run manuscript:numbers` in backend | Exit code 1: ADR-022 status-line date no longer matches the manuscript-number checker expectation | Manuscript reproducibility/alignment check currently fails; this is a documentation/version-drift issue, not evidence of a scientific result |

### Stall diagnosis and bounded reruns

- The default backend evaluator and tests stalled while `mongodb-memory-server` attempted to obtain MongoDB. The repository setup only auto-selects fixed system paths; no suitable system path was found, and the cache contained an incomplete `7.0.14` download.
- With `MONGOMS_SYSTEM_BINARY=C:\Users\kisho\.cache\mongodb-binaries\mongod-x64-win32-8.2.6.exe`, `npm run eval -- --date=2026-10-17` completed in about 5 seconds, but it used Node `v22.14.0`, so its output was not accepted as a historical reproduction and was restored.
- The same explicit-binary test run did not establish a valid full suite: the cached MongoDB binary exited with `fassert`, database-dependent suites were skipped/failed, and the C: drive reached zero free space, producing `ENOSPC` transform failures. Observed final aggregate: 76 failed files, 5 passed files; 204 passed tests, 310 skipped; exit code 1.
- The frontend test run was previously stopped before reporting. A clean rerun requires freeing disk space first; no frontend pass rate is claimed.
- The repository CI uses Node 24, while the published evidence records Node `v26.7.0`; the current shell is Node `v22.14.0`. No repository-pinned Node version or lockfile-level engine constraint was found. Historical results must therefore remain labelled with their recorded environment.

The evaluator's normal behavior overwrites dated result files. Historical files were restored after the diagnostic rerun; no new result is treated as historical evidence.

These interrupted runs are recorded as reproducibility failures, not successes or failures of the underlying tests.

