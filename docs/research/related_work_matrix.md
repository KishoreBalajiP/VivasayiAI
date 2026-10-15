# Related work matrix

Entries come from abstracts or metadata only (see `literature_review.md`). "Not stated" means the abstract I read does not say; it does NOT mean the paper lacks it. Vivasayi AI's column reflects what is implemented, with caveats.

Legend: Yes (stated in abstract) / No (my reading of the abstract indicates it is outside the paper's scope, inferred) / Not stated / Partial.

| Work | Context retrieval | Document verification | Parcel/geometry validation | Cross-claim overlap | Satellite evidence | Deterministic/auditable fusion | Evaluation on real data |
|---|---|---|---|---|---|---|---|
| Ursu 2025 [ursu2025] | No | No | Not stated | No | Yes (Sentinel-2 dNDVI + radar) | No | Yes (two real hail events; no claim-level labels stated) |
| Ravindran 2026 AgroLLM [ravindran2026] | Yes (RAG over textbooks; no farmer records stated) | No | No | No | No | Partial (rule/threshold validation layer) | Benchmark of 504 questions; not farmer data |
| Singh 2024 FarmerChat [singh2024] | Yes (personalised/contextual stated; mechanism not stated) | No | No | No | No | No | Yes (deployment, 15,000+ farmers claimed) |
| Okeyo 2020 [okeyo2020] | No | No | No (8 km grid) | No | Yes (Sentinel-2 NDVI) | No | Real imagery; payout validation not stated |
| Murmu 2025 [murmu2025] | No | No | No | No | Yes (satellite data in actuarial model) | No | Not stated |
| Kolle 2021 [kolle2021] | No | No | Field vs farm level contracts | No | Yes (MODIS, Landsat NDVI) | No | Yes (three German farms) |
| Sitokonstantinou 2018 [sitokonstantinou2018] | No | No | Parcel-based classification | No | Yes (Sentinel-2 time series) | No | Yes (Navarra parcels; kappa 0.87) |
| Lobell 2020 [lobell2020] | No | No | Plot-level | No | Yes | No | Yes (Uganda plots) |
| Kim 2022 Donut [kim2022] | No | Extraction only (not verification against claims) | No | No | No | No | Benchmarks (not land records) |
| Shinoda 2025 AgroBench [shinoda2025] | No | No | No | No | No | No | Benchmark (expert-annotated) |
| Rudin 2019 [rudin2019] | No | No | No | No | No | Argues for interpretable models (metadata only) | Not applicable |
| **Vivasayi AI (current)** | Yes (per-request, provenance-tagged; not benchmarked) | Yes (Gemini extraction + comparison; no accuracy measured) | Yes (server validation, area; correctness tests only) | Yes (within and across farmers, review signal only) | Built, not validated live | Yes (rule engine + required-component gate) | **No** (no labelled claims, no live satellite run) |

Reading the table: the combination in the last row is not matched by any single verified work in this review, but this reflects the limits of my search (about 45 sources, abstract level) rather than proof that no such system exists. Each individual capability has precedent; none of Vivasayi AI's capabilities currently has empirical support from its own data.
