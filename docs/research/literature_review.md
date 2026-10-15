# Literature review: Vivasayi AI

**Search date:** 2026-10-16.
**Tools used:** Crossref REST API (bibliographic search and DOI records), doi.org content negotiation (CSL-JSON and BibTeX, used to generate `references.bib`), Semantic Scholar Graph API (abstracts), arXiv abstract pages (abstracts), direct HTTP fetches of the Copernicus Data Space, Open-Meteo and PMFBY web pages. No library full-text access was available.

## Evidence level (read this first)

- **Every paper below was verified**: title, first authors, year and venue were matched against a DOI record fetched in this session.
- **Full text was NOT read for any paper.** The "Read" tag on each entry says what I actually saw:
  - `abstract`: the abstract was retrieved and the reported results come from it only.
  - `metadata`: only the bibliographic record was retrieved. For these I describe the paper only at the level its title supports and give no results.
- Numbers quoted are from abstracts only. Statements about "limitations" are either stated in the abstract or are my own inferences, marked "(inferred)".
- Three web documents (CDSE Statistical API, Open-Meteo Historical API, PMFBY portal) were fetched, but only page titles, headings or short statements were read. The PMFBY portal fetch did not yield scheme guidelines, so I make no claim about PMFBY rules.

## What Vivasayi AI does (scope used for relevance)

