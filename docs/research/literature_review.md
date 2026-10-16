# Literature review: Vivasayi AI

**Search date:** 2026-10-16.
**Tools used:** Crossref REST API (bibliographic search and DOI records), doi.org content negotiation (CSL-JSON and BibTeX, used to generate `references.bib`), Semantic Scholar Graph API (abstracts), arXiv abstract pages (abstracts), direct HTTP fetches of the Copernicus Data Space, Open-Meteo and PMFBY web pages. No library full-text access was available.

## Evidence level (read this first)

- **Every paper below was verified**: title, first authors, year and venue were matched against a DOI record fetched in this session.
- **First pass: full text was NOT read for any paper.** (The second pass, below, read the full text of several papers; their entries are marked `full text`.) The "Read" tag on each entry says what I actually saw:
  - `abstract`: the abstract was retrieved and the reported results come from it only.
  - `metadata`: only the bibliographic record was retrieved. For these I describe the paper only at the level its title supports and give no results.
- Numbers quoted are from abstracts only. Statements about "limitations" are either stated in the abstract or are my own inferences, marked "(inferred)".
- Three web documents (CDSE Statistical API, Open-Meteo Historical API, PMFBY portal) were fetched, but only page titles, headings or short statements were read. The PMFBY portal fetch did not yield scheme guidelines, so I make no claim about PMFBY rules.

### Second pass (2026-10-16): full-text reading and new sources

A second pass read original papers where they could be obtained and added 26 sources (sections 11-15 below). What changed:

- **Full text read (PDF downloaded and read):** Ursu 2025 [ursu2025], Ravindran 2026 AgroLLM [ravindran2026], Singh 2024 Farmer.Chat [singh2024] (arXiv v2), Didwania 2024 AgriLLM [didwania2024], the NRSC smart-sampling report [murthy2019smart] (front matter and abstract), the NRSC modelled-yield report [murthy2021replace] (abstract), and the YES-TECH manual [mncfc2023yestech] (preface and sections 3.2 and 4.3.6). The entries for the first three priority papers below have been rewritten from the full text. Where they disagree with the earlier abstract-based notes, the full text is what counts.
- **Abstract only (publisher blocked or paywalled):** Okeyo and Mulaku 2020 [okeyo2020]. The SCIRP PDF returned HTTP 403, so the full abstract came from Semantic Scholar. Carter et al. 2017 [carter2017] is closed access. OpenAlex lists no open copy, and the FERDI and UC Davis BASIS pages offer only the abstract.
- **Two discrepancies found in full texts.** (1) Ursu 2025: the abstract gives 6200-9100 ha affected at 5 days for Dolhasca, but the paper's own Table 4 gives 2580.5 ha (dNDVI > 0.10) and 895.3 ha (dNDVI > 0.20). The earlier notes quoted the abstract figure, so cite the table, or cite neither. (2) AgroLLM: the abstract and Table 4 give 95.2% for RAG + DKPL, but the contributions list gives 93.6%, which is the plain-RAG figure in Table 3.
- Each new entry carries the URL that was checked and a read level: `full text`, `abstract`, or `metadata`.

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

