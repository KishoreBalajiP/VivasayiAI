# Base paper selection

## Second-pass decision (2026-10-16, after reading full texts)

The full texts of Ursu 2025, Ravindran 2026 (AgroLLM) and Singh 2024 (Farmer.Chat) were read. Okeyo 2020 and Carter 2017 stayed abstract-only (403 and paywall). 26 sources were added. The original selection below is **kept, with three changes**.

| Role | Decision | Change from first pass | Justification from full text |
|---|---|---|---|
| **Claim-side base paper (satellite operation)** | **Ursu et al. 2025** [ursu2025], confirmed | None, but its use is narrowed | It performs exactly Vivasayi AI's operation: pre/post Sentinel-2 dNDVI with fixed 0.10/0.20 thresholds, and it measures how the post-event date changes the answer (Table 4). It is a *method* baseline, **not an accuracy baseline**: the authors state "the lack of direct ground validation". It uses L1C with scene-level cloud selection where Vivasayi AI uses L2A with SCL pixel masking, and its abstract's Dolhasca areas contradict Table 4. Cite the table values. |
| **Claim-side base paper (evidence fusion)** | **Chakraborty et al. 2021** [chakraborty2021], **new** | Added as co-base | An Indian, insurance-motivated, **deterministic decision matrix** fusing NDVI vigour strata with Sentinel-1 change into affected, marginal and normal classes, *with* a reported accuracy (OA 84.12%, kappa 0.74). It is the closest verified precedent for a rule-based evidence-fusion step. Abstract only, so its thresholds must be re-read in full before reproducing them. |
| **Assistant-side base paper** | **Ravindran et al. 2026, AgroLLM** [ravindran2026], confirmed | Comparison sharpened | The closest agricultural RAG with a deterministic validation layer (DKPL). Full text shows it **falls back to the LLM's parametric knowledge when retrieval fails**. Vivasayi AI's context-sufficiency gate is designed to do the opposite (ask or abstain), with Joren et al. 2025 [joren2025] as the conceptual basis. The 504 questions come from the same textbooks as the corpus, and grading is lightly specified, so its 95.2% is not a comparable baseline number. |
| Deployed comparator | Singh et al. 2024, Farmer.Chat [singh2024], kept | Demoted from "base" to "comparator" | A preprint, and its quality metrics are LLM-judged (RAGAS). It is useful for deployment-scale context and for its "out of context / out of content" failure taxonomy (66% / 23% of unanswered queries). |
| Insurance-context anchor | **Ceballos et al. 2019 (PBI)** [ceballos2019] plus the **YES-TECH manual** [mncfc2023yestech] | **Replaces** Okeyo 2020 / Carter 2017 as the anchor | Both are India-specific and concern *claim verification evidence*. PBI is farmer smartphone photos (damage visible at 71% of affected sites vs at most 34% for index products). YES-TECH is the official 70/30 CCE/model blend at Insurance Unit level. Okeyo (an area-index trigger with no loss validation) and Carter (an economics review, abstract only) are kept as background citations only. |

**Recommended 1-3 foundational papers for the write-up (revised):**

1. **Ursu 2025 + Chakraborty 2021** as the claim-verification pair: one gives the method, the other gives the decision-matrix fusion with accuracy.
2. **Ravindran 2026 (AgroLLM)**, contrasted with **Joren 2025** for the sufficiency gate.
3. **Ceballos 2019** for the Indian claim-verification context.

**Why not pick a single base paper:** none of the ~70 sources combines conversational advisory with claim adjudication. An IEEE reviewer will ask "what is the baseline?". The honest answer is one baseline per component, plus an internal ablation (the v1 photo-only policy vs the v2 fusion gate, already in `evaluation/results/fusion.json`).

**Additional limitations Vivasayi AI could investigate, from the second pass:**

- Single pre/post delta vs a time-integrated metric. Ha et al. 2022 [ha2022] found the 32-day AUC of NDVI correlated with field damage (r up to -0.90). This can be tested on the live case-study areas without labels, as a *sensitivity* analysis only.
- Parcel size vs 10 m pixels. SICKLE [sani2024] plots average 0.38 acre (about 1,540 m², about 15 Sentinel-2 pixels), so valid-pixel counts after SCL masking should be reported for every case.
- Cloud during the monsoon and cyclone season. Every Indian cyclone study found [chakraborty2021; bhatt2026] uses Sentinel-1 SAR. Vivasayi AI's optical-only path should be expected to return `inconclusive` often. In the 2026-10-16 live run, 3 of 12 areas returned `inconclusive` with "no valid statistics" in the post-event window. All 3 were in post-monsoon event windows (south Tamil Nadu floods, Cyclone Fengal) whose scene cloud fractions were mostly above 0.5. Masking is the likely cause, but the run did not record it per area.

