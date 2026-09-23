# Phase 4 — AI Evidence Assessment (E9-S4) — Final Report

**Date:** 2026-09-21
**Phase:** 4 of 12 — AI Evidence Assessment (E9-S4, ADR-019)
**Status:** COMPLETE

---

## 1. Result

The claim evidence AI-assessment slice is implemented **with no change to the public API surface**
(internal service only, §18). Dedicated claim-loss vision prompt + normalizer, an internal
assessment service that persists per-image frozen observations and a deterministic aggregate into
`claimassessment`, lifecycle/idempotency/audit guarantees, and a 41-scenario Phase 4 verification
suite. **Full regression: 166 passed, 0 failed.**

## 2. Files changed

- **New** `backend/src/ai/ClaimLossVisionTemplates.js` — frozen claim-loss AI contract: `CLAIM_LOSS_VISION_INSTRUCTIONS` (dedicated prompt, uncertainty-first with explicit prohibitions), `CLAIM_LOSS_ASSESSMENT_VERSION` ("1"), `CLAIM_LOSS_OBSERVATION_FIELDS` whitelist, enum vocabularies (`flood|storm|drought|fire|pest|disease|other` / `minor|moderate|severe` / `high|medium|low|unclear` / `good|fair|poor|unclear`), `CLAIM_LOSS_PROHIBITED_MARKERS`.
- **New** `backend/services/claimVision.service.js` — reuses the existing shared `model` from `services/chat.service.js` (same adapter `vision.service.js` uses; no second Gemini client/secrets). `normalizeClaimObservation` (strict whitelist + enum clamp + prohibited-marker → uncertain + inconsistency), `analyzeClaimImage` (mock seam, markdown-fence-tolerant JSON parse, unparseable → UNCERTAIN, provider/timeout → sanitized 500).
- **Modified** `backend/models/ClaimAssessment.js` — **additive only** (07 §14 rule 1): `status` (`pending|processing|completed|failed`), `version`, `model`, `evidenceVersion` (sha1 of sorted `uploadId:updatedAt`), `aiImageAssessments[{evidenceId, uploadId, observation}]`, `startedAt/completedAt/failedAt`, `error {stage,message}`. Decision fields stay reserved `null` until E9-S5.
- **New** `backend/services/claimAssessment.service.js` — `assessClaimEvidence({claimId, cognitoSub, requestId})`: claim/owner-scoped (foreign → 404, IDOR-safe), usable evidence = `stored` only (else 400), unique-row + status-CAS slot (`acquireProcessingSlot` → `{assessment, proceed}`: in-flight/completed-same-version reused, changed evidence re-assesses on a new version boundary), deterministic `buildAggregate`, persistence-boundary `scrubObservation`, sanitized failures (`storage|provider`), audit `ai_completed` / `assessment_failed` (actor `engine`).
- **New** `backend/tests/claim.vision.test.js` — 13 unit tests (P4-V01..P4-V13).
- **New** `backend/tests/claim.assessment.test.js` — 28 integration scenarios (P4-01..P4-34, mapped to §21 A–H).
- **Docs (updated only where a real decision was made):** `07_Database_Design.md` (§8 Phase 4 fields + aggregate rules + `claimassessment` status row; §9 `assessment_failed`), `08_API_Documentation.md` (item 10 Phase 4 note), `15_Security.md` (§5 Phase 4 AI-security controls + audit), `17_Backlog.md` (E9-S4 → DONE + Phase 4 note), `19_CHANGELOG.md` (Phase 4 entry), `18_DECISIONS.md` (ADR-019 Phase 4 implementation note).
- **Final report:** this file (`PHASE_4_FINAL_REPORT.md`, tracked beside PHASE_1/2/3).

## 3. Gemini / model-adapter integration

No second client and no new secrets. `claimVision.service.js` imports the shared `model`
(`ChatGoogleGenerativeAI`, provider/model/token limits from `src/ai/AIConfig.js`, provider
`gemini`, model `gemini-2.5-flash`) exactly as `vision.service.js` does, but with a **dedicated
claim-loss system prompt** (09 §6.1 prompt isolation — the claim prompt is separate from the chat
`ImageDiagnosisTemplates`/`PromptBuilder`). In dev/test the existing `IMAGE_AI_MODE=mock` seam
returns canned structured observations; live mode sends `SystemMessage` + `HumanMessage`
(`image_url` data URL) to `model.generate`.

## 4. Exact AI output contract

Frozen (ADR-019 / 09 §6.1), single source of truth `ClaimLossVisionTemplates.js`. Per image:
`cropDetected`, `damageDetected`, `damageType`, `severity`, `visibleAffectedPortion`, `confidence`,
`uncertain`, `inconsistencies`, `observations`, `imageQuality`. Enums clamped as above; `null` =
cannot determine. **Prohibited everywhere** (structurally impossible to persist — server-side
scrub + tests): acreage, polygon/parcel boundary, compensation/amount/payout, approval/eligible/
remaining, final status/decision. `visibleAffectedPortion` and `severity` are qualitative only —
no severity→acreage conversion exists anywhere (P4).

## 5. ClaimAssessment persistence

