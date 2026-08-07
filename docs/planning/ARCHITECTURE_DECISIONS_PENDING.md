# ARCHITECTURE_DECISIONS_PENDING — Architecture Freeze (Phase 0.2)

> **Metadata**
> - **Title:** Architecture Freeze — Pending Decisions (Phase 0.2)
> - **Version:** 1.0
> - **Status:** `[IN REVIEW]` — nothing in this document is accepted until Product Owner approval
> - **Owner:** Founding CTO / Principal Architect
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [PRODUCT_PRINCIPLES](../product/PRODUCT_PRINCIPLES.md) · [AI_Product_Principles](../product/AI_Product_Principles.md) · [04_Feature_List](../product/04_Feature_List.md) · [05_Product_Roadmap](../product/05_Product_Roadmap.md) · [06_System_Architecture](../architecture/06_System_Architecture.md) · [07_Database_Design](../architecture/07_Database_Design.md) · [08_API_Documentation](../architecture/08_API_Documentation.md) · [09_AI_Architecture](../architecture/09_AI_Architecture.md) · [13_Testing_Strategy](../engineering/13_Testing_Strategy.md) · [14_Deployment](../engineering/14_Deployment.md) · [15_Security](../engineering/15_Security.md) · [17_Backlog](17_Backlog.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

---

## 1. Purpose of this document

This is the **final architecture review before implementation**. Every architectural decision that must be **finalized before Phase 1 begins** is listed below with options, a recommendation, and the product questions each one raises.

- This is **not** a coding phase and **not** a documentation maintenance phase. No existing document is modified by this review.
- **No decision in this document is accepted.** Every decision is `PENDING PRODUCT APPROVAL` until the Product Owner explicitly approves it in the **ARCHITECTURE FREEZE CHECKLIST** (§12).
- Approved decisions become ADR records in [18_DECISIONS.md](../decisions/18_DECISIONS.md) during Phase 1, following the ADR conventions already in place.

### Optimisation lens (applies to every recommendation)

Every recommendation optimises for: **Simplicity · Reliability · Maintainability · Startup Cost · Developer Productivity · Future Scalability** — in that order. We never optimise for enterprise complexity.

### Status labels used

- `PENDING PRODUCT APPROVAL` — open, must be approved before the gate it blocks.
- `FIXED CONSTRAINT` — already decided in an ADR; listed for context, **not** re-litigated, not in the checklist.

---

## 2. Fixed constraints (already decided — NOT in the checklist)

These architecture choices are settled in the ADR log and treated as fixed inputs to every decision below. They are restated so the decision space is complete, but they are **not** pending approval.

| Constraint | Source |
|---|---|
| Serverless monolith: Express + `serverless-http` on AWS Lambda | ADR-001 |
| AWS Cognito OAuth2 (Google federation) as the identity provider | ADR-002 |
| RAG stack: Cohere embeddings + ChromaDB Cloud + Gemini 2.5 Flash | ADR-003 |
| MongoDB Atlas + Mongoose as primary persistence | ADR-004 |
| Browser Web Speech API for voice input (no server STT) | ADR-006 |
| Two repositories; backend = Product Repository | ADR-008 |
| `docs/` in the product repo = single source of truth | ADR-009 |
| **Context Engine** — context before generation (APP-02/03) | ADR-014 |
| **Model Adapter** — provider-agnostic AI (APP-05) | ADR-015 |
| **Farm Memory** — long-term farm intelligence (APP-04) | ADR-016 |
| **AI Diagnosis Pipeline** — image + context fusion (APP-07) | ADR-017 |
| Gemini is the current provider, **not** the only provider (PP-07/08) | ADR-003, ADR-015 |
| Zero-question principle: never ask what can be auto-obtained (PP-02) | APP-02 |
| Every answer is a decision-support outcome, not chit-chat (PP-01/04) | APP-01 |

> Note: ADR-014/015/016/017 are accepted as *direction*. The **implementation contracts** they imply (how the Context Engine assembles, what the adapter contract returns, how memory is written, how images flow) are exactly the decisions in this document and **remain pending**.

---

## 3. AI Architecture

### D-01 — Context Engine Phase 1 domain scope
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** ADR-014 accepts the nine-domain Context Engine but defers full completion to Phase 2 (F-46). Phase 1 ships the "first slice" (F-20). If we mis-scope the Phase 1 domains, we either under-deliver the "knows your district + weather + farm" promise or over-build ahead of Farm Memory (F-47).
**Available options:**
1. **Exactly F-20** — Farm Profile, Farm Location, Weather, Soil (4 fetching resolvers) + Season (pure date+district computation) + RAG (already live).
2. F-20 + GPS (browser geolocation with consent) as a fifth resolver.
3. **All nine domains in Phase 1** (adds Crop History via a premature memory store + Government Advisories via F-48 ingestion).
**Advantages:** (1) smallest scope that makes the roadmap demo provable; season costs zero infra; RAG already exists. (2) improves district auto-resolution when consent given. (3) complete zero-question from day one.
**Disadvantages:** (1) GPS denied → location must fall back to profile district (acceptable, "unknown" flag). (2) adds a consent + privacy surface in Phase 1 (APP-10). (3) forces Farm Memory and advisory ingestion into Phase 1, violating ADR-016/17 scheduling and bloating the sprint plan.
**Recommendation:** **Option 1**, with GPS as an *optional later-in-Phase-1* enhancer (Option 2) only if onboarding friction shows. *Why:* crop history (domain 7) is definitionally dependent on Farm Memory (F-47, Phase 2) — a half-baked memory store now would be throwaway; advisories (domain 8) need sourced data (F-48) we do not yet have. The four+season+RAG set delivers the Phase 1 success metric "≥95% zero-question" with the least code and the smallest PII surface.
**Risks:** Farmers with no profile and GPS denied may see "unknown" location — mitigate by making district the first onboarding step and auto-filling it from GPS when available.
**Dependencies:** E2-S1 (weather proxy), E2-S2 (soil reference data), E2-S4 (farm profile), E2-S5 (RAG filters optional).
**Future impact:** The resolver interface (12_Technical_Guidelines §2c) must accept 9 resolvers; Phase 2 simply adds domains 7 and 8 — so the orchestrator design must not hard-code four resolvers.
**Questions requiring Product Owner approval:** (a) Is the Phase 1 zero-question metric scoped to *profile + district + weather*, with crop history re-asking explicitly allowed until Phase 2? (b) Do we collect GPS consent in Phase 1 at all?

---

### D-02 — Context snapshot persistence
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** ADR-014 and 07_Database_Design §7 propose a `contextsnapshots` collection so every answer is attributable to its context (APP-12). Storing everything grows storage; storing nothing kills traceability and the context-aware eval rubric (13 §4.1).
**Available options:**
1. Persist **every** snapshot, TTL-capped (e.g., 90 days), keyed to message/session.
2. Persist only eval/diagnostic samples (flagged or sampled).
3. Do not persist.
**Advantages:** (1) full traceability, debug, eval; (2) cheaper; (3) zero cost.
**Disadvantages:** (1) storage + write cost per message (small at startup; a few KB per snapshot); (2) cannot debug production regressions retroactively; (3) no accountability — unacceptable per PP-14.
**Recommendation:** **Option 1** with a Mongo TTL index (90 days) and a sampled subset kept for 12 months for eval. *Why:* auditability is a constitutional requirement and the eval rubric literally scores "did the answer use the assembled context" — that is unanswerable without the snapshot. A few KB per message on free-tier Atlas is negligible; TTL bounds the cost.
**Risks:** DB growth on a high-volume happy path — monitored by D-43 storage policy.
**Dependencies:** D-12 (normalized messages), 07 §7 schema.
**Future impact:** Feeds the eval harness (D-31) and any future analytics.
**Questions requiring Product Owner approval:** (a) Accept 90-day snapshot retention, 12-month sampled? (b) Should farmers be able to delete their context history (export/delete right, PP-11)?

---

### D-03 — Context → prompt rendering contract
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** The Context Engine's output must reach the model in a way that is deterministic, testable, and injection-safe (09 §11). Today's dead `{{...}}` placeholders prove the current contract is broken.
**Available options:**
1. **Server renders** the snapshot into a labelled plain-text "Context" block (profile / location / weather / soil / season / RAG) via a versioned prompt template, with explicit `unknown` markers.
2. Pass the raw JSON snapshot to the model and let it reason over structured input.
3. Hybrid: structured section + distilled prose.
**Advantages:** (1) deterministic, unit-testable (13 §2), token-efficient, keeps user content and context in separate blocks (SEC-11). (2) lets the model decide what to use. (3) flexible.
**Disadvantages:** (1) template must be maintained. (2) JSON is verbose, consumption is unpredictable, harder to assert in tests, larger token cost. (3) two rendering paths to keep in sync.
**Recommendation:** **Option 1.** *Why:* the prompt builder must be testable ("assert the prompt contains the district and an `unknown` soil marker"), and the injection boundary (09 §11) demands context be assembled, not user-concatenated. It is the simplest thing that is deterministic.
**Risks:** Template drift vs. resolver output — mitigate by contract tests per domain.
**Dependencies:** D-07 (prompt registry), 12 §2c.
**Future impact:** New domains (7, 8 in Phase 2) are new template sections only.

---

### D-04 — Decision outcome contract ("Decision Orchestrator")
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** PP-01/04 require every answer to be a decision-support outcome, but today the model returns free prose. Without a typed outcome contract, the frontend cannot render cards, the eval cannot measure actionability, and the product stays a chatbot.
**Available options:**
1. No structure: prompt-level instruction only.
2. **Lightweight orchestrator:** an interaction classifier (question / diagnosis / plan / chit-chat) → per-task prompt template → structured JSON output (schema-validated) → typed response (answer card, diagnosis card, plan card).
3. Full agentic framework (tool loops, planner, multi-step reasoning).
**Advantages:** (2) yields typed, renderable, measurable outcomes with one classifier + schemas; (1) zero work; (3) powerful for complex reasoning.
**Disadvantages:** (1) cannot satisfy PP-01 or the eval rubric; (3) is enterprise complexity, high latency, hard to test — premature for a two-person team.
**Recommendation:** **Option 2, minimal form.** Classify, pick a template, enforce a JSON schema (zod, shared with D-50), render typed cards. *Why:* it is the smallest structure that converts prose into "decision platform" outputs, and schema validation doubles as injection defense (D-37). No agents — the classifier is a single prompt call; complex tooling is deferred until the product demands it.
**Risks:** Classifier misclassification routes a question to the wrong template — mitigate with eval coverage + a `general_answer` fallback template.
**Dependencies:** D-05 (adapter `ask`/`stream` returning structured output), D-07, D-50.
**Future impact:** Diagnosis cards (E3-S4), crop plans (F-30), and alerts all become additional typed outcomes of the same contract.

---

### D-05 — Model Adapter contract (result types & streaming)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** ADR-015 defines the interface (`ask`/`stream`/`vision`/`embed`) but not the **return contract**. If the contract returns bare strings, we cannot measure $/conversation (F-27), provider parity (APP-12), or stream cleanly.
**Available options:**
1. Methods return plain strings / `AsyncIterable<string>`.
2. Methods return **typed envelopes**: `{ text, usage: {inputTokens, outputTokens}, latencyMs, provider, model, structured? }`; streaming via an `AsyncIterable` of chunk events (text + done metadata).
3. Minimal `generate()` only, add methods later.
**Advantages:** (2) cost/latency flow out of the adapter for free, enabling dashboards and parity tests with no extra plumbing; (1) simplest signature; (3) smallest surface.
**Disadvantages:** (2) slightly more contract code; (1) every caller re-derives tokens/latency or they silently aren't measured; (3) `vision` and `embed` and `stream` are committed in ADR-015 — deferring them contradicts the accepted direction.
**Recommendation:** **Option 2.** *Why:* APP-12 (measurable AI) is untestable without usage/latency in the contract, and F-27's cost dashboard would otherwise be guesswork. Provider fakes (13 §2) can assert the envelope shape deterministically.
**Risks:** Envelope over-engineering — kept in check because the fields are exactly what eval, cost, and SSE already need.
**Dependencies:** F-45, 13 §2b, 14 §4 (`MODEL_PROVIDER`/`MODEL_NAME`).
**Future impact:** A second provider (D-44) implements the same envelope; parity tests compare envelopes.

---

### D-06 — Model failure, retry & degradation semantics
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Today a model failure returns a 500 with a leaked stack (SEC-05). With the Context Engine + adapter, we need a defined policy so a provider outage degrades the product instead of breaking it.
**Available options:**
1. Single provider, fail → sanitized error; keep today's RAG-off fallback.
2. + automatic provider failover to a second provider with a circuit breaker.
3. + retry with exponential backoff and timeouts on transient errors.
**Advantages:** (1) simplest, honest; (3) retries smooth transient errors at low cost; (2) survives provider outages.
**Disadvantages:** (1) a Gemini outage = no answers; (2) requires a live second provider (paying for it) and circuit-breaker state — speculative with one provider; (3) retries add latency ceiling.
**Recommendation:** **Option 1 + 3 (retries), defer 2.** One retry with short backoff + per-operation timeout on the adapter; the existing "chat-context-only, `hasContext:false`" fallback remains. *Why:* failover with a single provider is YAGNI — the adapter interface leaves room for it, and D-44 brings the second provider in Phase 2 when failover becomes real. Retries are cheap insurance.
**Risks:** Retries during a sustained outage compound cost/latency — cap retries at 1 and alert on failure rate (D-48).
**Dependencies:** D-05, F-45.
**Future impact:** Circuit breaker + failover slots into the adapter without service changes (APP-05).

---

### D-07 — Prompt registry & versioning
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Prompts are product intelligence (PP-08). 09 §11 mandates a versioned prompt registry with eval gates, but today there is one static inline prompt (`utils/prompts.js`).
**Available options:**
1. Keep the single static prompt.
2. **Versioned registry:** `ai/prompts/<task>/<version>.md` files (system / chat / diagnosis / decision-classifier), loaded by name+version, referenced by the orchestrator.
3. Template engine with partials/components.
**Advantages:** (2) diffable, PR-able, per-task prompts, eval-gated per version; (1) zero change; (3) composable.
**Disadvantages:** (1) cannot support the multi-task contracts of D-04 or D-07 diagnostics; (2) registry bookkeeping; (3) partial indirection with no benefit at this size.
**Recommendation:** **Option 2.** *Why:* D-04 needs at least four distinct templates, and 09 §11 requires every prompt change to pass the golden set and be recorded in the CHANGELOG — that only works if prompts are files, versioned, and testable.
**Risks:** Prompt drift across versions — mitigated by pinning template version into the context snapshot (D-02) so eval can reproduce answers.
**Dependencies:** D-03, D-04, 13 §4.
**Future impact:** Provider-parity eval (13 §4.1) runs each active prompt version on every provider.

---

### D-08 — Session memory window strategy
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Today the model sees a fixed `slice(-6)` messages. With normalized messages (F-28) we can choose a better window; with long sessions the fixed window drops context arbitrarily.
**Available options:**
1. Keep fixed last-6.
2. **Token-budget window:** include messages until a token/char budget (e.g., ~6000 chars tuned) is reached, newest-first.
3. Fixed window + rolling LLM summarization of older messages.
**Advantages:** (2) deterministic and cost-controlled; (3) preserves more context; (1) zero change.
**Disadvantages:** (1) arbitrary, drops middle context unpredictably; (3) adds an LLM call per threshold and an eval burden — premature.
**Recommendation:** **Option 2.** *Why:* it is a pure counting change on top of F-28 normalization, keeps the token budget explicit (cost control per APP-12), and defers summarization until Farm Memory (Phase 2) justifies it.
**Risks:** Very long sessions still lose early context — acceptable in Phase 1; flagged as known limitation in UI copy if needed.
**Dependencies:** D-12 (message normalization), E4-S4.
**Future impact:** Summarization (Phase 2+) bolts onto the same window code.

---

### D-09 — Image processing path & interaction model
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** ADR-017 accepts the diagnosis pipeline but not whether diagnosis is a separate endpoint or part of the chat interaction, nor whether processing is synchronous. This shapes the API, the frontend, and whether we need a queue (D-41).
**Available options:**
1. **Image inside the chat interaction** — `POST /chat` accepts `{ message, image?, farmId? }`; diagnosis flows through the same orchestrator as text; card returned inline.
2. Separate `POST /api/v1/diagnose` endpoint, decoupled from chat.
3. Both paths.
**Advantages:** (1) one orchestration path, diagnosis naturally lives in chat history; (2) cleanly reusable by WhatsApp and the future Pro flow; (3) maximum flexibility.
**Disadvantages:** (1) the diagnose endpoint in 08 §8#6 is then redundant; (2) two context-assembly paths to keep in sync; (3) duplicates orchestration.
**Recommendation:** **Option 1** — images are an optional part of the chat interaction; the orchestrator routes to the diagnosis template when an image is present. *Why:* APP-07 says an image is a diagnosis *input fused with context*, not a standalone call; routing inside the interaction keeps one context-assembly path, and the diagnosis card is rendered as a message attachment — exactly what 09 §6 describes. A future `diagnose`-only resource is a thin wrapper, not a second pipeline.
**Processing flow (sub-decision):** **synchronous** within the request for Phase 1 (≤1 image, ≤5MB, downscaled server-side). *Why:* no queue infra (D-41), the demo flow is "send photo → get diagnosis card", and Lambda timeout is ample. Design the pipeline functions to be idempotent so async can be added later without refactor.
**Risks:** A slow vision call blocks the chat response — acceptable for one image; revisit if p95 > target.
**Dependencies:** D-04, D-22, D-24, E3-S1..S4.
**Future impact:** WhatsApp (E6) and CropDoctor Pro (E7-S4) reuse the same interaction orchestrator.

---

## 4. User Context

### D-10 — Farm profile data model & onboarding question set
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** F-21 creates the `profiles` collection that seeds the Context Engine and Farm Memory. Every field is either an onboarding question or auto-resolved — and PP-02 says ask only what cannot be auto-obtained.
**Available options:**
1. **Minimal:** district (auto-filled from GPS, confirmable), crops, acres. Language already captured.
2. Minimal + soil type and phone number.
3. Full farm model with multiple plots (Phase 2 shape).
**Advantages:** (1) satisfies the "2 taps to first answer" metric and PP-02; (2) phone pre-loads WhatsApp identity; (3) future-proof.
**Disadvantages:** (1) soil/phone must be inferred later; (2) phone is PII we don't need until WhatsApp (E6, Phase 2) — collecting now violates minimization (APP-10); (3) plots are Farm Memory (F-47) work.
**Recommendation:** **Option 1** (+ optional soil override only if the farmer volunteers it). *Why:* district is auto-resolvable from GPS, soil is district-derived (D-19), so the only *necessary* questions are crops and acres. Phone is deferred to WhatsApp enablement. This is the zero-question, minimum-PII answer.
**Risks:** Farmers without GPS must type their district — mitigate by district search/chips UI and "demo mode" for non-TN.
**Dependencies:** E2-S4, D-01, D-13.
**Future impact:** Farm Memory (F-47) extends this schema; nothing here blocks multi-plot later.

---

### D-11 — Farm Memory write & consent policy (design now, build Phase 2)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** ADR-016 accepts Farm Memory for Phase 2 but its **write policy** affects the Phase 1 schema (messages, snapshots) and the consent surface we must build now (PP-11).
**Available options:**
1. AI auto-records every decision silently.
2. **Auto-suggested entries, farmer confirms/edits; all entries editable and deletable.**
3. Only explicit farmer saves.
**Advantages:** (2) zero-question (auto-suggest) + trust (control) + correctability (ADR-016 explicitly requires memory be correctable); (1) zero friction; (3) maximum control.
**Disadvantages:** (1) violates consent/correctability (PP-11, ADR-016 tradeoff); (3) farmers never remember to save — memory never accumulates.
**Recommendation:** **Option 2.** *Why:* the ADR-016 tradeoff explicitly names "memory must be editable and correctable by the farmer"; silent auto-recording of decisions is a trust and DPDP liability; pure manual saving fails the product (PP-05). Auto-suggest + confirm is the proven compromise.
**Risks:** Confirmation fatigue — keep suggestions rare (post-decision, not per message) and defer the build to Phase 2.
**Dependencies:** D-10 (profile), F-47.
**Future impact:** This policy is the template for all future AI-written personal data.

---

### D-12 — Message normalization & session model (F-28)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Unbounded embedded `messages` arrays risk the 16MB doc limit and force full-document reads (07 §3). Stable message IDs are needed for feedback (D-33) and diagnosis-card linking (D-09).
**Available options:**
1. Keep embedded messages, add a cap.
2. **Separate `messages` collection** (sessionId, sender, text, metadata, stable `_id`), paginated.
3. Hybrid: embedded recent-50 + archive collection.
**Advantages:** (2) pagination, stable ids, clean growth; (3) fast recent read; (1) zero migration.
**Disadvantages:** (2) migration + join; (3) two read paths and two write paths to keep consistent; (1) doesn't fix the 16MB risk or stable ids.
**Recommendation:** **Option 2.** *Why:* ADR-005 already anticipates normalization; E4-S4 needs pagination; D-33 and D-09 need stable message ids. A single `messages` collection is the simplest correct model.
**Risks:** Migration of existing `chatsessions.messages` — one-time script with a backfill, covered in tests.
**Dependencies:** E4-S4, E1-S4 (scoping).
**Future impact:** Every future chat feature (feedback, cards, search) reads normalized messages.

---

### D-13 — Anonymous vs authenticated access
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Today chat is technically open. Phase 1 hardens auth (SEC-02). The product question is whether the funnel needs **guest chat before login**, which forces a device-identity system.
**Available options:**
1. **Login required before chat** (weather + language screens stay pre-login).
2. Guest chat with device-generated anonymous id; accounts merged on login.
3. Fully open anonymous chat.
**Advantages:** (1) simplest, satisfies PP-09 "no real users before verified auth", enables per-user rate limits/cost quotas; (2) lower onboarding friction; (3) zero friction.
**Disadvantages:** (1) a farmer who resists Google sign-in cannot try chat; (2) device-identity + merge logic + abuse attribution gaps; (3) cost abuse surface (SEC-08) and no identity — impossible to make trust-safe.
**Recommendation:** **Option 1.** *Why:* APP-09 gates real usage on verified auth; guest chat adds a parallel identity system and an abuse hole for marginal funnel gain at this stage. If onboarding shows that Google sign-in is a blocker for Tamil farmers, revisit with a phone/OTP login (which also unlocks WhatsApp later) — but decide that with data, not speculation.
**Risks:** Sign-in friction for the primary persona — mitigation: one-tap Google on mobile, and phone-OTP auth as the approved Phase-2 alternative.
**Dependencies:** E1-S2..S4, D-35.
**Future impact:** Phone-OTP login (Phase 2, WhatsApp) reuses the same session JWT model.

---

### D-14 — Returning-user continuity without Farm Memory
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Between sign-in and Phase 2 Farm Memory, returning farmers must not be forced to fully re-state their situation (APP-02) — but we must not build a half-memory.
**Available options:**
1. Session history only (status quo).
2. **Persisted farm profile (F-21) auto-loaded into context** each session; continuity = profile + session history.
3. Pull Farm Memory forward into Phase 1 (scope creep).
**Advantages:** (2) the "knows your farm" promise holds from profile alone, cheaply; (1) zero work; (3) full continuity.
**Disadvantages:** (1) farmer restates district/crops every session — violates APP-02; (3) ADR-016 scheduling breach + consent + schema work in Phase 1.
**Recommendation:** **Option 2.** *Why:* the profile is already in Phase 1 scope (F-21) and feeds the Context Engine; continuity across sessions comes from "we remember your farm + your last sessions," which is honest and zero-question without inventing a memory subsystem.
**Risks:** Farmer expectation of deep memory in Phase 1 — set UI copy ("we remember your farm") precisely.
**Dependencies:** D-10, D-01.
**Future impact:** Farm Memory (F-47) layers on top of the same profile.

---

## 5. Weather Integration

### D-15 — Weather provider
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Weather is Context Engine domain 4 and a product promise. The frontend already uses Open-Meteo; the backend proxy (E2-S1) needs a provider decision that is cheap today and upgradeable to official data later.
**Available options:**
1. **Open-Meteo** (current, keyless, free).
2. OpenWeatherMap / Tomorrow.io (paid, better SLA).
3. IMD official feeds (most authoritative, poor APIs).
**Advantages:** (1) free, zero signup, already working, good TN coverage; (2) SLA + support; (3) authoritative, aligns with government advisories (F-48).
**Disadvantages:** (1) no SLA, best-effort (fine for advice, not for liability-grade data); (2) monthly cost; (3) no clean public API.
**Recommendation:** **Option 1, wrapped in a weather-service interface.** *Why:* never pay for weather at startup; Open-Meteo is already proven in the codebase. The interface lets IMD replace it when F-48 (government data) makes official sources necessary. Paying for weather before scale is a waste of the ₹1.50/conversation budget.
**Risks:** Open-Meteo availability — mitigated by D-18 (degradation) and a cheap fallback via the same interface.
**Dependencies:** E2-S1.
**Future impact:** IMD swap in Phase 2 is a new adapter behind an unchanged interface.

---

### D-16 — Weather cache store & TTL
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** The backend must not hit the provider on every chat request. Lambda instances are ephemeral, so where the cache lives matters.
**Available options:**
1. In-memory per-instance cache (dies on cold start).
2. **Mongo `weathercache` collection, TTL index ~30 min**, keyed by district.
3. Managed cache (Redis/Momento/DynamoDB).
**Advantages:** (2) survives cold starts, zero new infra, TTL auto-expiry, fits the 38-district key space; (1) zero infra; (3) fastest, best concurrency.
**Disadvantages:** (1) unreliable across Lambda instances; (3) new service + cost + ops for a tiny key space.
**Recommendation:** **Option 2.** *Why:* Mongo already exists; a TTL-indexed document per district is configuration-level simplicity that works across cold starts. Redis/DynamoDB is unjustified until measured cache-hit pressure or concurrency demand exists (D-42).
**Risks:** One extra DB read per cache miss — negligible; monitor hit rate.
**Dependencies:** E2-S1, D-12 (no; independent), 07 schema.
**Future impact:** Promotes cleanly to DynamoDB/Redis if the key space or TPS grows.

---

### D-17 — Weather refresh strategy
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** E2-S1 says "30-min TTL". The question is whether we pre-fetch all districts on a schedule or fill lazily.
**Available options:**
1. **Lazy fill on cache miss** (fetch on first request per district, then TTL).
2. Scheduled pre-fetch of all 38 districts every 30 min.
3. Both.
**Advantages:** (1) fetches only what is asked, simplest; (2) warm data, deterministic freshness; (3) best freshness.
**Disadvantages:** (1) first request per district is slower; (2) wasteful at startup volume (38 × 48 calls/day for possibly zero demand); (3) complexity + wasted calls.
**Recommendation:** **Option 1.** *Why:* at startup, fetching 38 districts nobody asked about is pure waste; the scheduler (D-40) only becomes relevant when proactive alerts (F-31, Phase 2) need warm data. Lazy fill keeps the code path in the request handler.
**Risks:** Slightly slower first answer in a cold district — bounded by caching (D-16) and acceptable.
**Dependencies:** D-16, D-40 (later).
**Future impact:** Switches to scheduled refresh with alerts (F-31) without changing the cache schema.

---

### D-18 — Weather failure handling
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Weather is enrichment, not a gate. A provider outage must not block answers (APP-03 degrade rule).
**Available options:**
1. Error → block the answer.
2. Serve stale cache + freshness note.
3. **Weather domain = `unknown`, answer proceeds** (APP-03), optionally with stale cache if present.
**Advantages:** (3) keeps the product up and is consistent with Context Engine degrade rules; (2) preserves value from old data; (1) honest failure.
**Disadvantages:** (1) turns a weather outage into a product outage; (2) risks stale advice without labeling.
**Recommendation:** **Option 3 + 2 hybrid:** use any cached value (even expired) labelled with its timestamp, else `unknown`, and never block. *Why:* availability beats freshness for chat advice; the snapshot records freshness so the model and UI can be honest (APP-06).
**Risks:** Acting on stale weather in a pest/disease case — mitigate: freshness label forces the model to hedge on time-sensitive advice.
**Dependencies:** D-02 (snapshot records freshness), D-16.
**Future impact:** Alerting (F-31) will have its own stricter staleness policy.

---

## 6. Soil Intelligence

### D-19 — Soil data source
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Soil is Context Engine domain 5. The current plan seeds district-level soil from frontend research data (E2-S2). We must be explicit about granularity to avoid over-claiming.
**Available options:**
1. **District-level static table** (`districts` collection: district → typical soil type), from TNAU district soil maps + published sources.
2. Field-level Soil Health Card (SHC) data via state portals/partnerships.
3. Farmer-reported soil type at onboarding.
**Advantages:** (1) cheap, credible, immediately available; (2) farm-accurate; (3) farmer-verified.
**Disadvantages:** (1) indicative, not farm-specific; (2) no reliable public API, needs institutional partnership (Phase 3+); (3) contradicts PP-02 unless truly unobtainable.
**Recommendation:** **Option 1 for Phase 1**, with Option 3 as an *optional volunteer* override (D-21), Option 2 as a Phase 3+ partnership. *Why:* there is no trustworthy public field-level soil API for TN today; district soil maps (TNAU) are a legitimate, cheap baseline that satisfies "knows your soil" at region scale, and PP-06 is satisfied as long as we label it (D-20).
**Risks:** A wrong soil assumption can yield harmful advice — directly mitigated by D-20 labeling and D-26 escalation.
**Dependencies:** E2-S2, D-20.
**Future impact:** SHC integration slots in as a higher-granularity data source behind the same lookup.

---

### D-20 — Soil accuracy labeling
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** District soil is not farm soil. Presenting it as fact violates APP-06 (evidence over opinion) and can produce wrong fertilizer advice.
**Available options:**
1. Present district soil as fact.
2. **Label explicitly** ("typical for your district") in the context block and UI; eval rubric penalizes over-claiming.
3. Hide soil when not farm-verified.
**Advantages:** (2) preserves usefulness + honesty; (1) simplest; (3) most conservative.
**Disadvantages:** (1) fabricates certainty (groundedness failure); (3) throws away the district signal entirely.
**Recommendation:** **Option 2.** *Why:* the model must hedge ("based on typical soil for Thanjavur…") and the eval rubric must check it; labeling is one template string and one rubric clause — the cheapest honest option.
**Risks:** Prompt drift weakening the label — covered by golden-set groundedness cases.
**Dependencies:** D-03, D-19, 13 §4.1.
**Future impact:** Farm-verified soil (SHC) removes the label when present.

---

### D-21 — Soil fallback
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** If the `districts` lookup is missing a district (new data, non-TN demo), we need a defined behavior.
**Available options:**
1. **`unknown` flag; proceed; optional farmer-provided override stored in profile.**
2. Default to a regional "typical" soil type silently.
3. Ask the farmer (required field).
**Advantages:** (1) honest, zero-question-compatible, preserves the answer; (2) never empty; (3) farm-accurate.
**Disadvantages:** (1) occasionally no soil context; (2) silently fabricates context (APP-06); (3) asks what the system should auto-derive for most users (PP-02).
**Recommendation:** **Option 1.** *Why:* consistency with the Context Engine degrade rule (missing domain → explicit `unknown`); guessing is the one behavior the constitution forbids.
**Risks:** Farmers in uncovered districts get hedged advice — acceptable and self-heals as reference data grows.
**Dependencies:** D-19, D-20, D-10 (optional override field).
**Future impact:** None — the fallback is permanent behavior.

---

## 7. Image Diagnosis

### D-22 — Upload transport
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** E3-S1 plans an upload path. Multipart-to-backend vs presigned-S3 changes security surface, round-trips, and S3 policy work.
**Available options:**
1. **Multipart to the backend** (busboy/multer) → validate → downscale → process → store.
2. Presigned S3 PUT from the frontend → backend completes on notification.
3. Base64-in-JSON.
**Advantages:** (1) one round-trip, validation/EXIF-strip in one place, no S3 policy for client uploads; (2) no image bytes through Lambda, scales to big files; (3) trivially simple.
**Disadvantages:** (1) image bytes hit Lambda memory/bandwidth (fine ≤5MB); (2) signing endpoint + S3 CORS + completion states — more moving parts; (3) 33% size overhead, bad for any real image.
**Recommendation:** **Option 1** for Phase 1 (≤1 image, ≤5MB, content-type sniff, dimension caps, EXIF stripped). *Why:* one bounded, testable path; presigned uploads earn their complexity only when files get large (multi-image Pro, E7-S4).
**Risks:** Lambda memory at 5MB × concurrent requests — bounded by body limit + rate limiting (D-38).
**Dependencies:** E3-S1, D-09, D-24.
**Future impact:** Presigned path can be added for large/multi-image without changing the pipeline downstream.

---

### D-23 — Image storage & retention
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** 09 §6 requires images stored with the message; APP-10 requires minimization and retention policy.
**Available options:**
1. **S3 private bucket + short-lived signed GET URLs; lifecycle delete after 90 days; delete with user/session.**
2. Mongo GridFS.
3. Ephemeral (process and discard).
**Advantages:** (1) S3 already in stack, lifecycle is config-only, keeps bucket private; (2) one store; (3) minimal storage.
**Disadvantages:** (1) signed-URL plumbing; (2) GridFS is clumsy for images and bloats Mongo; (3) breaks "stored with the message" and blocks re-analysis/feedback.
**Recommendation:** **Option 1.** *Why:* storage + retention is exactly what S3 lifecycle rules do with zero application code; signed short-lived URLs keep the bucket private; a 90-day lifecycle satisfies DPDP minimization (D-39). GridFS adds no capability we need.
**Risks:** Leaked signed URLs — short TTL (≤15 min) + no `list` permissions.
**Dependencies:** E3-S1, D-25, D-39.
**Future impact:** Re-analysis (Pro) re-reads the same object; deletion is a lifecycle rule.

---

### D-24 — Image privacy (EXIF, consent)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Images can contain faces, license plates, and GPS EXIF — precise PII (ADR-017 tradeoff, APP-10).
**Available options:**
1. **Strip EXIF on receipt; never read/store image GPS; explicit consent copy at first image use; retention + delete honored.**
2. Store EXIF (for location matching).
3. Refuse/process as-is.
**Advantages:** (1) minimizes PII at the earliest point; (2) free location signal; (3) simple.
**Disadvantages:** (1) loses an optional location signal (we already have GPS via the browser); (2) stores precise PII without consent by default — DPDP risk; (3) stores geotags/PII silently.
**Recommendation:** **Option 1.** *Why:* location is already obtainable via browser GPS consent; storing EXIF GPS is redundant PII we must not hold. Strip-first is a one-call rule that satisfies APP-10 with no product loss.
**Risks:** Overt PII (faces) in diagnosis images — mitigate with a refusal/notice for obviously personal images and the existing no-people scope rules; full blurring is deferred.
**Dependencies:** D-22, D-23.
**Future impact:** Image consent becomes a reusable consent atom for Farm Memory (D-11).

---

### D-25 — Confidence scoring & escalation (APP-13)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** A wrong diagnosis can cost a harvest; PP-13 requires escalation where errors are expensive/irreversible. We need a defined confidence/escalation contract in the diagnosis card.
**Available options:**
1. No confidence signal.
2. Model self-reported confidence field only.
3. **Self-reported confidence + rule-based category guardrails:** known high-stakes categories (suspected pesticide exposure, rapid wilting, emergency) and low confidence always add "consult your agricultural officer" + escalation branch.
**Advantages:** (3) honest + actionable; (1) simple; (2) cheap signal.
**Disadvantages:** (1) no escalation trigger; (2) LLM confidence is uncalibrated/overconfident — alone it's a weak gate.
**Recommendation:** **Option 3.** *Why:* combine the (weak but useful) model confidence with hard rules on high-stakes categories — the diagnosis schema (D-04) carries `confidence`, `severity`, `escalate: bool`, and the card renders the officer-consult branch when triggered. No ML calibration needed; thresholds are set from the eval set (D-31).
**Risks:** Missed escalations — mitigate with eval cases covering high-stakes categories and a weekly human review (D-33).
**Dependencies:** D-04 (schema), E3-S4 (card), 13 §4.1.
**Future impact:** Expert-escalation queue (E7-S4) consumes `escalate: true` directly.

---

## 8. Knowledge Base

### D-26 — Content source & curation model
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** RAG quality is the trust ceiling (PP-06/APP-06). The current S3-CSV→concatenated-text pipeline (09 §3) produces poor chunks and no metadata, causing generic answers across TN.
**Available options:**
1. Keep the S3 CSV pipeline.
2. **Curated, sourced content store:** structured documents (markdown/JSON) with per-item provenance (source, date, author), crop/district/season tags, and a review status; served to the vector store.
3. Hybrid: CSV bulk import + curated vetted set.
**Advantages:** (2) provenance + metadata enable filtered retrieval (D-30) and honest sourcing (APP-06); (1) zero change; (3) gradual migration.
**Disadvantages:** (2) authoring effort; (1) documented defects (no filters, truncated rows) persist; (3) two ingestion formats to maintain.
**Recommendation:** **Option 2**, migrated incrementally from the CSVs. *Why:* metadata filters (E2-S5) and provenance are impossible with the current text-concat chunks; curated content is product intelligence (PP-08) that we own. This is the single highest-leverage change for answer quality.
**Risks:** Migration cost — sequence by crop/district starting with the roadmap pilot districts (PP-12 depth over breadth).
**Dependencies:** E2-S5, D-27, D-28.
**Future impact:** Multi-state expansion (F-39) is just new knowledge packs (D-27) in this store.

---

### D-27 — Knowledge versioning & idempotent ingestion
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** ADR-011 documents non-deterministic chunk IDs (`Date.now()`) and duplicate-on-reingest. Without versioning we cannot roll back or ship knowledge confidently.
**Available options:**
1. Versionless (status quo).
2. **Knowledge packs with deterministic IDs** (pack + doc + chunk index or content hash), idempotent upserts, pack-level version + rollback.
3. Full content registry with publish workflow.
**Advantages:** (2) fixes ADR-011 with moderate work; (1) zero work; (3) governance-grade.
**Disadvantages:** (2) ingestion script must change; (1) stale/duplicated knowledge persists; (3) overkill for 1-2 engineers.
**Recommendation:** **Option 2.** *Why:* deterministic IDs + upsert + pack version is a config-to-software change that eliminates the documented defect and gives rollback; the publish workflow (3) adds nothing we need yet.
**Risks:** Rollback of a pack with dependent eval cases — keep pack→eval-case mapping.
**Dependencies:** D-26, D-29.
**Future impact:** Every knowledge pack version is auditable; CHANGELOG entry per release.

---

### D-28 — Content validation
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Garbage rows, truncated CSVs, and missing provenance silently degrade answers (09 §3). Validation must be cheap and automated.
**Available options:**
1. Manual review only.
2. **CI/ingestion-time validation:** schema checks (required fields, provenance, tags), duplicate/conflict detection, dry-run before publish.
3. + automated golden-set eval gate per pack.
**Advantages:** (2) catches the common failure modes automatically; (1) zero tooling; (3) quality-gates every pack.
**Disadvantages:** (2) needs a validation script; (1) human review doesn't scale and misses systemic issues; (3) slow, rarely changes outcomes at this size.
**Recommendation:** **Option 2** in Phase 1. *Why:* schema + provenance + duplicate checks are a small script that kills the top failure classes; eval-gating every pack (3) is a latency/cost burden with marginal benefit until the pack count grows.
**Risks:** Semantic errors (wrong content, right schema) slip through — covered by eval cases + D-33 review.
**Dependencies:** D-26, D-27.
**Future impact:** The validation script grows into a publish gate.

---

### D-29 — Retrieval strategy
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Top-3 unfiltered vector retrieval returns generic, possibly cross-region chunks (09 §3 defect). Retrieval quality directly sets answer quality and cost.
**Available options:**
1. Top-3 vector only (status quo).
2. **Metadata-filtered vector** (district/crop/season) with top-k tuned (3→5) and better chunk overlap.
3. Hybrid BM25 + vector with rerank.
**Advantages:** (2) config-level fix for the documented "generic across TN" issue; (3) best precision; (1) zero change.
**Disadvantages:** (2) requires tags in content (D-26); (3) extra index + latency + complexity — only justified if eval shows precision gaps.
**Recommendation:** **Option 2** (E2-S5). *Why:* ChromaDB metadata filters are a query-option change; they directly fix the documented defect. Hybrid/rerank (3) is a Phase-2 decision driven by eval measurements, not speculation.
**Risks:** Over-filtering (no chunks match district) — filter softly: apply district, fall back to crop-only, then unfiltered.
**Dependencies:** D-26, E2-S5.
**Future impact:** Hybrid retrieval slots in behind the same router interface.

---

## 9. AI Evaluation

### D-30 — Accuracy scoring approach
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** The golden set (13 §4.1) needs a scoring mechanism. Manual scoring of 50-100 cases per change is unsustainable; an unvetted LLM-as-judge is unreliable.
**Available options:**
1. Human scoring only.
2. LLM-as-judge only.
3. **LLM-as-judge pre-score + human review of failures/disagreements.**
**Advantages:** (3) fast + auditable; (2) fast; (1) most accurate.
**Disadvantages:** (3) some orchestration; (2) judge bias/overconfidence uncaught; (1) does not scale to CI.
**Recommendation:** **Option 3.** *Why:* 13 §4.1/4.2 requires golden-set scoring in CI — only machine scoring scales there; but a judge is a proxy, so weekly human review of failures keeps the gate honest. Judge = a fixed rubric prompt + separate model call (documented as a proxy).
**Risks:** Judge drift across model versions — pin the judge prompt/version and log disagreements.
**Dependencies:** E5-S3, D-07 (rubric prompt versioned).
**Future impact:** Becomes the gate for provider swaps (D-44) and prompt changes.

---

### D-31 — Golden dataset ownership & growth
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** The eval set is product intelligence (PP-08) and must be owned, diffable, and CI-runnable.
**Available options:**
1. Scattered local files.
2. **Versioned in the product repo** (`ai/eval/cases/*.json`): question + rubric expectations, Tamil/English/Tanglish, grown from real missed queries.
3. External eval platform (LangSmith etc.).
**Advantages:** (2) versioned with code, PR-able, no vendor cost; (1) zero setup; (3) rich tooling.
**Disadvantages:** (2) needs curation discipline; (1) lost/inconsistent; (3) cost + vendor + latency — premature at 1-2 engineers.
**Recommendation:** **Option 2**, starting at 50+ cases per 13 §4.1. *Why:* the eval set is exactly the "product intelligence we own" that PP-08 protects; keeping it in-repo makes CI and PR review trivial and costs nothing.
**Risks:** Stale rubrics — enforce a "cases updated with prompts" rule in 12 §11 review checklist.
**Dependencies:** E5-S3, D-30.
**Future impact:** Migrates to an external platform only when the team and volume outgrow the repo.

---

### D-32 — Human feedback capture
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Golden sets measure; only real farmers reveal the long tail. Feedback must be captured with minimal UI and stored per message.
**Available options:**
1. No feedback capture.
2. **Thumbs up/down per answer + optional note, stored on the normalized message; weekly review queue.**
3. Full rating system (stars, categories).
**Advantages:** (2) cheapest meaningful signal, needs stable message ids (D-12); (1) zero UI; (3) richer.
**Disadvantages:** (2) still needs review discipline; (1) no real-user signal; (3) cognitive load for farmers and more UI — unnecessary.
**Recommendation:** **Option 2.** *Why:* thumbs + free-text is the standard trust signal; storing on normalized messages makes it queryable for the D-33 loop. It also feeds the escalation queue (D-25).
**Risks:** Feedback stored = PII if notes contain personal data — store minimally, redact in logs (D-49).
**Dependencies:** D-12, E4-S4.
**Future impact:** Ratings become input to expert-escalation triage (E7-S4).

---

### D-33 — Continuous improvement loop
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** 09 §10's feedback loop is the moat; without a defined loop, quality stalls.
**Available options:**
1. None.
2. **Missed-query detection (thumbs-down + low confidence) → weekly triage → add golden case → fix knowledge/prompt → eval → release.**
3. Automated self-improvement (auto-update knowledge/prompts from feedback).
**Advantages:** (2) closes the loop with human judgment; (1) zero work; (3) fast.
**Disadvantages:** (2) needs weekly discipline; (1) quality never improves; (3) auto-training on user data without consent violates APP-10 and is dangerous.
**Recommendation:** **Option 2.** *Why:* the loop matters, but automation of knowledge/prompt changes at 1-2 engineers is premature and risky; a weekly triage of flagged answers with a structured backlog is the honest scale for a startup.
**Risks:** Triage slips — make it a standing Phase 1 ritual (covered in 13 §4.2 workflow).
**Dependencies:** D-30, D-31, D-32.
**Future impact:** Automates only after volume justifies it (with consent mechanisms first).

---

## 10. Security

### D-34 — Authentication mechanism & token storage (ADR-013 implementation)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** SEC-01/02/06 are critical. ADR-013 chose "verify once at login, issue our own session JWT," but the token *transport/storage* (httpOnly cookie vs bearer-in-memory) is still open and drives the frontend rework (E1-S12).
**Available options:**
1. **Bearer access token (short-lived, ~15 min) held in memory; refresh token (~30 days, rotating, revocable) in an httpOnly `Secure; SameSite=Lax` cookie; refresh via cookie + CSRF-safe header.**
2. Both tokens in localStorage (today's anti-pattern, but simplest).
3. Both tokens in httpOnly cookies (all requests cookie-authed).
**Advantages:** (1) access token kept out of storage entirely (XSS can't steal a never-stored token); refresh is protected by httpOnly; SameSite+Lax + custom-header check handles CSRF for JSON APIs; (2) simplest; (3) safest against XSS.
**Disadvantages:** (1) access token in memory is lost on full page reload → a short silent re-auth (acceptable; or keep refresh flow fast); (3) cookie+CSRF for every request adds plumbing; (2) XSS → full account takeover (current SEC-06).
**Recommendation:** **Option 1.** *Why:* it eliminates the localStorage exposure (SEC-06) without the heavier cookie-only API surface; SameSite=Lax plus a required custom header on the refresh route is sufficient CSRF defense for a JSON API behind CORS allow-list. This matches ADR-013's chosen direction.
**Risks:** XSS in a dependency could still read the in-memory token — mitigate with CSP + the D-37 guardrails; token revocation store for the refresh path.
**Dependencies:** E1-S2, E1-S3, E1-S12, D-35.
**Future impact:** Phone-OTP login (Phase 2) issues the same session tokens.

---

### D-35 — Authorization & ownership model
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** SEC-02 is critical: identity today is a client-supplied email. We must define the post-auth authorization model.
**Available options:**
1. **`requireAuth` middleware + ownership scoping** — `{ _id, user: req.user.id }` everywhere; foreign resources return 404; identity from token only.
2. Option 1 + roles (admin).
3. Fine-grained policy engine (ABAC).
**Advantages:** (1) fixes SEC-02 with minimal code; (2) prepares admin surfaces; (3) flexible.
**Disadvantages:** (1) no roles (fine — none needed); (3) enterprise complexity; (2) unused role plumbing.
**Recommendation:** **Option 1**, with a single reserved `role` field for future admin (no role logic in Phase 1). *Why:* SEC-02 remediation is ownership scoping; there is no admin surface until Phase 3+ (08 §5 `/test` is being removed, not replaced). Policy engines are premature.
**Risks:** Missed query paths — covered by mandatory negative tests (cross-user read/delete/clear) in 13 §3.
**Dependencies:** E1-S4, E1-S5, D-34.
**Future impact:** Admin (Phase 3) gates by role claim without rearchitecting.

---

### D-36 — AI abuse protection (prompt injection, guardrails)
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** SEC-11 is open: user input and RAG content share the prompt with no sanitization. Injection can hijack the assistant or leak context.
**Available options:**
1. Prompt-level rules only (status quo +).
2. **Separation of instruction/context/content blocks (09 §11) + schema-validated structured outputs (D-04) + adversarial & unsafe cases in the golden set + flagged-query logging (no PII).**
3. Dedicated moderation model/classifier.
**Advantages:** (2) structural defense + testable gate; (1) cheap; (3) strongest filtering.
**Disadvantages:** (2) needs the schema-validated pipeline (already planned in D-04); (1) provably weak; (3) extra cost/latency with low value for agronomy scope.
**Recommendation:** **Option 2.** *Why:* instruction/content separation is a template fix; schema validation rejects anything that breaks the JSON contract — injection payloads usually do; adversarial cases make the eval gate (D-30) enforce it continuously. A moderation model is a paid safety theater here.
**Risks:** Sophisticated injection inside a *valid* schema field — mitigated by golden-set adversarial cases and the groundedness rubric.
**Dependencies:** D-03, D-04, D-30.
**Future impact:** Output guardrails compose with D-25 escalation.

---

### D-37 — Rate limiting & cost quotas
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** SEC-08/09: AI cost abuse is the real threat, and paid API abuse can bankrupt a startup before scale.
**Available options:**
1. Per-IP rate limit only (in-app).
2. **Per-user + per-IP limits with a daily/monthly cost quota** (per-user message caps, $/day budget, 429 + alerting) using Mongo-backed counters.
3. API-Gateway/WAF throttling at the edge.
**Advantages:** (2) targets the real abuse vector (per-user AI cost) and is enforceable across Lambda instances via Mongo counters; (1) simple but per-instance weak; (3) edge-level, no in-app changes.
**Disadvantages:** (2) a DB write per counted request; (1) bypassable (spoofed instances, no identity on today's stack); (3) no per-user intelligence without WAF rulesets; added infra now.
**Recommendation:** **Option 2** — strict input caps (message length, image size) + per-user message/quota limits + per-IP basic limits + an anomaly/cost alert; revisit API-Gateway throttling only when a second channel (WhatsApp) arrives. *Why:* per-user quotas are what actually stop cost abuse, and Mongo counters work across Lambda cold-start instances where in-memory limits fail.
**Risks:** Quota DB load — counters are single-field incs; fine at startup volume.
**Dependencies:** E1-S8, D-34 (identity), F-24.
**Future impact:** Per-plan quotas (Pro tier, F-33) reuse the same counter model.

---

### D-38 — Privacy / consent / DPDP framework
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** SEC-13: Phase 1 introduces the farm profile + consent surface that Farm Memory (Phase 2) will multiply. Getting mechanics right now is cheaper than retrofitting.
**Available options:**
1. Privacy policy document only.
2. **Privacy policy + plain-language (Tamil) consent at onboarding + export/delete endpoints + retention TTLs + PII encrypted at rest (phone/GPS) + no PII in logs/URLs.**
3. Formal DPDP compliance program/audit now.
**Advantages:** (2) builds the mechanism the product needs; (3) institutional-grade; (1) cheapest.
**Disadvantages:** (2) real but bounded work; (3) legal/process overhead premature at pilot scale; (1) no mechanism behind the promise.
**Recommendation:** **Option 2** in Phase 1; formal DPDP audit before scale (Phase 2+). *Why:* PP-11 and ADR-016 both require consent/retention/correctability mechanics; building them with the profile is incremental, while a formal compliance program now is premature for a pilot.
**Risks:** Consent UX friction — single Tamil plain-language consent step at onboarding, revocable in settings.
**Dependencies:** D-10, D-24, D-34.
**Future impact:** Farm Memory (D-11) and B2B analytics (E8-S1) inherit the same consent atom.

---

## 11. Scalability

### D-39 — Scheduled jobs
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Scheduled ingestion (ADR-011 fix) and future alerts (F-31) need a cron mechanism; Lambda has no cron built in.
**Available options:**
1. In-process timers.
2. **AWS EventBridge Scheduler → same Lambda (event-triggered ingestion/alert jobs).**
3. SQS + worker Lambda.
**Advantages:** (2) config-only, ~$1/mo, invokes the existing Lambda; (1) zero infra; (3) queue-backed scaling.
**Disadvantages:** (1) timers die with cold-start / instance lifecycle — not reliable on Lambda; (3) consumer + DLQ + observability overhead.
**Recommendation:** **Option 2** for the nightly ingestion job; queue-backed (3) only when async *volume* (D-40) demands it. *Why:* scheduled ingestion is exactly one cron; EventBridge Scheduler is the cheapest native cron and reuses the same code path.
**Risks:** Overlapping invocations (ingest takes longer than schedule) — idempotent ingestion (D-27) makes overlap harmless.
**Dependencies:** D-27, ADR-011 supersede.
**Future impact:** Alerts (F-31) become additional scheduled targets.

---

### D-40 — Queue strategy
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Whether we introduce SQS shapes the image pipeline (D-09), alerting, and ops load.
**Available options:**
1. **No queue in Phase 1 — all request-scoped synchronous; pipeline functions idempotent by design.**
2. SQS standard for async diagnosis/alerts.
3. FIFO + DLQ discipline now.
**Advantages:** (1) simplest ops, zero new moving parts; (2) decouples long jobs; (3) exactly-once semantics.
**Disadvantages:** (1) a slow pipeline stage delays the response (bounded by D-09 sync choice); (2) consumer, retries, DLQ, observability cost; (3) more of the same.
**Recommendation:** **Option 1**, with idempotency designed in (deterministic job keys) so SQS can be introduced without refactor. *Why:* there is no Phase 1 beneficiary of a queue — all work is request-scoped or scheduled-cron; queues are pure overhead until async volume or retry semantics are real.
**Risks:** Sync processing latency on the diagnosis path — the D-09 decision accepts it for one image.
**Dependencies:** D-09, D-39.
**Future impact:** Alerts (F-31) and multi-image (E7-S4) are the trigger to adopt Option 2.

---

### D-41 — Caching strategy
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Weather caching (D-16) is the first cache. We need one policy for all caching so we don't add Redis preemptively.
**Available options:**
1. **Mongo-backed TTL caches (weather, reference data in DB) + TanStack Query + CDN for static assets.**
2. Managed cache (Redis/Momento) for everything.
3. No caching.
**Advantages:** (1) zero new infra, covers weather/reference/embeddings with TTL indexes; CDN for static is cheap and big; (2) fastest; (3) simplest.
**Disadvantages:** (1) cache hits cost a Mongo read; (2) cost + ops for a 38-district key space; (3) provider load + latency + cost per request.
**Recommendation:** **Option 1.** *Why:* the entire cacheable key space today is ~38 districts + reference data + embeddings — Redis is unjustified until measured cache pressure exists (then it's a drop-in behind the same interface, D-16). TanStack Query (12 §frontend) handles the frontend cache.
**Risks:** Embedding query cache (09 §3 defect) — cache `embedQuery` results keyed by normalized text hash in Mongo.
**Dependencies:** D-16, E2-S1.
**Future impact:** Cache service abstraction keeps Redis a config-level swap.

---

### D-42 — Storage growth policy
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Unbounded messages, snapshots, and images will hit free-tier Atlas limits and the documented 16MB doc risk.
**Available options:**
1. No policy.
2. **Per-user quotas (session/message caps) + retention TTLs (snapshots 90d, images 90d, logs 30d) + archived old sessions.**
3. Sharding/partitioning.
**Advantages:** (2) configuration-level controls; (1) zero work; (3) scales.
**Disadvantages:** (2) needs the TTL/quota plumbing (small); (1) documented risk materializes; (3) enterprise-grade, premature.
**Recommendation:** **Option 2.** *Why:* quotas + TTLs are the documented mitigations in 07 §3/§7 and are cheap; sharding at this volume is absurd.
**Risks:** A quota surprises a heavy user — surface limits in UI copy (e.g., "past sessions archived after 90 days").
**Dependencies:** D-02, D-12, D-23.
**Future impact:** Pro tier (E7) overrides quotas per plan.

---

### D-43 — Multi-LLM readiness
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** PP-07/08 require provider replaceability by config, gated by eval parity. The question is *how much* of that to build in Phase 1 vs Phase 2.
**Available options:**
1. **Adapter contract + provider fakes + provider-parity tests (13 §4.1) in Phase 1; no live second provider.**
2. + one live parity-tested second provider in Phase 1.
3. Auto-failover between providers in Phase 1.
**Advantages:** (1) delivers the PP-07 contract with zero second-provider cost; (2) proves swapability live; (3) resilience.
**Disadvantages:** (1) swapability unproven until Phase 2; (2) pays for + maintains a second provider now; (3) adds circuit-breaker + state machinery (see D-06).
**Recommendation:** **Option 1.** *Why:* the contract and parity tests are the deliverable that satisfies PP-07; paying for and tuning a second provider before eval shows Gemini failing is speculation. Phase 2 brings the real swap through the same gate.
**Risks:** Contract gaps discovered only on real swap — mitigate by using a real (free-tier) second provider in *integration tests only*.
**Dependencies:** D-05, D-06, D-30, F-45.
**Future impact:** Provider selection becomes a config + eval decision per APP-12.

---

## 12. Deployment

### D-44 — Local development environment
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Phase 0 metric is "new engineer starts in <1h"; today local setup is manual (`.env`, no `.env.example`, Mongo choice undocumented).
**Available options:**
1. Status quo (manual `.env`, local/Atlas Mongo, direct deps).
2. **`.env.example` both repos + Mongo via local install or Atlas + seed script for `districts`/reference data + documented quickstart.**
3. Full Docker Compose stack (Mongo + app) locally.
**Advantages:** (2) minimal, meets the <1h metric; (1) zero work; (3) reproducible infra.
**Disadvantages:** (2) some setup docs; (1) onboarding friction + secrets confusion; (3) Compose for one service adds a tooling dependency few will use daily.
**Recommendation:** **Option 2.** *Why:* `.env.example` is already E1-S10; a seed script for reference data is needed for E2-S2 anyway. Docker Compose earns its place only when more services exist.
**Risks:** Version skew between local Node 20 and Lambda Node 24 — already flagged in 12 §4; CI catches it.
**Dependencies:** E1-S10, E2-S2.
**Future impact:** Compose can be added later without rework.

---

### D-45 — Staging environment
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** E5-S6 requires gated deploys and no direct-to-prod (SEC-12); AI eval (13 §8) needs a real full stack.
**Available options:**
1. Reuse prod Lambda behind an alias.
2. **Separate staging Lambda (or alias) + dedicated free-tier Mongo DB + staging Chroma tenant + rate-limited real AI + frontend preview (Vercel/Netlify).**
3. Staging only on a developer machine.
**Advantages:** (2) isolates eval/QA from prod data; (1) cheapest; (3) zero infra.
**Disadvantages:** (2) two environments to manage; (1) shared prod DB risk; (3) not a real environment.
**Recommendation:** **Option 2 (light).** *Why:* eval and smoke testing (13 §8) need a real-but-isolated stack; free tiers make it ~$0. The 14 §5 flow (tag → staging → smoke → prod alias) is the minimum credible release discipline.
**Risks:** Config drift between staging/prod — keep env parity in the deploy script (12 §…).
**Dependencies:** E5-S6, D-47.
**Future impact:** Grows into the standard release gate.

---

### D-46 — Production deploy & rollback
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Today push-to-main auto-deploys (SEC-12) with no rollback story.
**Available options:**
1. Status quo (push-to-main auto-deploy).
2. **Tag-gated pipeline: CI (lint→test→eval) → staging → smoke → promote Lambda alias to prod; rollback = revert alias; image tagged by SHA.**
3. Blue-green infra.
**Advantages:** (2) config-level on Lambda, real rollback; (1) fast; (3) instant rollback.
**Disadvantages:** (2) release ceremony; (1) no gate (SEC-12); (3) infra overhead.
**Recommendation:** **Option 2.** *Why:* Lambda versioned aliases make tag-gated promote/rollback a single `update-alias` call; it satisfies SEC-12 and the 14 §7 release checklist without blue-green machinery.
**Risks:** Slow tag promotion — acceptable; a documented rollback drill in the runbook.
**Dependencies:** E5-S6, D-45.
**Future impact:** Scales to blue-green only if downtime sensitivity demands it.

---

### D-47 — Monitoring stack
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** F-27/E5-S5: cost-per-conversation and latency are Phase 1 success metrics — they are unverifiable without monitoring.
**Available options:**
1. CloudWatch only.
2. **CloudWatch + Sentry (frontend+backend errors) + pino structured logs + a $/conversation & latency dashboard (Grafana Cloud free or computed metrics).**
3. Full APM (Datadog/New Relic).
**Advantages:** (2) covers errors, cost, latency with free/low-cost tooling; (1) zero setup; (3) deep tracing.
**Disadvantages:** (2) dashboard assembly effort; (1) no error context or cost math; (3) expensive, premature.
**Recommendation:** **Option 2.** *Why:* the success metrics require cost/latency *numbers*; Sentry gives production error context at low cost; APM is overkill for a two-service system.
**Risks:** Metric drift — the adapter envelope (D-05) is the single source of token/latency numbers feeding the dashboard.
**Dependencies:** D-05, E5-S5.
**Future impact:** Grafana/APM upgrade path exists when traces matter.

---

### D-48 — Logging standard
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** Current `logentries.js` is unused and unsuitable for Lambda (12 §7); debugging at startup happens in logs, and PII must never be logged (APP-10).
**Available options:**
1. Console.log / current util.
2. **pino structured JSON → CloudWatch; request-id correlation; chat latency breakdown (embed/retrieve/generate); cost markers; PII redaction; 30-day retention.**
3. + log analytics pipeline/OTel.
**Advantages:** (2) standardized, cheap, searchable; (1) zero change; (3) enterprise analytics.
**Disadvantages:** (2) migration of existing logs; (1) unusable for Lambda (12 §7 documented); (3) infrastructure weight.
**Recommendation:** **Option 2.** *Why:* 12 §7 already specifies it; request-id + latency breakdown is what a two-person team needs to debug remotely; CloudWatch retention is config.
**Risks:** PII slipping into logs — redaction middleware + review of logged fields (12 §10 PII rule).
**Dependencies:** E5-S5, D-47.
**Future impact:** OTel export later reuses the same structured fields.

---

## 13. Cross-cutting

### D-49 — OpenAPI 3.1 & typed client
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** 08 §8#9 and 12 §5 require an OpenAPI 3.1 spec generated from code; E4-S2 wants a typed client to replace raw `fetch`. Hand-maintained markdown (current 08) drifts.
**Available options:**
1. Hand-maintained markdown (status quo).
2. **zod schemas as the single source → generate OpenAPI 3.1 → generate typed client; 08 markdown mirrors the spec.**
3. No spec.
**Advantages:** (2) validation (E1-S9) and docs and types from one definition; (1) zero change; (3) least work.
**Disadvantages:** (2) zod-openapi tooling setup; (1) documented drift risk (08 itself notes it); (3) QA/onboarding suffers and the contract is invisible.
**Recommendation:** **Option 2.** *Why:* the codebase already plans zod validation; deriving OpenAPI + client types from the same schemas removes an entire class of doc-drift and type-mismatch bugs, at tooling-setup cost only.
**Risks:** Tooling churn — pin one generator; keep the generated spec in CI diff checks.
**Dependencies:** E1-S9, E4-S2.
**Future impact:** WhatsApp client (E6) consumes the same spec.

---

### D-50 — Secret management
**Current Status:** `PENDING PRODUCT APPROVAL`
**Why this decision matters:** SEC-07: keys exist in plaintext `.env` on dev machines; they must be rotated and moved to managed storage.
**Available options:**
1. Lambda env vars (still in plaintext config).
2. **AWS SSM Parameter Store (`SecureString`) for Lambda runtime; GitHub Actions secrets for CI; rotate all existing keys; `.env.example` committed.**
3. AWS Secrets Manager (managed rotation).
**Advantages:** (2) ~free, Lambda-native, sufficient with manual rotation; (3) auto-rotation; (1) minimal change.
**Disadvantages:** (2) manual rotation ceremony; (3) ~$0.40/secret/mo; (1) does not fix SEC-07 (plaintext at rest in Lambda config).
**Recommendation:** **Option 2.** *Why:* SSM SecureString is costless and Lambda-native; Secrets Manager's auto-rotation is only worth its price when secrets actually rotate frequently. Rotating *now* treats every existing key as compromised (15 §4).
**Risks:** Rotation gaps — a calendar-check in the runbook; secret scanning in CI (E1-S11).
**Dependencies:** E1-S10, E1-S11.
**Future impact:** Per-provider keys (D-43) all live in the same store, referenced by adapter config.

---

## 14. ARCHITECTURE FREEZE CHECKLIST

**Every decision below is `PENDING PRODUCT APPROVAL`.** The Product Owner must explicitly approve each before the gate it blocks. Approvals are recorded in [18_DECISIONS.md](../decisions/18_DECISIONS.md) as ADRs during Phase 1. **Nothing here is accepted by default.**

Gate legend: **P1-HARD** = blocks Phase 1 start · **P1** = must be approved during Phase 1 (not necessarily day one) · **DESIGN** = decision required now because it shapes the Phase 1 schema/contract, build deferred · **DEFER** = decide now, implement Phase 2+.

| ID | Decision | Recommended | Gate |
|---|---|---|---|
| D-01 | Context Engine Phase 1 domain scope | Profile + Location + Weather + Soil + Season + RAG (GPS optional later) | P1-HARD |
| D-02 | Context snapshot persistence | Store every snapshot, 90d TTL, 12-month sampled | P1 |
| D-03 | Context → prompt rendering | Server-rendered labelled block via versioned template | P1-HARD |
| D-04 | Decision outcome contract | Lightweight classifier + per-task prompt + zod-validated JSON outcomes | P1-HARD |
| D-05 | Model Adapter result contract | Typed envelopes incl. usage + latency; AsyncIterable streaming | P1-HARD |
| D-06 | Model failure semantics | 1 retry + timeouts; degraded mode; failover deferred | P1 |
| D-07 | Prompt registry & versioning | Versioned per-task prompt files, eval-gated | P1 |
| D-08 | Session memory window | Token-budget window (replaces fixed-6) | P1 |
| D-09 | Image path & interaction model | Image-in-chat, synchronous, idempotent pipeline | P1-HARD |
| D-10 | Farm profile model & onboarding | District(auto)+crops+acres; phone/soil deferred | P1-HARD |
| D-11 | Farm Memory write/consent policy | Auto-suggest + farmer confirm/edit/delete (build Phase 2) | DESIGN |
| D-12 | Message normalization (F-28) | Separate `messages` collection, paginated, stable `_id` | P1 |
| D-13 | Anonymous vs authenticated access | Login required for chat; weather/language pre-login | P1-HARD |
| D-14 | Returning-user continuity | Persisted profile auto-loaded; no half-memory | P1 |
| D-15 | Weather provider | Open-Meteo behind weather-service interface | P1-HARD |
| D-16 | Weather cache store | Mongo `weathercache` TTL 30 min | P1 |
| D-17 | Weather refresh | Lazy fill on cache miss | P1 |
| D-18 | Weather failure handling | Serve stale-with-label else `unknown`; never block | P1 |
| D-19 | Soil data source | District-level table (TNAU); SHC = Phase 3 partnership | P1-HARD |
| D-20 | Soil accuracy labeling | Explicit "typical for district" label + eval rubric | P1 |
| D-21 | Soil fallback | `unknown` + optional volunteer override; no guessing | P1 |
| D-22 | Image upload transport | Multipart to backend ≤5MB, EXIF stripped | P1-HARD |
| D-23 | Image storage & retention | S3 private + signed URLs + 90d lifecycle + delete with user | P1 |
| D-24 | Image privacy | Strip EXIF on receipt; explicit consent copy | P1-HARD |
| D-25 | Confidence & escalation | Model confidence + high-stakes category rules → escalate flag | P1 |
| D-26 | Knowledge curation model | Curated sourced content store with provenance + tags | P1-HARD |
| D-27 | Knowledge versioning | Deterministic IDs + idempotent upsert + pack rollback | P1 |
| D-28 | Content validation | CI/ingestion schema + provenance + duplicate checks | P1 |
| D-29 | Retrieval strategy | Metadata-filtered vector (district/crop/season), top-k tuned | P1 |
| D-30 | Eval scoring | LLM-as-judge + human review of failures | P1 |
| D-31 | Golden dataset ownership | Versioned in repo, 50+ cases, grown from missed queries | P1 |
| D-32 | Human feedback | Thumbs up/down + note stored per message; weekly review | P1 |
| D-33 | Continuous improvement | Weekly triage → golden case → knowledge/prompt fix | P1 |
| D-34 | Auth mechanism & token storage | Own JWT; access in memory, refresh in httpOnly cookie | P1-HARD |
| D-35 | Authorization model | requireAuth + ownership scoping + negative tests | P1-HARD |
| D-36 | AI abuse protection | Block separation + schema validation + adversarial eval cases | P1 |
| D-37 | Rate limits & cost quotas | Per-user + per-IP limits + cost quota, Mongo counters | P1-HARD |
| D-38 | Privacy/consent/DPDP framework | Tamil consent + export/delete + TTLs + encryption at rest | P1-HARD |
| D-39 | Scheduled jobs | EventBridge Scheduler → Lambda (nightly ingestion) | P1 |
| D-40 | Queue strategy | No queue in Phase 1; idempotent by design | P1 |
| D-41 | Caching strategy | Mongo TTL caches + TanStack Query + static CDN | P1 |
| D-42 | Storage growth policy | Per-user quotas + retention TTLs + session archiving | P1 |
| D-43 | Multi-LLM readiness | Contract + provider fakes + parity tests; no live 2nd provider | P1 |
| D-44 | Local dev environment | `.env.example` + seed script + quickstart | P1 |
| D-45 | Staging environment | Separate staging Lambda + free-tier DB + Chroma tenant | P1 |
| D-46 | Production deploy & rollback | Tag-gated pipeline + Lambda alias promote/revert | P1 |
| D-47 | Monitoring stack | CloudWatch + Sentry + pino + cost/latency dashboard | P1 |
| D-48 | Logging standard | pino structured JSON, request-id, PII redaction | P1 |
| D-49 | OpenAPI 3.1 & typed client | zod → OpenAPI → typed client; markdown mirrors spec | P1 |
| D-50 | Secret management | SSM SecureString + rotate all keys + secret scanning | P1-HARD |

### Decision block definitions

1. **P1-HARD (13 decisions):** must be approved before Phase 1 implementation begins. They define the security model (D-13/34/35/37/38), the AI contract (D-01/03/04/05/09), and the data contracts (D-10, D-15, D-19, D-22, D-24, D-26). Approving these freezes the shape of everything downstream.
2. **P1 (33 decisions):** approve during Phase 1 as the corresponding epic starts; documented here so their direction is visible in one place.
3. **DESIGN (1 decision):** D-11 — must be decided now because it shapes the consent/feedback schema built in Phase 1, though Farm Memory itself ships in Phase 2.
4. **DEFER:** none in the checklist — all decisions above either gate Phase 1 or must be made during it. (Phase 2+ items like second provider, hybrid retrieval, summarization are captured as forward paths inside D-06/29/08/43, not separate gates.)

### Sign-off

| Decision class | Count | Status |
|---|---|---|
| P1-HARD | 13 | `PENDING PRODUCT APPROVAL` |
| P1 | 33 | `PENDING PRODUCT APPROVAL` |
| DESIGN | 1 | `PENDING PRODUCT APPROVAL` |
| **Total** | **47** | **All `PENDING PRODUCT APPROVAL`** |

> Upon Product Owner approval, each approved decision is recorded as an ADR (or ADR amendment) in [18_DECISIONS.md](../decisions/18_DECISIONS.md) with the rationale and tradeoffs above, then Phase 1 implementation may begin. **No decision in this document is accepted until that sign-off occurs.**
