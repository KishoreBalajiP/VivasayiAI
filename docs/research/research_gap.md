# Research gap analysis

Basis: abstracts and metadata of 45 verified sources plus three web documents, searched 2026-10-16. Conservative by design. "Not found" means not found in this search.

## What has been done (supported by verified sources)

- Sentinel-2 NDVI and pre/post differencing are used to map crop damage [ursu2025], to design area indices for insurance [okeyo2020], and for parcel-level declaration monitoring in the EU [sitokonstantinou2018].
- Satellite yield estimation can track ground measures on smallholder plots [lobell2020; burke2017].
- Basis risk is a recognised problem in index insurance, and resolution and timing affect it [kolle2021; dalhaus2016; carter2017]. Trust and take-up are barriers in India [cole2013].
- Cloud masks of Sentinel-2 L2A need validation and benchmarks exist [baetens2019; raiyani2021; aybar2022].
- Agricultural RAG with domain constraints [ravindran2026] and deployed personalised farmer chatbots [singh2024] exist. Voice advisory in India has been evaluated [cole2021].
- General document-understanding and VLM methods exist [kim2022; xu2020; gemini2023]; VLMs are weak on fine-grained agricultural recognition [shinoda2025].
- Arguments for interpretable decision rules in high-stakes settings [rudin2019] and hallucination risks [ji2023].

## What remains open (from this search)

- No verified work on verifying crop-loss claims by fusing photo, document, satellite and weather components under a required-component gate.
- No verified work on cross-farmer polygon overlap as a fraud signal in crop insurance.
- No verified Tamil-language agricultural RAG or Tamil/Latin land-document name matching study.
- No verified evaluation of 10 m Sentinel-2 NDVI evidence on small Tamil Nadu parcels.
- No labelled public dataset of Indian claim outcomes was found.

## Candidate contributions

| Candidate | Status | Notes and narrower framing |
|---|---|---|
| Per-claim NDVI pre/post evidence over the farmer's polygon with SCL masking | **Unsupported as a contribution**; defensible as an engineering implementation | Pre/post dNDVI is established [ursu2025]. Not validated live, so no performance claim is possible. Narrower framing: a case study measuring how often usable cloud-free pre and post scenes exist for Tamil Nadu parcels and how timing changes dNDVI, once data exist. |
| Required-component evidence-fusion gate with explicit per-component outcomes | **Defensible as a design**; effectiveness unsupported | I found no directly comparable verified paper, but my search was narrow. Frame as a design with auditability properties; to claim improvement, compare with single-signal baselines on labelled claims. |
| Model output treated as evidence only, deterministic decision | Defensible as a design rationale [rudin2019; ji2023] | Not a novel idea; cite the rationale. Benefit on accuracy is unmeasured. |
| Cross-farmer overlap detection | **Unsupported as a research contribution** today | Geometric overlap is standard GIS; I found no insurance-fraud paper on it, but absence in my search is weak evidence. Review-signal-only status is appropriate. Narrower framing: evaluation on synthetic injected duplicates for recall; no fraud-prevalence claim. |
| Land-document extraction with Tamil/Latin name matching | Defensible as an applied system component; novelty not established | Donut/LayoutLM cover general extraction [kim2022; xu2020]. Needs an annotated Tamil document set to claim accuracy. |
| Provenance-tagged, slot-gated, per-farmer context retrieval for chat | Defensible as a design; benefit unmeasured | Related to AgroLLM and FarmerChat [ravindran2026; singh2024], which differ in mechanism (not fully read). Narrower framing: ablation against plain RAG on a bilingual expert-rated set. |
| Tamil and English support | Not a contribution by itself | Provision of language support is not shown to be new; evaluation of Tamil quality is absent. |
| Integrated end-to-end system | Defensible only as a system description or case study | Individual parts have precedent; the integration lacks any outcome data. Do not call it superior to anything. |

## Statements that cannot be made

- That the system is first, novel or best in any respect.
- Any accuracy, fraud-detection or loss-estimation figure for Vivasayi AI (no labelled data, no live satellite validation).
- That PMFBY uses or requires any specific technology (guideline text was not read).
- That official Tamil Nadu land-record verification is performed (no authorised API exists; the adapter is provider-neutral only).

## Next steps that would create defensible claims

Collect field-verified claim labels; run the Sentinel-2 path live and report mask and timing sensitivity; build bilingual expert-rated question and Tamil land-document test sets; run the ablations in `base_paper_selection.md`.