Context-aware chat assistant (intent classification, per-request retrieval of the farmer's own records, Open-Meteo weather, Cohere+ChromaDB RAG, provenance tags, slot-gated follow-ups, Tamil and English). Crop-loss claim verification: polygon on registered parcel with server-side geometry checks, Gemini photo assessment as evidence only, deterministic rule engine, Gemini land-document extraction compared with claim, within-farmer and cross-farmer overlap detection, Sentinel-2 NDVI via CDSE Statistical API with SCL masking (built, not validated live), rainfall as supporting evidence, a required-component fusion gate. No official Tamil Nadu land-record API. No labelled claim dataset.

---

## 1. Satellite remote sensing, NDVI, change detection, cloud masking

**1.1 Drusch et al. (2012), Sentinel-2 mission** [drusch2012]. *Read: metadata.* Remote Sensing of Environment 120. Describes ESA's Sentinel-2 optical mission (title). Relevance: the standard citation for the sensor whose L2A products and SCL layer Vivasayi AI consumes. No results to report from what I read.

**1.2 Tucker (1979), red/near-infrared linear combinations** [tucker1979]. *Read: metadata.* RSE 8. Classic reference for vegetation monitoring with red/NIR band combinations (title). Relevance: background for NDVI. Limitation (inferred): predates Sentinel-2 and says nothing about claim verification.

**1.3 Zhu and Woodcock (2012), Fmask** [zhu2012]. *Read: metadata.* RSE 118. Object-based cloud and cloud-shadow detection for Landsat (title). Relevance: lineage of cloud masking; Vivasayi AI uses the Sentinel-2 SCL instead, not Fmask.

**1.4 Main-Knorn et al. (2017), Sen2Cor** [mainknorn2017]. *Read: metadata.* SPIE Image and Signal Processing for Remote Sensing XXI. Describes the Sen2Cor processor (title). Relevance: Sen2Cor produces the Level-2A scene classification (SCL) that the platform's masking relies on (my inference from the SCL naming; not read in the source).

**1.5 Baetens, Desjardins, Hagolle (2019), validation of S2 cloud masks** [baetens2019]. *Read: abstract.* Remote Sensing 11(4):433.
- Problem: validate the operational Level-2A cloud mask. Method: an Active Learning Cloud Detection tool built to create reference masks; 32 reference masks over 10 sites used to compare MAJA, Sen2Cor and FMask (abstract). ALCD overall accuracy above 98% against visual criteria and manual masks (abstract).
- Limitation: abstract truncated in my retrieval, so the processor comparison results were not read. Reference set is small (32 masks).
- Relevance: justifies treating cloud masks as imperfect and validating them; Vivasayi AI has not done this for its Indian parcels.

**1.6 Raiyani et al. (2021), Sen2Cor vs ML scene classification** [raiyani2021]. *Read: abstract.* Remote Sensing 13(2):300. Manually labelled Sentinel-2 dataset, six classes; ML model Micro-F1 0.84 versus Sen2Cor 0.59 (abstract). Limitation: single labelled dataset; geography not stated in the abstract I read. Relevance: direct evidence that Sen2Cor-style classes can be unreliable, which is a risk for an SCL-based mask on small parcels.

**1.7 Aybar et al. (2022), CloudSEN12** [aybar2022]. *Read: abstract.* Scientific Data 9. Global dataset of 49,400 image patches with cloud and shadow annotations and results of eight cloud detection algorithms (abstract). Relevance: a ready benchmark for evaluating the platform's mask choice on Tamil Nadu tiles.

**1.8 Weiss, Jacob, Duveiller (2020), RS for agriculture meta-review** [weiss2020]. *Read: abstract (partial).* RSE 236. Overview of remote sensing techniques, retrievable agronomic variables and approaches. Relevance: background framing. Does not address claim adjudication.

**1.9 Sishodia, Ray, Singh (2020), RS in precision agriculture** [sishodia2020]. *Read: abstract.* Remote Sensing 12(19):3136. Review covering monitoring, irrigation, nutrients, pests and yield prediction. Relevance: background; precision-agriculture focus rather than insurance.

**1.10 Gorelick et al. (2017), Google Earth Engine** [gorelick2017]. *Read: metadata.* RSE 202. Platform paper. Relevance: an alternative processing route; Vivasayi AI uses CDSE Statistical API instead.

**1.11 Kussul et al. (2017), DL land cover and crop types** [kussul2017]. *Read: metadata.* IEEE GRSL. Deep learning classification of land cover and crop types (title). Relevance: crop-type mapping that could, in future work, check a claimed crop; not implemented.

**1.12 Ursu, Istrate, Jitariu (2025), hail damage with Sentinel-2 and radar** [ursu2025]. *Read: abstract.* Remote Sensing 17(23):3850.
- Problem: landscape-scale hail damage. Method: radar hail kinetic energy (threshold 300 J m-2) delineates candidate areas; Sentinel-2 L1C pre/post-event NDVI differences with thresholds 0.10 (moderate) and 0.20 (severe).
- Data: two Romanian events (2016, 2020). Results: strong spatial correspondence between radar cores and dNDVI reductions; affected area estimates shrank with later post-event images (for example 6200-9100 ha at 5 days to 3100-5600 ha at 15 days for one event).
- Limitation: abstract reports spatial correspondence, not accuracy against ground-truth claims; sensitivity to post-event image timing is explicit.
- Relevance: closest published analogue to a pre/post NDVI difference with fixed thresholds. It also warns that timing changes the answer, which applies directly to Vivasayi AI's design. Their thresholds were tuned to Romanian crops and cannot be assumed for Tamil Nadu.

## 2. Agricultural insurance, crop-loss assessment, PMFBY

**2.1 PMFBY portal** [pmfby_portal]. *Read: page reachable only.* Government of India scheme site. I did not retrieve guideline text, so I make no statement on its technology provisions. See Unverified leads.

**2.2 Murmu and Mahadik (2025), remote sensing data in crop insurance, India** [murmu2025]. *Read: abstract.* Asia-Pacific J. of Risk and Insurance 19. Proposes a framework combining crop details, satellite data and an actuarial yield model, with kernel density estimation for risk; argues that bandwidth heuristics can mislead; motivates by fragmented, low-quality, costly data in India (abstract). Limitation: aimed at insurer yield/risk modelling, not individual claim verification; evaluation details not in the abstract. Relevance: India-specific support for the data-scarcity problem.

**2.3 Murthy, Poddar, Choudhary et al. (2022), RS-based crop insurance for jute, India** [murthy2022]. *Read: metadata.* RSASE 26:100717. Title indicates remote-sensing-based insurance for jute in India. Relevance: Indian precedent; no results read.

**2.4 Okeyo and Mulaku (2020), satellite crop insurance, Migori, Kenya** [okeyo2020]. *Read: abstract.* Advances in Remote Sensing 9. Sentinel-2 imagery from May 2017 classified, NDVI computed, 8 km x 8 km grid averaged, for index-based insurance for maize (abstract). Limitation: very coarse 8 km grid (basis risk), single season in the abstract. Relevance: shows area-index design, the opposite of Vivasayi AI's per-claim polygon.

**2.5 Masiza, Chirima, Hamandawana (2022), satellite-based insurance for smallholder maize** [masiza2022]. *Read: abstract.* Remote Sensing 14(6):1512. Compares TAMSAT and CHIRPS rainfall estimates; CHIRPS better at 20-day and monthly steps; builds trigger/exit/tick payout thresholds from a crop water requirement model (abstract). Limitation: rainfall-index product, South Africa. Relevance: rainfall as an insured index; Vivasayi AI uses rainfall only as supporting evidence.

**2.6 Kolle, Buchholz, Musshoff (2021), field-level satellite indices and basis risk** [kolle2021]. *Read: abstract.* Agricultural Finance Review 82. MODIS (250 m) vs Landsat (30 m) NDVI for winter wheat, three German farms; higher resolution reduced basis risk, yet field-level contracts did not beat farm-level (abstract). Relevance: evidence that finer resolution helps but is not a guarantee. Small sample (three farms).

**2.7 Dalhaus and Finger (2016), gridded data and phenology in weather index insurance** [dalhaus2016]. *Read: abstract.* Weather, Climate, and Society 8. German wheat; no difference between gridded and station precipitation; phenological observations significantly raised expected utility (abstract). Relevance: timing of the index window matters; the platform's fixed pre/post windows may inherit this issue (inferred).

**2.8 Carter, de Janvry, Sadoulet, Sarris (2017), index insurance reassessment** [carter2017]. *Read: abstract.* Annual Review of Resource Economics 9. Take-up of index insurance remains low without subsidies; better contract design, measurement technology and bundling can help (abstract). Relevance: economic context for why technology-assisted indemnity verification is of interest.

**2.9 Cole, Gine, Tobacman et al. (2013), barriers to risk management, India** [cole2013]. *Read: abstract.* AEJ: Applied 5(1). Randomised experiments on rainfall insurance in rural India; demand is price-sensitive, but trust, liquidity and salience frictions limit take-up (abstract). Relevance: trust is a stated barrier, supporting the case for transparent, explainable decisions.

**2.10 Lobell et al. (2020), eyes in the sky, boots on the ground** [lobell2020]. *Read: abstract.* AJAE. Uganda maize: farmer-reported, sub-plot and full-plot crop-cut yields differ widely; satellite yield measures explained as much or more variation in full-plot yields than farmer-reported or sub-plot measures (abstract). Relevance: supports using satellite evidence next to, not in place of, ground evidence; also shows farmer-reported figures are noisy.

**2.11 Burke and Lobell (2017), satellite yield variation, Kenya** [burke2017]. *Read: abstract.* PNAS 114. High-resolution imagery with field data from thousands of smallholder plots shows field-scale yield variation can be estimated (abstract). Relevance: feasibility for small fields, but with commercial high-resolution imagery rather than 10 m Sentinel-2.

## 3. Geospatial parcel validation and duplicate/overlap detection

**3.1 Sitokonstantinou, Papoutsis, Kontoes et al. (2018)** [sitokonstantinou2018]. *Read: abstract.* Remote Sensing 10(6):911. Parcel-based Sentinel-2 crop identification for monitoring EU CAP obligations in a smallholder zone in Navarra; SVM best at the lowest nomenclature level with Cohen's kappa 0.87 (abstract). Relevance: parcel-level Sentinel-2 checking of declarations is an established idea in the EU subsidy context. It tests declared crop type, not overlap between claimants.

**Gap:** my searches (including "duplicate claim detection geospatial overlap polygon") returned no verified paper on cross-claimant polygon overlap as a fraud signal in crop insurance. This is a search result, not proof of absence. See Unverified leads.

## 4. AI-assisted document extraction and verification

**4.1 Xu et al. (2020), LayoutLM** [xu2020]. *Read: abstract (arXiv version).* KDD 2020. Joint modelling of text and layout for document image understanding, applicable to information extraction from scanned documents (abstract).

**4.2 Kim et al. (2022), Donut** [kim2022]. *Read: abstract.* ECCV 2022 (LNCS). OCR-free document understanding; motivated by OCR cost, inflexibility across languages and error propagation (abstract). Relevance: the OCR-free framing resembles Vivasayi AI's use of a VLM to read documents directly.

**4.3 Mathew, Karatzas, Jawahar (2021), DocVQA** [mathew2021]. *Read: metadata.* WACV 2021. Dataset for visual question answering on document images (title). Relevance: a candidate benchmark style; no Tamil land-record content is implied.

**Limitation across 4.1-4.3:** none of these (from what I read) addresses Tamil land records, Tamil/Latin name matching, or checking an extraction against a claim. No verified source for that task was found.

## 5. Vision-language models for agricultural evidence

**5.1 Shinoda, Inoue, Kataoka et al. (2025), AgroBench** [shinoda2025]. *Read: abstract.* ICCV 2025. Expert-annotated benchmark across seven agricultural topics, 203 crop and 682 disease categories; VLMs show room for improvement in fine-grained identification, and most open-source VLMs performed close to random on weed identification (abstract). Relevance: evidence that VLM output on fine-grained agricultural recognition is unreliable, supporting treating Gemini output as evidence only.

**5.2 Gemini Team (2023), Gemini technical report** [gemini2023]. *Read: abstract.* arXiv:2312.11805. General multimodal model family. Relevance: the model family used by the platform; reported benchmarks are general, not agricultural or document-claim specific.

**5.3 Mohanty, Hughes, Salathe (2016), DL plant disease detection** [mohanty2016]. *Read: metadata.* Frontiers in Plant Science 7. Title indicates image-based disease detection with deep learning. **5.4 Kamilaris and Prenafeta-Boldu (2018), DL in agriculture survey** [kamilaris2018]. *Read: abstract.* Computers and Electronics in Agriculture 147. Survey of 40 research efforts; findings indicate deep learning gave high accuracy, outperforming common image-processing techniques (abstract). Limitation (inferred): about classification and regression tasks, not loss attribution (a photo of damage does not show its cause or date).

## 6. Retrieval-augmented agricultural assistants

**6.1 Lewis et al. (2020), RAG** [lewis2020]. *Read: abstract.* arXiv:2005.11401. Combines parametric and non-parametric memory; notes provenance and updating knowledge as open problems (abstract).

**6.2 Gao et al. (2023), RAG survey** [gao2023]. *Read: abstract.* arXiv:2312.10997. Reviews naive, advanced and modular RAG; names hallucination, outdated knowledge and untraceable reasoning as motivators (abstract).

**6.3 Ravindran et al. (2026), AgroLLM** [ravindran2026]. *Read: abstract.* AgriEngineering 8(1):38. RAG over nineteen agricultural textbooks plus a Domain Knowledge Processing Layer (symbolic concepts, causal rules, thresholds); 504-question benchmark; best configuration (ChatGPT-4o Mini with DKPL-constrained RAG) reached 95.2% accuracy with fewer hallucinations and numerical violations (abstract). Limitation (inferred): textbook knowledge and educational focus; no farmer-specific records or claims; benchmark is question-answering. Relevance: closest verified agricultural RAG-with-constraints work; Vivasayi AI does not apply a symbolic validation layer to chat answers.

**6.4 Singh et al. (2024), FarmerChat** [singh2024]. *Read: abstract.* arXiv:2409.08916 (preprint). Generative-AI chatbot deployed in four countries, over 15,000 farmers and over 300,000 queries; claims personalised, contextual advice and improved trust and engagement from quantitative and qualitative analysis (abstract). Limitation: preprint; abstract gives no effect sizes. Relevance: the nearest deployed analogue of a personalised agricultural chatbot.

## 7. Context-aware advisory, conversational agents, voice, low-resource languages

**7.1 Adomavicius and Tuzhilin (2011), context-aware recommender systems** [adomavicius2011]. *Read: metadata.* In Recommender Systems Handbook. General background on context in recommendation.

**7.2 Cole and Fernando (2021), 'Mobile'izing agricultural advice** [cole2021]. *Read: abstract.* Economic Journal 131. Two-year study of a voice-based advisory service for smallholder cotton farmers in India; demand and trust were significant, farmers changed information sources and adopted recommended inputs; no systematic evidence of yield or profit gains (abstract). Relevance: honest evidence that advice uptake does not equal outcome gains; any outcome claim for Vivasayi AI needs a field trial.

**7.3 Patel et al. (2010), Avaaj Otalo** [patel2010]. *Read: metadata.* CHI 2010. Field study of an interactive voice forum for small farmers in rural India (title).

**7.4 Kakwani et al. (2020), IndicNLPSuite** [kakwani2020]. *Read: metadata.* Findings of EMNLP 2020. Monolingual corpora, benchmarks and pretrained models for Indic languages (title). **7.5 Radford et al. (2022), Whisper** [radford2022]. *Read: abstract.* arXiv:2212.04356. 680,000 hours of multilingual weakly supervised data; zero-shot generalisation (abstract). Relevance: candidate speech front end; Tamil accuracy is not stated in what I read.

**Gap:** I found no verified peer-reviewed paper on a Tamil agricultural RAG assistant or Tamil agricultural question answering (see Unverified leads).

## 8. Explainable, evidence-based decision systems

**8.1 Rudin (2019)** [rudin2019]. *Read: metadata.* Nature Machine Intelligence. Title argues for interpretable models over post-hoc explanation of black boxes in high-stakes decisions. Supports a deterministic, inspectable rule engine.
**8.2 Doshi-Velez and Kim (2017)** [doshivelez2017]. *Read: metadata.* arXiv:1702.08608. Rigorous science of interpretability (title).
**8.3 Ribeiro, Singh, Guestrin (2016), LIME** [ribeiro2016]. *Read: metadata.* KDD 2016. Post-hoc explanation method.
**8.4 Ji et al. (2023), hallucination survey** [ji2023]. *Read: abstract.* ACM Computing Surveys. Reviews measurement and mitigation of hallucination in natural language generation (abstract). Relevance: justification for keeping model output out of the final decision path.

## 9. Fraud and anomaly detection

**9.1 Hilal, Gadsden, Yawney (2022)** [hilal2022]. *Read: metadata.* Expert Systems with Applications 193. Review of anomaly detection for financial fraud (title). **9.2 Ngai et al. (2011)** [ngai2011]. *Read: metadata.* Decision Support Systems 50. Classification framework for data-mining in financial fraud detection (title).
Limitation: both are financial-fraud general surveys. I found no verified agriculture-specific insurance-fraud detection paper. These are supervised/unsupervised approaches needing labelled or large data, which Vivasayi AI lacks.

## 10. Official technical documentation

- [cdse_statistical] CDSE Statistical API documentation: page and section headings read (Statistical API, evalscript, histogram).
- [openmeteo_hist] Open-Meteo Historical Weather API: states ERA5 0.25 deg from 1940 and ERA5-Land 0.1 deg from 1950. Reanalysis grid cells are far coarser than a parcel, so rainfall is regional context.

---

## Unverified leads (not cited, not in references.bib)

1. PMFBY operational guidelines and technology (YES-TECH, crop-cutting-experiment) provisions: portal reachable but guideline text not retrieved.
2. ESA Sentinel-2 User Handbook / Level-2A algorithm pages: the sentinels.copernicus.eu URLs I tried returned 404.
3. Sentinel Hub docs.sentinel-hub.com Statistical API page: returned HTTP 200 but no title or text I could confirm (the CDSE page was used instead).
4. "Picture-based crop insurance: using smartphone camera data for claims verification in India" (Crossref DOI 10.23846/b/ie/202501): record had no authors and unclear venue; not verified.
5. Jensen, Barrett, Mude, basis risk in index insurance, Kenya: only SSRN working-paper records were found; journal version not verified.
6. "Crop Sentinel: AI-based flood and pest damage detection" (2026 ICICT, DOI 10.1109/icict68280.2026.11511028): found in a search; not vetted.
7. Viaene et al. automobile insurance fraud strategies: my guessed DOI resolved to an unrelated paper, so it is discarded.
8. Any peer-reviewed work on cross-claimant polygon overlap for insurance fraud, Tamil agricultural RAG, or Tamil/Latin name matching for land records: none found.
