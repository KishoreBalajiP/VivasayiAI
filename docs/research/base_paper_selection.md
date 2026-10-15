# Base paper selection

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
