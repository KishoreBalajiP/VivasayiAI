# Live results — 16 October 2026

Every number here comes from a JSON file in this folder. Production data stores (MongoDB Atlas, S3, Chroma) were only **read**; nothing was written to them. No real farmer, claim or document was used.

| File | What it holds | Script |
|---|---|---|
| `provider_check_2026-10-16.json` | One read-only call per provider | `scripts/live/checkProviders.js` |
| `satellite_case_studies_2026-10-16.json` | 12 Sentinel-2 pre/post runs plus a request-shape check | `scripts/live/satelliteCaseStudies.js` |
| `rag_retrieval_2026-10-16.json` / `.md` | 22 retrieval queries on the production collection | `scripts/live/ragRetrieval.live.js` |
| `acceptance_v1-legacy_2026-10-16.json`, `acceptance_v2-components_2026-10-16.json` | Farmer journey over HTTP, per policy | `scripts/live/localAcceptance.js` |
| `live_eval_status_2026-10-16.json`, `SUMMARY_2026-10-16.md` | Status of the blocked Gemini evaluations | `scripts/live/liveSummary.js` |

## 1. Providers

MongoDB Atlas (ping and collection counts), S3 (bucket head and listing), Cohere (1024-dimension embedding), Chroma (`farming-documents`, 450 chunks), Gemini (`gemini-2.5-flash` replied) and Copernicus Data Space (token, then 14 scenes from a catalogue search) all answered.

**Blocker:** the Gemini key is on the **free tier: 20 `generate_content` requests per day** for `gemini-2.5-flash`. The quota ran out during this study. A production deployment needs a billed key: a farmer-facing chat cannot run on 20 requests a day.

## 2. Sentinel-2 pre/post NDVI (production adapter)

**Setup.**
- **Areas:** 100 m squares.
- **Request:** the Copernicus Statistical API on Sentinel-2 L2A, scene-classification masking with water kept, and per-pixel mean NDVI.
- **Windows:** pre-event −40 to −5 days, post-event +1 to +20 days.
- **Rule:** dNDVI ≤ −0.15 with enough valid pixels counts as "supports loss". This threshold is provisional and uncalibrated.
- **Event locations:** taken from Sphere India situation reports and a Tamil Nadu gazette notification (sources are in the JSON).
- **Not verified:** land cover, crop and actual damage at each square.

| Event (date) | Squares | Supports loss | No change | Inconclusive | dNDVI where analysed |
|---|---|---|---|---|---|
| South Tamil Nadu floods (2023-12-18) | 3 | 0 | 2 | 1 (no post-event data) | +0.11, −0.02 |
| Cyclone Michaung, Tiruvallur (2023-12-04) | 3 | 0 | 2 | 1 (post-event valid pixels 0.53) | +0.46, +0.31, +0.56 |
| Cyclone Fengal, Villupuram (2024-12-01) | 3 | 0 | 1 | 2 (no post-event data) | +0.03 |
| Thanjavur harvest control (2024-02-15) | 3 | **1 (false)** | 1 | 1 (pre-event valid pixels 0.34) | −0.25, −0.07, +0.21 |

**Latency:** median 2.5 s per claim-sized analysis, maximum 11.8 s (about 5 provider requests each).

**Reading.**
- No event square showed a loss.
- Several had a pre-event NDVI of −0.04 to 0.10, consistent with bare, flooded or newly transplanted fields. NDVI rose after the event.
- The first clear post-event image was 2–19 days after the event.
- The harvest control produced a false "supports loss" (NDVI 0.74 → 0.49 across the harvest).
- **Conclusion:** a fixed-window NDVI rule without crop-calendar context is not evidence of loss. The design keeps satellite as optional supporting evidence, and these runs support that choice.

**Request-shape check.** The production request returned 100 valid samples per 100 m square, which confirms the resolution is expressed in degrees. The earlier proof-of-concept request was rejected with HTTP 400: "Output dataMask requested but missing from function setup()". It had never run live.

