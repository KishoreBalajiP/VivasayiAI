# PRODUCT_PRINCIPLES — The Vivasayi AI Constitution

> **Metadata**
> - **Title:** PRODUCT_PRINCIPLES — The Vivasayi AI Constitution
> - **Version:** 1.0
> - **Status:** `[ACCEPTED]`
> - **Owner:** Founding team
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [AI_Product_Principles](AI_Product_Principles.md) · [01_Product_Vision](01_Product_Vision.md) · [04_Feature_List](04_Feature_List.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** This is the **constitutional document** for Vivasayi AI. It states the permanent, non-negotiable principles that every feature, every architecture decision, and every user-visible interaction must satisfy — now and as the product evolves. Where a proposal conflicts with a principle below, the proposal is rejected unless the principle itself is explicitly amended through the process in §4.
>
> **Relationship to AI_Product_Principles.md:** [AI_Product_Principles.md](AI_Product_Principles.md) is the **operational binding rules** (APP-01…APP-13) that implement this constitution in day-to-day engineering and design work. This document is the higher-level, permanent frame; the APP rules are the enforceable checklist. Every APP rule traces to a principle here.

---

## 1. Preamble

Vivasayi AI exists for one reason: to give every Tamil farmer an agronomy **decision system** in their pocket — one that speaks their language, listens to their voice, sees their crops, automatically knows their village's weather, soil, season, and history, and turns that into grounded, local, actionable decisions in seconds.

The product will grow — new channels, new languages, new knowledge packs, new business models. The principles below are the permanent constraints that keep that growth true to the mission. They are deliberately few, deliberately stable, and deliberately binding.

---

## 2. The Principles

### PP-01 — Vivasayi AI is an AI Agriculture Decision Platform, not a chatbot

Every interaction ends in a **decision-support outcome**: a recommendation, a diagnosis, a plan, an alert, or a source-backed answer the farmer can act on. Chat is the front door; the platform — context, memory, diagnosis, alerts, records — is the product. Passive conversation with no actionable outcome is out of scope.

> **Enforced by:** APP-01 (operational definition) in AI_Product_Principles.md.

### PP-02 — Never ask the farmer for information the system can automatically obtain

The platform must never re-ask for anything it can obtain (GPS, weather, soil), infer (district from location, season from date), remember (farm profile, crop history), or fetch (advisories, knowledge) by automatic means. Every question the product asks must be justified: "could the system know this already?" If yes, the question is a defect.

> **Enforced by:** APP-02 (zero-question context).

### PP-03 — Always enrich AI responses using available context

The AI must never run against an empty situation. Before generating, the platform assembles the farm's context — profile, location, GPS, weather, soil, season, history, advisories, and knowledge — and uses it to answer. Missing context degrades to an explicit "unknown," never to silent guesswork.

> **Enforced by:** APP-03 (context before generation, Context Engine).

### PP-04 — AI should provide actionable decisions rather than generic answers

An answer that cannot be acted on is not a deliverable. Advice must be concrete — specific treatment, timing, quantity, or next step — or must honestly say what the farmer should do next (including "consult your local agricultural officer" when uncertain). Generic, hedging prose without an action is a failure mode.

> **Enforced by:** APP-01 (decision outcomes) and APP-06 (evidence over opinion).

### PP-05 — Farm Memory is a core capability, not a feature

The platform remembers the farm — profile, plots, crop history, past questions, decisions, and outcomes — across sessions, seasons, and channels. Memory is what compounds one-off answers into better advice and into the data moat. It is central to the product's identity and must never be treated as an optional add-on.

> **Enforced by:** APP-04 (Farm Memory).

### PP-06 — Image, weather, soil, location, and knowledge must be fused before AI reasoning

No single input is interpreted in isolation. An uploaded image is a diagnosis input, not a photo: vision analysis must be fused with the assembled context (weather, soil, crop, location, season) and the knowledge base before any recommendation is produced.

> **Enforced by:** APP-07 (images are diagnoses, not photos).

### PP-07 — LLM providers are replaceable through a Model Adapter

No business logic depends on a specific model vendor. All model access — chat, streaming, vision, embeddings — goes through a Model Adapter layer. Providers are selected by configuration, and swapping a provider must be a config change that passes the same quality gates. **Gemini is the current provider, not the only provider.**

> **Enforced by:** APP-05 (model-agnostic AI) and APP-12 (measurable AI).

### PP-08 — Product intelligence belongs to Vivasayi AI, not to any single LLM provider

The knowledge base, the prompts, the context engine, the evaluation set, and the farm data are Vivasayi-owned assets. The LLM is a commodity reasoning layer, chosen and replaced on measured quality and cost per rupee. Vendor lock-in — in prompts, in SDKs, or in data — is a strategic risk and is treated as one.

> **Enforced by:** APP-05, APP-06, APP-12. Implemented via ADR-015 (Model Adapter) and the AI eval harness (13_Testing_Strategy §4).

---

## 3. Supporting principles

The following are permanent constraints that support the core principles above:

- **PP-09 — Trust before scale (APP-09):** a single wrong answer can cost a harvest. No real users are onboarded before verified authentication, grounded answers, and evaluation gates are in place.
- **PP-10 — Tamil-first; voice and image are accessibility, not features (APP-08):** the farmer's language is the product's language; typing is the edge case.
- **PP-11 — Privacy by design (APP-10):** context and memory mean the platform holds more data — consent, minimization, encryption, and export/delete rights are non-negotiable.
- **PP-12 — Depth over breadth (APP-11):** win Tamil Nadu district by district, crop by crop, language by language before expanding.
- **PP-13 — Human-in-the-loop for high-stakes (APP-13):** where a wrong answer is expensive or irreversible, escalate to a verified human expert or clearly defer.
- **PP-14 — Measurable over aspirational (APP-12):** retention, answer quality, cost per conversation, and time-to-answer beat vanity metrics.

---

## 4. How these principles govern work

| Artifact | Gate |
|---|---|
| **New feature (04, 17)** | Spec states the decision outcome it serves (PP-01/PP-04), the questions it eliminates (PP-02), the context domains it uses (PP-03), the memory it reads/writes (PP-05), the fusions it performs (PP-06), and the adapters it touches (PP-07). |
| **New/updated ADR (18)** | Records which principles it serves or conflicts with. |
| **Code review (12 §11)** | Model calls only via the Model Adapter (PP-07/PP-08); context only via the Context Engine (PP-03); no vendor SDK in business logic (PP-08); no new farmer-facing question without PP-02 justification. |
| **Design review (11)** | Every visible question traced to PP-02; trust cues and context chips (PP-03); diagnosis cards (PP-06). |
| **AI eval (13 §4)** | Context-aware rubric dimension; provider-parity tests (PP-07/PP-08/PP-14). |

---

## 5. Amendment process

Principles are meant to be stable, not sacred. To amend:

1. A proposal must name the principle(s) affected, the conflict it creates, and the reason the principle no longer serves the mission.
2. The proposal is recorded as a decision record in [18_DECISIONS.md](../decisions/18_DECISIONS.md), which must explicitly mark the affected principle as amended/superseded.
3. This document is versioned (see metadata) — amendment bumps the version and the changelog entry.
4. No principle may be amended silently inside a feature spec or PR; only through the decision-record process.

---

## Appendix — Principle index

| ID | Principle | Core / Supporting | Primary enforcement |
|---|---|---|---|
| PP-01 | Decision Platform, not chatbot | Core | APP-01 |
| PP-02 | Never ask what can be auto-obtained | Core | APP-02 |
| PP-03 | Always enrich responses with context | Core | APP-03 |
| PP-04 | Actionable decisions, not generic answers | Core | APP-01, APP-06 |
| PP-05 | Farm Memory is core | Core | APP-04 |
| PP-06 | Fuse image, weather, soil, location, knowledge | Core | APP-07 |
| PP-07 | Providers replaceable via Model Adapter | Core | APP-05 |
| PP-08 | Intelligence belongs to Vivasayi AI | Core | APP-05, APP-06, APP-12 |
| PP-09 | Trust before scale | Supporting | APP-09 |
| PP-10 | Tamil-first; voice/image are accessibility | Supporting | APP-08 |
| PP-11 | Privacy by design | Supporting | APP-10 |
| PP-12 | Depth over breadth | Supporting | APP-11 |
| PP-13 | Human-in-the-loop for high-stakes | Supporting | APP-13 |
| PP-14 | Measurable over aspirational | Supporting | APP-12 |