One `claimassessment` row per claim, written only for the AI-evidence stage: `status` lifecycle
(`pending → processing → completed | failed`), `version`, `model`, `evidenceVersion`,
`aiImageAssessments` (per-image frozen observations), deterministic `aiAggregate` (damageDetected
any-true/all-false/null; damageType/severity most frequent, severity tie → more severe; confidence
most conservative; `uncertain` = any image uncertain OR unknown damage; cross-image
inconsistency strings). Decision fields remain `null`.

## 6. Idempotency / concurrency

Unique `claimId` + atomic status CAS. `acquireProcessingSlot` returns `{assessment, proceed}`:
only the owner of a freshly-acquired slot runs the pipeline; an in-flight `processing` or
`completed`-with-same-`evidenceVersion` row is returned as-is (never duplicated / never re-run);
changed evidence re-assesses on the same row with a new version boundary; races fall back to the
current state without running. Failed rows retry per contract. **A real concurrency defect found
and fixed by the P4-24 test** (in-flight reuse previously let the second caller re-run the
pipeline).

## 7. Security / ownership

Only `{claimId, cognitoSub, requestId}` are read — client-supplied `imageUrl`, `s3Key`,
`cognitoSub`, and claim `state` are structurally ignored (P4-31..34). Foreign claims resolve to
404 (IDOR-safe, no existence disclosure). Only claim-owned `stored` evidence bytes reach vision.
Failures are sanitized (`Image storage unavailable` / `Claim evidence assessment failed`; provider
internals never leave the server). Audit metadata contains no s3Key/bucket/owner/prompt/URL/image
content. No public endpoint added.

## 8. AI guardrails

Frozen contract whitelist + enum clamp + prohibited-marker flagging (→ `uncertain` + inconsistency)
in the normalizer, plus a **persistence-boundary scrub** in `claimAssessment.service.js` so even a
leaky adapter output cannot persist authoritative fields (P4-12..16). No severity→acreage
conversion; no claim state transition (G tests assert claim state/area/geometry untouched and
decision fields null); uncertainty is first-class and composed, never fabricating data.

## 9. Tests executed and exact counts

`npm test` → **7 test files passed, 166/166**:
- 10 `parcels.geometry` + 31 `parcels.api` + 9 `claimState` + 58 `claims.api` + 17 `claims.evidence`
  (pre-existing) — all green.
- **13** `claim.vision.test.js` (P4-V01..P4-V13) — parse, fences, malformed/empty → UNCERTAIN,
  unknown-field strip, prohibited-field strip + flag + uncertain, enum coercion, confidence clamp,
  uncertain default, qualitative portion, provider error/timeout sanitization, non-object input.
- **28** `claim.assessment.test.js` (P4-01..P4-34 per §21 A–H) — ownership 404 + no vision call;
  evidence-state gates (missing/pending → 400, stored accepted, foreign); model-adapter behaviour
  incl. malformed/unsure composition and provider error/timeout → `failed` stage `provider` +
  `assessment_failed`; guardrails (leaky adapter never persists; no acre; area/geometry untouched);
  uncertainty (uncertain/quality/unclear/conflicting/insufficient — claim never transitions);
  lifecycle (single row, idempotent reuse, in-flight never duplicated, failed retry); claim state
  untouched + decision fields null; security (imageUrl/s3Key/attackerCognitoSub/state args ignored,
  audit metadata clean).

## 10. Static checks

No lint script exists in this repo (validated in prior phases); syntax checked with
`node --check` on all 6 new/modified JS files — **clean**:
`ClaimLossVisionTemplates.js`, `claimVision.service.js`, `claimAssessment.service.js`,
`ClaimAssessment.js`, `claim.vision.test.js`, `claim.assessment.test.js`.

## 11. Documentation updated

07 (§8 Phase 4 fields/enums/aggregate rules/evidenceVersion + row status; §9 `assessment_failed`),
08 (item 10 Phase 4 note — unchanged public surface, `assessment: null` remains in claim detail),
15 (§5 Phase 4 AI-security controls + audit extension), 17 (E9-S4 → DONE + Phase 4 note),
18_DECISIONS (ADR-019 Phase 4 implementation note), 19_CHANGELOG (Phase 4 entry). `12_Technical`
untouched (no new tooling/patterns), `13_Testing`, `14_Deployment`, `16_Glossary` unchanged
(no relevant vocabulary/runbook change).

## 12. Explicit confirmation — NOT implemented

Per ADR-019 frozen boundaries, **none** of the following were implemented: deterministic final
verification engine (E9-S5 — decision fields stay `null`), weather correlation, pHash /
duplicate-image / fraud detection (E9-S6 remainder), `POST /claims/calculate-area` overlap checks
(E9-S3), any public assessment/verification endpoint (§18 — internal service only), frontend claim
UI (E9-S8), admin UI, admin override/compensation flows, and any severity→acreage conversion (P4 —
claimed area remains backend-derived from geometry only). No live-Gemini smoke test mechanism was
invented (§22 — mock seam + unit tests as in prior phases).

## 13. Deferred / blockers

None. The evidence `aiAssessment` field on `ClaimEvidence` (07 §7) remains reserved for E9-S6;
per-image observations are stored in `ClaimAssessment.aiImageAssessments` as specified.

## 14. READY FOR REVIEW: **YES**

No commit, push, or deployment was performed. The working tree contains exactly the intended
Phase 4 change set: 6 docs modified, 1 model modified, 4 new service/test/const files
(`git status --short` shows only these).