**Changes made during the study (disclose in any publication).**
1. **Parser fix.** The NDVI parser read the statistics at the wrong nesting level, so every live response returned "no valid statistics". Fixed, with a recorded live response as a regression fixture (`tests/fixtures/cdse_statistics_live_2024-01.json`).
2. **Cloud limit raised, after seeing results.** The scene-level cloud limit (30%) rejected all monsoon imagery. Parcel statistics now use `SATELLITE_PROCESSING_SCENE_CLOUD_MAX` (default 0.9), and pixel masking handles the parcel itself. This change was made **after seeing results**. The NDVI thresholds were not changed.

## 3. Retrieval (RAG) over the production collection

There were 22 queries: 13 that the corpus could answer and 9 advisory ones. Results at top-3, the production setting:

- A relevant chunk was retrieved for **2 of 13** answerable questions.
- The expected file was retrieved for 10 of 13, but 9 of the 11 matching chunks were **header-only**, with no data rows.
- **0 of 27** chunks could answer an advisory question.

**Corpus:** statistics CSVs (196 chunks), XLS/HTML tables (17) and a KML geography file (237). It contains no advisory text.

**Cause:** ingestion chunks table rows without the file name or crop.

**Relevance labels:** produced by an author-written mechanical rule, not by human judges.

See `rag_retrieval_2026-10-16.md`.

## 4. Farmer-journey acceptance (real app, local database)

**Setup.**
- The real Express app was called over HTTP with the same requests the frontend makes: a Bearer session token and the JSON envelope.
- **Database and storage:** a local MongoDB (`mongodb-memory-server`) and mock image storage, so nothing was written to Atlas or S3.
- **Mocked:** photo assessment and land records.
- **Live:** Gemini, Cohere, Chroma (read-only), Open-Meteo and Copernicus.

| Policy | Passed | Failures |
|---|---|---|
| v1-legacy | 24 / 26 | Both chat calls: HTTP 503, Gemini quota |
| v2-components | 25 / 27 | Both chat calls: HTTP 503, Gemini quota |

**Passing steps:**
- a missing token returns 401;
- profile, parcel, weather;
- claim creation with the claimant relationship, and an idempotent replay;
- 2 photographs through presign → PUT → complete;
- submit, verify, and a status read;
- a land document attached through the upload flow;
- appeal read;
- another farmer gets 404 on the claim, its verification and its documents;
- a client-supplied verification result is ignored;
- a second claim, then its withdrawal.

**Outcome of the journey under each policy:**
- **v1:** the claim is approved on photographs and geometry, with claimant rights unverified. This is the legacy behaviour.
- **v2:** the claim is first returned for more evidence. After a `land_record` document is attached and the claim resubmitted, it is **held**: `submitted`, no decision, claimant rights `pending` reviewer action.

**Found and fixed by this run:**
- A held claim still reported the previous round's decision. Covered by test HD-9.
- A Gemini quota refusal reached the farmer as a 500 "did not respond in time". Covered by tests PL-11 and PL-12.

**Found and not changed (needs a product decision):** one claim journey needs more than the 5 claim writes per hour allowed per user. The harness raises the limit for itself only.

## 5. Blocked: live chat and document extraction

Both scripts are written and tested on one item each. Neither produced results because of the Gemini quota.

| Evaluation | Script | Calls needed |
|---|---|---|
| Live chat, generic vs context-aware (46 items, LLM judge clearly labelled) | `chatContext.live.js` | About 115 |
| Synthetic land-document extraction (12 watermarked documents, 3 with injected instructions) | `landDocExtraction.live.js` | About 24 |

No latency, token, cost, answer-quality or extraction figure is reported.

**Price reference for when they run:** Gemini 2.5 Flash, paid tier, $0.30 per 1M input tokens and $2.50 per 1M output tokens, thinking tokens included (https://ai.google.dev/gemini-api/docs/pricing, fetched 2026-10-16).