**1.12 Ursu, Istrate, Jitariu, Lazăr (2025), hail damage with Sentinel-2 and radar** [ursu2025]. *Read: full text* (PDF from https://mdpi-res.com/d_attachment/remotesensing/remotesensing-17-03850/article_deploy/remotesensing-17-03850.pdf; the www.mdpi.com HTML returned 403). Remote Sensing 17(23):3850, published 27 Nov 2025.
- **Problem:** hail damage is localised and short-lived, which makes landscape-scale assessment hard. The paper notes that insurance adjusters assess hail losses by field inspection.
- **Method:** MRL5 weather-radar hail kinetic energy (HKE) above 300 J m-2 sets a spatial mask. Inside that mask, Sentinel-2 **Level-1C** NDVI (B4, B8) is differenced between pre- and post-event scenes. No atmospheric correction is applied, on the argument that relative dNDVI over short intervals is robust. Thresholds are dNDVI > 0.10 (moderate) and > 0.20 (severe), "consistent with values reported in previous hail impact studies [37,48] and confirmed by a preliminary sensitivity analysis". Image pairs had to meet two criteria: the first post-event image within 5-10 days of the event, and cloud cover below 5% over the hail swath. Cloud handling is scene selection, not per-pixel masking. A Sentinel-2-derived land-use layer (eight classes) feeds per-class statistics, tested with Friedman and Wilcoxon tests.
- **Data:** Rădăuți (17 Jul 2016; pre 13 Jul, post 23 Jul, one post-event image) and Dolhasca (30 Jul 2020; post-event images at 5, 8 and 15 days), both in north-east Romania.
- **Results (Tables 3 and 4):** Rădăuți: 5856 ha (40.0% of the HKE zone) at dNDVI > 0.10 and 2235 ha (16.3%) at > 0.20. Dolhasca, as % of the HKE zone at > 0.10 / > 0.20: 2580.5 ha (33.8%) / 895.3 ha (11.7%) at 5 days, 1890.8 ha (24.7%) / 656.4 ha (8.6%) at 8 days, and 1510.5 ha (19.8%) / 560.1 ha (7.3%) at 15 days. For arable land, mean dNDVI fell significantly from 5 to 8 to 15 days (Friedman p < 0.001). Arable land was the most sensitive class, followed by orchards and pastures.
- **Discrepancy:** the abstract's Dolhasca figures (6200-9100 ha at 5 days, 3100-5600 ha at 15 days) do not match Table 4. The earlier version of this review quoted the abstract. Use the table values, and mention the inconsistency if the abstract figures are cited.
- **Limitations stated by the authors (Section 4.4):** "A key limitation remains the lack of direct ground validation". The authors call for in situ surveys, insurance records or UAV imagery to calibrate dNDVI thresholds "by crop type and phenological stage". Sentinel-2 timing is constrained by orbit and cloud, and the critical < 3-day window was missed. L1C without atmospheric correction adds reflectance uncertainty. The 500 m radar resolution can overestimate affected areas. Land use is coarse, with no crop type or phenology.
- **Relevance:** this is the closest published analogue to Vivasayi AI's pre/post dNDVI with fixed thresholds, and it supports two design points: thresholds must be treated as uncalibrated, and the post-event date is a first-order variable. It differs in three ways. It uses L1C plus scene-level cloud selection, where Vivasayi AI uses L2A plus SCL pixel masking. It maps areas rather than verifying an individual claimant's polygon. It has an independent hazard mask (radar HKE) for which Vivasayi AI has no equivalent (rainfall is only supporting evidence). Its "validation" is spatial agreement with radar and eyewitness reports, not claim outcomes, so it cannot serve as an accuracy baseline.

## 2. Agricultural insurance, crop-loss assessment, PMFBY

**2.1 PMFBY portal** [pmfby_portal]. *Read: page reachable only.* Government of India scheme site. I did not retrieve guideline text, so I make no statement on its technology provisions. See Unverified leads.

**2.2 Murmu and Mahadik (2025), remote sensing data in crop insurance, India** [murmu2025]. *Read: abstract.* Asia-Pacific J. of Risk and Insurance 19. Proposes a framework combining crop details, satellite data and an actuarial yield model, with kernel density estimation for risk; argues that bandwidth heuristics can mislead; motivates by fragmented, low-quality, costly data in India (abstract). Limitation: aimed at insurer yield/risk modelling, not individual claim verification; evaluation details not in the abstract. Relevance: India-specific support for the data-scarcity problem.

**2.3 Murthy, Poddar, Choudhary et al. (2022), RS-based crop insurance for jute, India** [murthy2022]. *Read: metadata.* RSASE 26:100717. Title indicates remote-sensing-based insurance for jute in India. Relevance: Indian precedent; no results read.

**2.4 Okeyo and Mulaku (2020), satellite crop insurance, Migori, Kenya** [okeyo2020]. *Read: abstract only.* Full text not obtained: https://www.scirp.org/journal/PaperDownload.aspx?paperID=99104 and the SCIRP HTML page both returned HTTP 403. The full abstract was read via the Semantic Scholar API (DOI 10.4236/ars.2020.91001). Advances in Remote Sensing 9(1):1-11.
- **Problem:** crop insurance in Kenya is scarce and indemnity-based, which the authors call "cumbersome and expensive" for subsistence farmers. They propose an NDVI index instead.
- **Method and data:** study carried out in mid-2019 on maize in Migori County. Sentinel-2 imagery from May 2017 (the "insurance year") and May 2016 (reference) was classified, NDVI was computed, and an 8 km x 8 km grid was overlaid with mean NDVI per cell. The index per cell is (Ap - Ar), insurance-year NDVI minus reference NDVI. A negative value triggers compensation.
- **Results:** of "about 85" smallholder farms in the study area, 30 would have qualified for compensation.
- **Limitations:** there is no validation against observed yields or losses (none is mentioned in the abstract). The index uses one reference year rather than a multi-year baseline, and a coarse 8 km cell (basis risk; inferred). The authors recommend "further refining and pilot testing".
- **Relevance:** a clear example of an area-index trigger, the opposite of Vivasayi AI's per-claimant polygon evidence. It also shows that a payout decision (30 of 85) can be produced with no ground truth, which is the trap the Vivasayi AI write-up must avoid.

**2.5 Masiza, Chirima, Hamandawana (2022), satellite-based insurance for smallholder maize** [masiza2022]. *Read: abstract.* Remote Sensing 14(6):1512. Compares TAMSAT and CHIRPS rainfall estimates; CHIRPS better at 20-day and monthly steps; builds trigger/exit/tick payout thresholds from a crop water requirement model (abstract). Limitation: rainfall-index product, South Africa. Relevance: rainfall as an insured index; Vivasayi AI uses rainfall only as supporting evidence.

**2.6 Kolle, Buchholz, Musshoff (2021), field-level satellite indices and basis risk** [kolle2021]. *Read: abstract.* Agricultural Finance Review 82. MODIS (250 m) vs Landsat (30 m) NDVI for winter wheat, three German farms; higher resolution reduced basis risk, yet field-level contracts did not beat farm-level (abstract). Relevance: evidence that finer resolution helps but is not a guarantee. Small sample (three farms).

**2.7 Dalhaus and Finger (2016), gridded data and phenology in weather index insurance** [dalhaus2016]. *Read: abstract.* Weather, Climate, and Society 8. German wheat; no difference between gridded and station precipitation; phenological observations significantly raised expected utility (abstract). Relevance: timing of the index window matters; the platform's fixed pre/post windows may inherit this issue (inferred).

**2.8 Carter, de Janvry, Sadoulet, Sarris (2017), index insurance reassessment** [carter2017]. *Read: abstract only (paywalled).* Annual Review of Resource Economics 9:421-438. OpenAlex marks it closed access. The FERDI page (https://ferdi.fr/en/publications/index-insurance-for-developing-country-agriculture-a-reassessment) gives only the abstract and a link to annualreviews.org, and https://basis.ucdavis.edu/node/3276 returned HTTP 403.
- **Problem:** uninsured risk deters smallholder investment. Index insurance was meant to avoid the moral-hazard and verification costs of indemnity insurance, yet take-up "has been disappointingly low" without large, sustained subsidies.
- **Argument:** some barriers can be eased by better contract design, improved measurement technology, better marketing and policy support. Because index insurance is likely to stay expensive, the authors propose bundling it with stress-tolerant seeds and risk-oriented savings and credit.
- **Data and results:** a review article. No quantitative results were read.
- **Relevance:** economic framing only. "Improved measurement technology" is the opening for technology-assisted verification, but the paper says nothing about per-claim indemnity verification that was read here. Cite it for context, not as support for a design choice.

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

**6.3 Ravindran et al. (2026), AgroLLM** [ravindran2026]. *Read: full text* (PDF from https://mdpi-res.com/d_attachment/agriengineering/agriengineering-08-00038/article_deploy/agriengineering-08-00038.pdf; the www.mdpi.com page returned 403). AgriEngineering 8(1):38, published 21 Jan 2026. An earlier preprint exists as arXiv:2503.04788 but was not read.
- **Problem:** generic LLMs mishandle domain terminology, retrieve ambiguously and produce factual inconsistencies in agricultural advice.
- **Method:** a corpus of 19 textbooks (5296 pages, about 2.38 million words) in four FAO/USDA-aligned domains, cut into chunks of about 1000 words with 50-word overlap and indexed in FAISS (IVF, nlist 256, nprobe 32, top-k 10, similarity threshold 0.78). The *Domain Knowledge Processing Layer* (DKPL) holds concepts, causal rules ("if X then Y") and numeric thresholds, extracted automatically with regexes, dependency patterns and LLM summarisation. The DKPL filters and re-weights retrieved chunks, then checks the draft answer. A violation, for example "maximum nitrogen rate = 300 kg/ha", is fed back for regeneration, up to 3 iterations. **When nothing relevant is retrieved, the system falls back to the LLM's own knowledge.** Decoding temperature is 0.2.
- **Evaluation:** 504 questions written from the textbooks plus two other books. "Benchmark answers" are the RAG-retrieved chunks, and a manual check is made against the book. The paper does not report the number of raters, inter-rater agreement or blinding. BLEU is computed against "expert-crafted" references.
- **Results:** Table 4 accuracy (FAISS-only / RAG / RAG + DKPL): Mistral-7B 69 / 73.8 / 76.8; Gemini 1.5 Flash 81.4 / 85.8 / 88.8; ChatGPT-4o mini 89.2 / 93.6 / 95.2. Mean latency for ChatGPT-4o mini rises from 0.34 s to 11.02 s with RAG + DKPL. DKPL cut misaligned retrieval by 27-31% and corrected 78-86% of numerical, threshold and causal inconsistencies. Error types in plain RAG (Table 5): numerical violation 41%, misaligned retrieval 22%, over-generalisation 19%, impossible states 18%. One of the impossible-state examples is "NDVI = 1.3".
- **Internal inconsistency:** the contributions list reports 93.6% as the best accuracy, but that is the plain-RAG figure. The abstract and Table 4 give 95.2% for RAG + DKPL.
- **Limitations (stated):** the system has not been evaluated as a decision-support tool or in real extension settings. Region-specific practices are underrepresented, latency is high, and dialect coverage needs work. **(Inferred):** there are no farmer records and no user study. The questions come from the same textbooks as the corpus, which favours retrieval. Grading is lightly specified. The fallback to parametric knowledge is the behaviour a context-sufficiency gate is meant to prevent.
- **Relevance:** closest agricultural RAG with a deterministic post-generation check. Vivasayi AI checks *whether there is enough context to answer* (a sufficiency gate plus provenance tags). AgroLLM checks *whether the answer violates rules*. The two are complementary, and the difference should be stated plainly.

**6.4 Singh et al. (2024), Farmer.Chat** [singh2024]. *Read: full text* (arXiv:2409.08916v2, 8 Oct 2024, https://arxiv.org/pdf/2409.08916; Digital Green and Microsoft Research India). Preprint, not peer reviewed.
- **Problem:** extension-agent ratios of 1:1,000 to 1:5,000 leave smallholders without timely, local advice.
- **Method:** RAG over research papers, policy documents, crop guidelines, web pages and video transcripts. The pipeline runs intent understanding, query rephrasing and decomposition (using chat history), retrieval and re-ranking, then generation. GPT-4 is used for filtering and re-ranking, GPT-3.5 for other steps, with custom embeddings. Farmer context (crop, location, weather from TomorrowIO) is included, and Plantix handles disease diagnosis. Queries are translated to English for processing and back-translated. Delivery is by voice (ASR/TTS), on Telegram, WhatsApp and an app.
- **Deployment:** Kenya (8,805 users, 225,500 queries; launched Oct 2023), India (6,282 users, 45,798 queries), Nigeria (418 / 3,788) and Ethiopia (105 / 458).
- **Results:** about 75% of questions answered. Of the unanswered ones, 66% were out of content, 23% out of context and 11% out of collection. Mean latency was 9.05 s. Context precision was 71% (over 1,000+ queries). RAGAS faithfulness was "high" for about 80% of queries, with about 10% each medium and low. Relevance was high for 67% of queries, medium for 15% and low for 18%. Faithfulness and relevance are **LLM-judged (RAGAS)**; the authors say this agrees with human judgement from an internal analysis of 1,000 queries, which is not reported in detail. Qualitative work covered focus groups with 199 users and two surveys of 20 participants each (Study 2's satisfaction counts total 22).
- **Limitations:** there is no expert-graded correctness metric and no measure of farm outcomes. The authors report knowledge-base gaps, weak translation of local dialects, and low-literacy users struggling to phrase questions. The quantitative evaluation is mostly from Kenya.
- **Relevance:** the nearest deployed, personalised analogue. Its "out of context/content" categories correspond to Vivasayi AI's context-sufficiency gate, and its use of RAGAS is a precedent for the evaluation. It does not use per-farmer records beyond profile fields, and it has no claims workflow.

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

## 11. Indian crop-insurance technology: PMFBY, YES-TECH, CCE smart sampling (second pass)

These are government technical documents, not peer-reviewed papers. They are cited for what the scheme *says*, not as evidence of accuracy.

**11.1 MNCFC / DA&FW (2023), YES-TECH Manual for Implementation** [mncfc2023yestech]. *Read: full text, partial* (preface and Sections 3.2 and 4.3.6). URL: https://apsac.ap.gov.in/wp-content/uploads/2023/01/Document2.pdf. This is a copy hosted by the Andhra Pradesh Space Applications Centre; no copy on pmfby.gov.in was located.
- Under PMFBY, crop yield estimates per Insurance Unit (IU) "form the basis for crop loss assessment and indemnity payout". Crop Cutting Experiments (CCEs) are limited by "(a) limited number of measurements, (b) time-consuming process, and (c) vulnerable to human errors".
- An expert committee recommended five approaches for nation-wide rollout for **paddy and wheat** from the 2023 season. YES-TECH "advocates the blended use of modelled and CCE yield estimates".
- Section 3.2: direct yield estimation blends **70% CCE yield with 30% modelled yield**, and the indirect (CHF) approach blends deviations with the same 70/30 split. States must give technology a minimum 30% weight. Section 4.3.6: models must deliver IU-level estimates for the current and at least the past five years. If nRMSE against observed yields exceeds 30%, the IU must not use the method.
- **Relevance:** the official Indian scheme is **area-yield** (IU-level) loss assessment. Satellite and model evidence enter as a weighted input to *IU yield*, with CCEs still dominant. Vivasayi AI's per-farmer, per-polygon claim evidence is a different unit of analysis. Any claim that the system "supports PMFBY" must be phrased as complementary (for example localised-calamity or individual-assessment contexts), and that would need checking against the PMFBY operational guidelines, which were **not** read.

**11.2 Murthy, Das, Choudhary, Pandey, Srikanth, Rao (2019), Smart sampling for CCEs, Odisha** [murthy2019smart]. *Read: full text, partial* (front matter, abstract, contents). URL: https://pmfby.gov.in/compendium/Technology/2019%20-%20Smart_sampling_odisha_NRSC_Tech%20Report.pdf. NRSC (ISRO) technical report, March 2019.
- Method: a satellite paddy yield proxy at 20 m (NDVI, LSWI and a cross-polarisation ratio, combined into a composite index) stratifies each Gram Panchayat. CCE fields are chosen by stratified random sampling and overlaid on cadastral maps so field staff can find them. Odisha was the first state to implement it (kharif 2018-19), and the report says it "minimises the subjectivity in the CCE mechanism".
- No accuracy results were read.
- Relevance: an Indian precedent for using satellite data to *direct* ground verification rather than replace it. This matches Vivasayi AI's use of satellite evidence to route claims to review rather than to decide them.

**11.3 Murthy, Poddar, Pandey, Biswal, Choudhary (2021), Replacing CCE yields with modelled yields** [murthy2021replace]. *Read: abstract and executive summary.* URL: https://pmfby.gov.in/compendium/Technology/2021%20-%20Replacing%20CCE-yield%20with%20modelled%20yield-Technical%20Report.pdf. NRSC and AIC technical report, August 2021.
- Conclusion: modelling yields at IU scale "is complex and is constrained by scarcity, scale and quality of input data". More focused research is needed before CCE yields can be replaced.
- Relevance: an authoritative Indian source supporting the decision to keep satellite evidence advisory, with human review.

**11.4 Ceballos, Kramer, Robles (2019), Picture-Based Insurance** [ceballos2019]. *Read: abstract only* (OpenAlex abstract; the ScienceDirect PDF returned 403). Development Engineering 4:100042. https://doi.org/10.1016/j.deveng.2019.100042
- Problem: index insurance carries downside basis risk, and loss verification is costly. Method: farmers photograph their own insured plots with smartphones, and the photos are used to verify claims. Pilot in India's rice-wheat belt.
- Results: "nearly two-thirds" of trained farmers took at least four pictures (about one per growth stage), judged sufficient for loss assessment. Severe damage was visible in photos at **71%** of affected sites, versus at most **34%** for alternative index products.
- Limitation (inferred from the abstract): a pilot; visibility of damage is not the same as quantified loss; photos were assessed by people, not by an AI model.
- Relevance: **this resolves unverified lead 4** (picture-based insurance in India), as the peer-reviewed version. It is the closest precedent for Vivasayi AI's farmer-submitted photo evidence. Note that PBI relies on a *series* of photos over the season, while Vivasayi AI takes photos at claim time. That is a weaker design for establishing pre-event condition, and the write-up should say so.

**11.5 Hufkens et al. (2019), smartphone near-surface remote sensing, NW India** [hufkens2019]. *Read: abstract.* Agricultural and Forest Meteorology 265:327-337. https://doi.org/10.1016/j.agrformet.2018.11.002. Streams of smallholder smartphone photos were used to quantify wheat heading and detect lodging events "not registered by common satellite remote sensing vegetation indices or national crop cut surveys". No accuracy figures were in the abstract. Relevance: supports treating ground photos as complementary to 10 m satellite NDVI, because some damage (lodging) does not show in NDVI.

**11.6 Grey literature: duplicate insurance of the same land (news).** [tribune2023cotton] *Read: full article.* The Tribune, 15 Dec 2023. https://www.tribuneindia.com/news/haryana/insurance-claims-technical-panel-to-look-into-mismatch-of-area-under-cotton-572034/amp. The insurer reported 30,873 ha of cotton insured across 72 villages in Hisar district against 16,554 ha verified by the Revenue Department. The report attributes this to "multiple insurance for the same area": a bank insured a loanee's crop, and a lessee insured the same land. The disputed amount was about Rs 120 crore. **This is a news report, not research.** Use it only as motivation that overlapping claims on the same land occur in practice. It is not evidence of how often they occur or that polygon overlap would detect them, since the cases involved different claimants on the same land record.

## 12. Satellite evidence for flood, cyclone and hail crop damage (second pass)

**12.1 Ha, Shen, Duddu, Johnson, Shirtliffe (2022), hail damage with Sentinel-2** [ha2022]. *Read: abstract.* Remote Sensing 14(4):951. https://doi.org/10.3390/rs14040951
- Canadian Prairies, 54 fields, ground estimates of hail damage. The study compares eight vegetation indices using either pre/post *delta* or the area under the curve (AUC) of a time profile.
- The best metrics were the **32-day AUC** of NDVI, NDWI and PSRI, correlated with ground damage at r = -0.90 (canola; RMSE 8.24), r = -0.86 (wheat; RMSE 12.27) and r = 0.80 (lentil; RMSE 17.41). The abstract does not give the single-pair delta correlations.
- Relevance: one of the few Sentinel-2 hail studies **with field ground truth**. It suggests that a time-integrated metric did better than a single pre/post delta in that setting, which bears directly on Vivasayi AI's single pre/post window. Ursu 2025 cites it for the sharp first-week NDVI decline.

**12.2 Chakraborty, Srikanth, Murthy, Rao, Chowdhury (2021), Cyclone Amphan jute lodging** [chakraborty2021]. *Read: abstract* (via Europe PMC; Springer redirected to login). Environmental Monitoring and Assessment 193:464. https://doi.org/10.1007/s10661-021-09220-w
- West Bengal; Amphan made landfall on 20 May 2020. A jute map was built from pre-event Sentinel-2 (9 Apr, 14 May) plus ground data (85% accuracy). The Sentinel-1 VH backscatter change was > 2.5 dB for damage (22 vs 16 May) and > 1.5 dB for recovery (22 vs 28 May).
- A **decision matrix** combines the SAR changes with NDVI vigour strata (low, medium, high) into three classes: affected, marginally affected and normal. Overall accuracy was 84.12% (kappa 0.74). About 12.5% of the jute area (38,119 ha) was affected or marginally affected.
- Relevance: an Indian, operational, **rule-based (decision-matrix) fusion** of optical and SAR evidence for crop insurance and relief. It is the nearest methodological precedent for a deterministic evidence-fusion rule, and it shows that SAR is the standard answer to cyclone-season cloud. Vivasayi AI has no SAR path.

**12.3 Bhatt, Charavande, Pandey, Singh, Chauhan (2026), Cyclone Remal** [bhatt2026]. *Read: metadata only* (Springer login redirect; no abstract via Crossref, OpenAlex or Europe PMC). Journal of the Indian Society of Remote Sensing 54(11):4151-4166. https://doi.org/10.1007/s12524-026-02536-5. The title indicates multi-sensor data and a decision-matrix approach to agricultural damage from Cyclone Remal. No results are cited here; a search-engine summary mentioned figures, but these were not read in the source.

**12.4 Digra, Goyal, Guha, Saran, Srivastav (2025), hail crop damage in Haryana** [digra2025]. *Read: metadata only.* JISRS 53(12):4157-4170. https://doi.org/10.1007/s12524-025-02216-w. An Indian satellite-based hail-damage study (title). No results are cited.

**12.5 Bocchino et al. (2025/2026), flood crop damage with Sentinel-2 and in situ data, Emilia-Romagna** [bocchino2025]. *Read: abstract* (OpenAlex). Remote Sensing Applications: Society and Environment 41:101852 (Crossref issue date Jan 2026). https://doi.org/10.1016/j.rsase.2025.101852
- Random Forest on Sentinel-2 indices, topography and flood extent, trained and tested on **412 fields with agronomist damage assessments** (May 2023 flood, Italy). Overall accuracy was 0.74 (precision 0.75, recall 0.74, F1 0.74) for three damage classes.
- It identified high-damage fields well but "struggled to distinguish between no-damage and medium-damage fields", especially permanent crops, where damage happens beneath the canopy.
- Relevance: a realistic accuracy ceiling for Sentinel-2-based field damage classification **with** ground truth. Even this does not separate medium from no damage reliably, so a single dNDVI threshold on small Tamil Nadu parcels should not be expected to grade damage.

**12.6 Kanjir, Đurić, Veljanovski (2018), Sentinel-2 anomaly detection for CAP monitoring** [kanjir2018]. *Read: abstract.* ISPRS IJGI 7(10):405. https://doi.org/10.3390/ijgi7100405. BFAST Monitor and NDVI parcel profiles detect land-use anomalies (ineligible use) in Slovenia. Candidates are validated against **declared use and field controls** from subsidy granting, and the authors report "high accuracy rates" without numbers in the abstract. Relevance: together with [sitokonstantinou2018], this is the EU precedent for checking *declarations* against parcel-level Sentinel-2 evidence and sending anomalies to field control, which is the same architecture as Vivasayi AI's hold and manual review.

**12.7 Sani et al. (2024), SICKLE dataset, Cauvery Delta, Tamil Nadu** [sani2024]. *Read: abstract.* WACV 2024, pp. 5983-5992. https://doi.org/10.1109/wacv57701.2024.00589 (arXiv:2312.00069)
- Landsat-8, Sentinel-1 and Sentinel-2 time series (Jan 2018 to Mar 2021) for 388 plots (mean **0.38 acres**) in 4 delta districts. There are 2,370 season-wise samples covering 21 crop types, and 351 paddy samples from 145 plots carry variety, season, sowing/transplanting/harvest dates and yield.
- Relevance: **the only verified Tamil Nadu plot-level labelled satellite dataset found.** It could test whether 10 m NDVI is meaningful at the parcel sizes Vivasayi AI targets, and it supports phenology-aware pre/post window selection. It contains no damage or claim labels.

## 13. LLM agricultural advisory: benchmarks and evaluation (second pass)

**13.1 Silva et al. (2023), GPT-4 as an agronomist assistant?** [silva2023]. *Read: abstract.* arXiv:2310.06225 (Microsoft). https://arxiv.org/abs/2310.06225. Agriculture exams from Brazil, India and the USA, with RAG and Ensemble Refinement. GPT-4 answered **93%** of certification-exam questions correctly, versus 88% for earlier general models. Limitation: exam-style multiple choice, not farmer questions. Relevance: shows that strong general LLMs already do well on textbook knowledge, so a benchmark of that kind cannot show the value of Vivasayi AI's per-farmer context.

**13.2 Balaguer et al. (2024), RAG vs fine-tuning, agriculture case study** [balaguer2024]. *Read: abstract.* arXiv:2401.08406 (Microsoft). https://arxiv.org/abs/2401.08406. Pipeline: PDF extraction, then Q&A generation, then fine-tuning and/or RAG, evaluated by GPT-4 (Llama2-13B, GPT-3.5, GPT-4). Fine-tuning added "over 6 p.p." of accuracy, and RAG added a further 5 p.p. on top. Answer similarity rose from 47% to 72% in one geography experiment. Limitation: LLM-as-judge evaluation. Relevance: RAG improvements of the order of a few percentage points are what to expect, so effect sizes for Vivasayi AI's retrieval must be measured, not assumed.

**13.3 Kpodo, Kordjamshidi, Nejadhashemi (2024), AgXQA** [kpodo2024]. *Read: metadata only* (Elsevier, not open access; no abstract via APIs). Computers and Electronics in Agriculture 225:109349. https://doi.org/10.1016/j.compag.2024.109349. An agricultural-extension QA benchmark (title). No results are cited.

**13.4 Zaremehrjerdi et al. (2025), AgReason / AgThoughts** [agreason2025]. *Read: abstract.* arXiv:2505.19259. https://arxiv.org/abs/2505.19259. A 100-question expert-curated open-ended agricultural *reasoning* benchmark. Across 13 models, the best Gemini-based baseline scored **36%**. A 44.6K-question QA set with reasoning traces is also released. Relevance: context-dependent agronomic reasoning remains weak even for frontier models. This is a counterweight to the exam-style 90%+ figures (13.1, AgroLLM).

**13.5 Gauba et al. (2025), AgMMU** [agmmu2025]. *Read: abstract.* arXiv:2504.10568 (Semantic Scholar lists it as NeurIPS 2025; the proceedings page was not checked). The benchmark is built from 116,231 grower to Cooperative Extension expert dialogues: 746 MCQs, 746 open-ended questions and a 57,079-fact corpus. Across 12 VLMs there are "pronounced gaps in fine-grained perception and factual grounding". Relevance: supports treating Gemini photo assessments as evidence only, alongside AgroBench [shinoda2025].

**13.6 Rehman, Raghuvanshi, Kumar (2023), KisanQRS** [rehman2023]. *Read: abstract* (via arXiv:2411.08883). Computers and Electronics in Agriculture 213:108180. https://doi.org/10.1016/j.compag.2023.108180. Retrieval over a subset of 34 million **Kisan Call Centre (KCC)** call logs. Query mapping was evaluated on 300,000 samples from five states (best state F1 96.58%), and answer retrieval on 10,000 samples (NDCG 96.20%). Relevance: an Indian, retrieval-only (non-generative) baseline built from KCC, which avoids generation hallucination by design.

**13.7 Didwania, Seth, Kasliwal, Agarwal (2024), AgriLLM: Tamil Nadu KCC queries** [didwania2024]. *Read: full text* (https://aclanthology.org/2024.nlp4pi-1.16.pdf). NLP4PI workshop at EMNLP 2024, pp. 179-187. The printed title has the typo "Framer". https://doi.org/10.18653/v1/2024.nlp4pi-1.16
- Data: about 4 million KCC queries **from Tamil Nadu** (out of more than 32 million nationally, 2006-2023). The answers are short, keyword-style English transcripts. Method: fine-tuned seq2seq models (best: Flan-T5 Base), with Gemini used to rephrase answers for readability.
- Results (Table 7, Flan-T5 Base): BLEU 0.44-0.63 and ROUGE-1 0.65-0.76 across subsets. Government-scheme queries were weakest (BLEU 0.443).
- **Table 3 shows dosage and product errors:** for example, calcium chloride at 5 g/L generated against 2 g/L in the expert answer, and a different fungicide substituted. The authors present these as near-misses. **Limitations (inferred):** reference-overlap metrics only, no expert rating and no Tamil-language generation.
- Relevance: **the only verified LLM work on Tamil Nadu farmer queries found.** It is a natural baseline data source, and its Table 3 errors are concrete examples of why numeric advice needs grounding or validation.

**13.8 Vijayvargia et al. (2025), Krishi Sathi: intent-aware multi-turn agricultural QA** [krishisathi2025]. *Read: abstract.* arXiv:2508.03719. https://arxiv.org/abs/2508.03719. An English/Hindi chatbot with speech I/O that follows a structured multi-turn flow to "gradually collect the necessary details" before RAG. It reports 97.53% query-response accuracy, 91.35% contextual relevance and personalisation, 97.53% query completion and under 6 s latency (evaluation design not read). Relevance: **the closest design to Vivasayi AI's slot-gated follow-ups.** It is the comparison for the claim that Vivasayi AI asks *fewer* unnecessary questions by resolving slots from the farmer's records. Vivasayi AI's own RQ1 result is specification-scored only.

**13.9 Ameen, Islam, Aktar, Rafat (2026), KrishokBondhu** [krishokbondhu2026]. *Read: abstract* (arXiv:2510.18355). IEEE QPAIN 2026, pp. 1-6. https://doi.org/10.1109/qpain69676.2026.11546653. A Bengali voice call-centre RAG with OCR'd handbooks and Gemma 3-4B. In a pilot, 72.7% of responses were high quality, with a composite of 4.53 versus 3.13 for KisanQRS on a 5-point scale. Relevance: an example of a small IEEE-conference agri RAG paper with pilot-scale evaluation, which calibrates the evidence bar at that tier.

## 14. Retrieval grounding, context sufficiency and hallucination (second pass)

**14.1 Joren, Zhang, Ferng, Juan, Taly, Rashtchian (2025), Sufficient Context** [joren2025]. *Read: abstract.* ICLR 2025 (arXiv:2411.06037). https://arxiv.org/abs/2411.06037
- The paper defines *sufficient context* and an autorater that classifies whether the retrieved context can answer the query.
- Findings: larger models (Gemini 1.5 Pro, GPT-4o, Claude 3.5) answer well when context is sufficient but "often output incorrect answers instead of abstaining" when it is not. Smaller models hallucinate or abstain even with sufficient context. Selective generation guided by sufficiency raised the fraction of correct answers among answered queries by 2-10% (Gemini, GPT, Gemma).
- Relevance: **the most direct conceptual precedent for Vivasayi AI's context-sufficiency gate.** It justifies abstaining or asking a follow-up when context is insufficient, rather than letting the model answer from parametric knowledge (which is what AgroLLM's fallback does). The paper is general-domain. Vivasayi AI's gate uses slot rules rather than an LLM autorater, and that difference should be stated.

**14.2 Es, James, Espinosa-Anke, Schockaert (2024), RAGAS** [es2024]. *Read: metadata* (ACL Anthology entry). EACL 2024 System Demonstrations, pp. 150-158. https://doi.org/10.18653/v1/2024.eacl-demo.16. The reference-free RAG evaluation framework used by Farmer.Chat [singh2024] for faithfulness and context precision. Relevance: a reproducible automated metric for RQ2, which must be checked against human ratings, as Farmer.Chat claims to have done.

**14.3 Fanuel et al. (2025), AgriRegion** [agriregion2025]. *Read: abstract.* arXiv:2512.10114. https://arxiv.org/abs/2512.10114. Region-aware RAG with geospatial metadata injection and region-prioritised re-ranking, restricted to verified local extension sources. A 160-question benchmark covers 12 subfields. The paper reports **10-20% fewer hallucinations** than state-of-the-art LLM systems. Relevance: the closest agricultural work to Vivasayi AI's per-farmer location context. It supports the claim that location grounding reduces "contextual hallucination" (advice right in one region and wrong in another). Preprint.

## 15. Auditable decision systems (second pass)

**15.1 Raji et al. (2020), internal algorithmic auditing** [raji2020]. *Read: abstract.* FAT* 2020, pp. 33-44. https://doi.org/10.1145/3351095.3372873. An end-to-end internal audit framework in which each development stage produces documents that together form an audit report. Relevance: a citation for Vivasayi AI's policy-versioned decisions with stored evidence snapshots as a design for auditability. It does not show that the rules are *correct*.

**15.2 Gap:** no peer-reviewed paper was located that combines ML evidence components with a deterministic, versioned rule engine and hold semantics for **insurance claims**. The search returned a ResearchGate preprint ("Governance-by-Design for AI-based insurance fraud detection") with no DOI that could be confirmed, plus patents. Neither was added. The nearest verified analogues are domain-specific decision matrices [chakraborty2021], EU CAP traffic-light-style declaration checks [sitokonstantinou2018; kanjir2018], and the interpretability argument [rudin2019].

---

## Unverified leads (not cited, not in references.bib)

1. ~~PMFBY operational guidelines and technology provisions~~ **Partly resolved (second pass):** the YES-TECH manual and two NRSC reports were read (Section 11). The PMFBY **Operational Guidelines** (2016, revised 2020) themselves were still not read, so no statement is made about localised-calamity or individual-claim procedures.
2. ESA Sentinel-2 User Handbook / Level-2A algorithm pages: the sentinels.copernicus.eu URLs I tried returned 404.
3. Sentinel Hub docs.sentinel-hub.com Statistical API page: returned HTTP 200 but no title or text I could confirm (the CDSE page was used instead).
4. "Picture-based crop insurance: using smartphone camera data for claims verification in India" (Crossref DOI 10.23846/b/ie/202501): record had no authors and unclear venue; not verified.
5. Jensen, Barrett, Mude, basis risk in index insurance, Kenya: only SSRN working-paper records were found; journal version not verified.
6. "Crop Sentinel: AI-based flood and pest damage detection" (2026 ICICT, DOI 10.1109/icict68280.2026.11511028): found in a search; not vetted.
7. Viaene et al. automobile insurance fraud strategies: my guessed DOI resolved to an unrelated paper, so it is discarded.
8. Any peer-reviewed work on cross-claimant polygon overlap for insurance fraud, Tamil agricultural RAG, or Tamil/Latin name matching for land records: none found. **Second pass:** still none. The nearest are Didwania 2024 (Tamil Nadu KCC queries, English generation) [didwania2024], and for overlap only a news report [tribune2023cotton].
9. (Second pass) Lead 4 is **resolved**: the peer-reviewed picture-based insurance paper is Ceballos et al. 2019 [ceballos2019]. The DOI 10.23846/b/ie/202501 record remains unverified and is not cited.
10. (Second pass) "Kisan-BiQAS" (bilingual KCC QA with zero hallucination in retrieval-only mode) and "Enhancing Agricultural Advisory Services with Multilingual LLaMA and RAG" (said to use Tamil Nadu queries) appeared only in search-engine summaries or ResearchGate listings. No DOI or primary page could be confirmed, so they are not cited.
11. (Second pass) AgroBuddy (NIELIT PDF), FLNet (arXiv:2601.03884), the Cyclone Fani/Amphan/Yaas DVDI paper (ScienceDirect S2225603226000202) and the Cyclone Kenneth banana study were seen in search results but not opened, so they are not cited.
12. (Second pass) AgroLLM preprint arXiv:2503.04788 is an earlier version of [ravindran2026]. Cite the journal version.