---

*(First-pass text follows, unchanged.)*

Evidence basis: all selections rest on abstracts or metadata retrieved 2026-10-16, not full text (see `literature_review.md`). Before committing to any as a formal baseline, the full text must be read.

## Statement

No single verified paper covers the whole system. I select one primary paper per component and rank them.

| Component | Primary paper | Why |
|---|---|---|
| Satellite pre/post NDVI evidence | Ursu et al. 2025 [ursu2025] | Same core operation (pre/post-event NDVI difference with fixed thresholds on Sentinel-2) applied to crop damage, and the abstract exposes timing sensitivity. |
| Retrieval-augmented advisory with output validation | Ravindran et al. 2026 AgroLLM [ravindran2026] | Agricultural RAG with explicit thresholds/rules and a 504-question benchmark; closest to a reproducible protocol. |
| Personalised deployed agri chatbot | Singh et al. 2024 FarmerChat [singh2024] | Deployed personalised advisory; preprint, so weaker. |
| Document extraction | Kim et al. 2022 Donut [kim2022] | Defines the OCR-free reading approach and its stated motivations; general documents only. |
| Satellite cloud-mask choice | Baetens et al. 2019 [baetens2019] with CloudSEN12 [aybar2022] | Validation methodology and a benchmark dataset. |

**Recommended 1-3 foundational papers for the write-up:** (1) Ursu 2025, (2) Ravindran 2026, (3) Okeyo and Mulaku 2020 / Carter et al. 2017 pair as the insurance-context anchor. Of these, Ursu 2025 is the most directly relevant to the claim-verification side, which is the more distinctive half of the system.

## Limitations Vivasayi AI could credibly investigate

1. Sensitivity of NDVI change evidence to post-event image timing and cloud masking on small Tamil Nadu parcels. Ursu's abstract reports timing effects; whether the same holds for Tamil Nadu crops is untested.
2. Reliability of the SCL-based mask on parcels of a few hundred square metres (mixed pixels, edge effects). Raiyani 2021 reports Sen2Cor weaknesses in its dataset.
3. Whether adding provenance tags and slot-gated clarification changes answer quality versus plain RAG (AgroLLM tested knowledge constraints, not provenance of per-farmer data).
4. Whether a fusion gate with explicit per-component outcomes reduces wrongly auto-approved claims relative to a single-signal rule. No labelled data exists yet, so this needs data collection first.
5. Tamil/Latin name matching accuracy on land documents (no verified prior work found).

## Reproducible ideas (with what is needed)

- Pre/post dNDVI thresholding at 0.10 and 0.20 (Ursu abstract): reproducible with Sentinel-2 L2A and a threshold sweep; their hail-radar input has no Indian equivalent used here.
- Cloud-mask comparison using CloudSEN12 labels: reproducible; dataset is public per its abstract.
- RAG evaluation with a domain question set: reproducible for a Tamil/English set if one is authored by agronomists; AgroLLM's 504-question set itself was not checked for availability.

## Experiments needed to support any improvement claim

- **Satellite:** a set of claims with ground-truth (field-verified damage, date and cause), at least dozens per class, stratified by crop, season and cloud cover; report precision/recall against inspector outcomes, with confidence intervals, plus ablations over mask on/off, thresholds and image-timing window.
- **Fusion gate:** the same labelled claims, comparing the gate to each single component and to an ML baseline; report false-approve and false-reject rates and the share routed to manual review. Inter-rater agreement among inspectors is needed to know the ceiling.
- **Overlap detection:** synthetic injected duplicates (known polygons shifted/scaled) for recall of the geometric method; real fraud rates cannot be claimed without labels.
- **Documents:** annotated Tamil land documents, field-level exact/fuzzy match accuracy, and a name-matching test set with transliteration variants.
- **Assistant:** a bilingual question set with expert-rated answers, comparing (a) plain LLM, (b) RAG, (c) RAG with context and provenance; human-rated correctness, groundedness and unnecessary follow-up rate; ideally a small user study with farmers.
- Report all with fixed seeds/model versions, since Gemini and Cohere outputs can change across model versions.
