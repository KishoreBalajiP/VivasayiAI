# Related work matrix

Entries come from the sources described in `literature_review.md`. The first pass read abstracts and metadata only. The second pass (2026-10-16) read full text where the "Read" column says `full`. "Not stated" means the text I read does not say; it does NOT mean the paper lacks it. Vivasayi AI's row reflects what is implemented, with caveats.

Legend: Yes (stated in what I read) / No (outside the paper's scope, inferred from what I read) / Not stated / Partial.

## A. Original matrix (rows for the priority papers updated from full text)

| Work | Read | Context retrieval | Document verification | Parcel/geometry validation | Cross-claim overlap | Satellite evidence | Deterministic/auditable fusion | Evaluation on real data |
|---|---|---|---|---|---|---|---|---|
| Ursu 2025 [ursu2025] | full | No | No | Area mapping inside a radar mask; per-parcel stats on land-use polygons | No | Yes (Sentinel-2 **L1C** dNDVI at 0.10/0.20; scene-level cloud < 5%) + radar HKE | Partial (fixed thresholds inside a hazard mask; no decision rule) | Two real hail events; **no ground validation** (authors' stated limitation) |
| Ravindran 2026 AgroLLM [ravindran2026] | full | Yes (RAG over 19 textbooks; falls back to parametric knowledge when nothing is retrieved) | No | No | No | No | Partial (DKPL rule/threshold checker with regeneration loop) | 504 textbook-derived questions; grading lightly specified; no farmers |
| Singh 2024 Farmer.Chat [singh2024] | full | Yes (query rephrasing from chat history; crop, location, weather context) | No | No | No | No | No | Yes (deployment: 15,000+ users, 300,000+ queries; RAGAS LLM-judged faithfulness; focus groups) |
| Okeyo 2020 [okeyo2020] | abstract | No | No | No (8 km grid) | No | Yes (Sentinel-2 NDVI, one insurance year vs one reference year) | Partial (trigger rule: Ap - Ar < 0) | Real imagery; 30 of about 85 farms would qualify; no loss validation stated |
| Carter 2017 [carter2017] | abstract | No | No | No | No | No (mentions "measurement technology") | No | Review article |
| Murmu 2025 [murmu2025] | abstract | No | No | No | No | Yes (satellite data in actuarial model) | No | Not stated |
| Kolle 2021 [kolle2021] | abstract | No | No | Field vs farm level contracts | No | Yes (MODIS, Landsat NDVI) | No | Yes (three German farms) |
| Sitokonstantinou 2018 [sitokonstantinou2018] | abstract | No | No | Parcel-based classification | No | Yes (Sentinel-2 time series) | No | Yes (Navarra parcels; kappa 0.87) |
| Lobell 2020 [lobell2020] | abstract | No | No | Plot-level | No | Yes | No | Yes (Uganda plots) |
| Kim 2022 Donut [kim2022] | abstract | No | Extraction only (not verification against claims) | No | No | No | No | Benchmarks (not land records) |
| Shinoda 2025 AgroBench [shinoda2025] | abstract | No | No | No | No | No | No | Benchmark (expert-annotated) |
| Rudin 2019 [rudin2019] | metadata | No | No | No | No | No | Argues for interpretable models | Not applicable |

## B. Rows added in the second pass

| Work | Read | Context retrieval | Document verification | Parcel/geometry validation | Cross-claim overlap | Satellite evidence | Deterministic/auditable fusion | Evaluation on real data |
|---|---|---|---|---|---|---|---|---|
| Ceballos 2019 PBI [ceballos2019] | abstract | No | No | Insured plot photographed | No | No (smartphone photos, about one per growth stage) | No (human loss assessment) | Yes (India pilot; damage visible at 71% of affected sites vs at most 34% for index products) |
| YES-TECH manual 2023 [mncfc2023yestech] | full (parts) | No | No | IU-level (not per farmer) | No | Yes (modelled yields) | Yes (fixed 70% CCE / 30% model blend; nRMSE > 30% excluded) | Government procedure, not an evaluation |
| NRSC smart sampling 2019 [murthy2019smart] | full (parts) | No | No | Cadastral overlay for CCE field selection | No | Yes (20 m yield proxy: NDVI, LSWI, cross-pol ratio) | Partial (stratified sampling rule) | Operational in Odisha 2018-19; accuracy not read |
| Ha 2022 [ha2022] | abstract | No | No | Field-level (54 fields) | No | Yes (Sentinel-2 delta and 32-day AUC indices) | No | **Yes, field ground truth** (r = -0.90 canola, -0.86 wheat, 0.80 lentil) |
| Chakraborty 2021 [chakraborty2021] | abstract | No | No | Crop map (85%) | No | Yes (Sentinel-2 NDVI vigour + Sentinel-1 VH change) | **Yes (decision matrix)** | Yes (OA 84.12%, kappa 0.74; Cyclone Amphan, India) |
| Bocchino 2025 [bocchino2025] | abstract | No | No | Field-level (412 fields) | No | Yes (Sentinel-2 indices + flood extent + topography) | No (Random Forest) | **Yes, agronomist labels** (OA 0.74; weak on no vs medium damage) |
| Kanjir 2018 [kanjir2018] | abstract | No | Declared use vs observed | Parcel NDVI profiles | No | Yes (Sentinel-2, BFAST) | Partial (anomaly, then field control) | Yes (Slovenian field controls; numbers not in abstract) |
| Sani 2024 SICKLE [sani2024] | abstract | No | No | Plot-level labels (mean 0.38 acre) | No | Yes (L8, S1, S2) | No | Dataset (Tamil Nadu Cauvery Delta; no damage labels) |
| Didwania 2024 AgriLLM [didwania2024] | full | No (seq2seq; no retrieval) | No | No | No | No | No | Yes (about 4M Tamil Nadu KCC queries; BLEU/ROUGE only) |
| Rehman 2023 KisanQRS [rehman2023] | abstract | Yes (retrieval over KCC logs; no generation) | No | No | No | No | No | Yes (KCC; F1 96.58% query mapping, NDCG 96.20%) |
| Vijayvargia 2025 Krishi Sathi [krishisathi2025] | abstract | Yes (multi-turn slot collection, then RAG) | No | No | No | No | No | Reported 97.53% accuracy (design not read) |
| Fanuel 2025 AgriRegion [agriregion2025] | abstract | Yes (region-aware re-ranking, geospatial metadata) | No | No | No | No | No | 160-question benchmark; 10-20% fewer hallucinations |
| Joren 2025 Sufficient Context [joren2025] | abstract | Yes (sufficiency autorater; guided abstention) | No | No | No | No | Partial (selective generation rule) | General QA benchmarks; not agriculture |
| Balaguer 2024 [balaguer2024] | abstract | Yes (RAG vs fine-tune) | No | No | No | No | No | GPT-4-judged; +6 p.p. fine-tune, +5 p.p. RAG |
| Raji 2020 [raji2020] | abstract | No | No | No | No | No | Audit framework (process, not a decision engine) | Not applicable |

## C. Vivasayi AI

| Work | Context retrieval | Document verification | Parcel/geometry validation | Cross-claim overlap | Satellite evidence | Deterministic/auditable fusion | Evaluation on real data |
|---|---|---|---|---|---|---|---|
| **Vivasayi AI (current)** | Yes (per-request farmer records, provenance tags, context-sufficiency gate; specification-scored only, no expert-rated answers) | Yes (Gemini extraction compared with the claim; advisory only; no accuracy measured) | Yes (server validation, area; analytic tests) | Yes (within and across farmers; review signal only; synthetic tests) | Sentinel-2 **L2A** with SCL pixel masking via CDSE Statistical API. Small live case studies on 2026-10-16: 3 Tamil Nadu events plus 1 control, 12 areas (9 analysis complete, 3 inconclusive), **no ground-truth labels** | Yes (versioned rule engine, required-component gate, hold semantics, manual review) | **No labelled claims.** Synthetic benchmarks and live API case studies only |

## Reading the table

- No single verified work combines the Vivasayi AI row. This reflects the limits of my search (now about 70 sources, mostly abstract-level), not proof that no such system exists.
- **Every individual capability has precedent.** Decision-matrix fusion of satellite evidence [chakraborty2021], declaration checking against parcel imagery with field follow-up [kanjir2018; sitokonstantinou2018], farmer photos for claim verification [ceballos2019], slot-gated multi-turn clarification [krishisathi2025], context-sufficiency abstention [joren2025], and region-aware grounding [agriregion2025].
- The papers that **do** report accuracy against ground truth [ha2022; chakraborty2021; bocchino2025; ceballos2019] all had field labels. Vivasayi AI has none. A paper can therefore present it only as a system design with conformance tests and feasibility case studies, not as a validated verifier.
