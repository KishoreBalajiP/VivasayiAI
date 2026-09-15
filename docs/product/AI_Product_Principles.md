# AI Product Principles

> **Metadata**
> - **Title:** AI Product Principles
> - **Version:** 2.0
> - **Status:** `[ACCEPTED]`
> - **Owner:** Founding team / AI
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [PRODUCT_PRINCIPLES](PRODUCT_PRINCIPLES.md) · [01_Product_Vision](01_Product_Vision.md) · [04_Feature_List](04_Feature_List.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** Vivasayi AI is an **AI Agriculture Decision Platform** — not an AI chatbot. These are the binding product principles that every feature, every architecture decision, and every user-visible interaction **must** follow. Any proposal that conflicts with a principle below must be rejected, or the principle explicitly revised through a decision record.
>
> **Constitution:** the permanent, higher-level product principles (PP-01…PP-14) are defined in [PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md). This document is the operational binding layer that implements that constitution (see the principle index in PRODUCT_PRINCIPLES.md §5).
>
> **How to use:** reference a principle ID (`APP-01`…) in feature specs (04), backlog stories (17), and ADRs (18). The review checklists in 12 (engineering) and 11 (design) cite these IDs.

**Status:** `[ACCEPTED]` · **Version:** 2.0 · **Date:** 2026-08-07 · **Deciders:** Founding team

---

## APP-01 — We are a Decision Platform, not a chatbot

The product does not chat for chatting's sake. Every interaction ends in a **decision-support outcome**: a recommendation, a diagnosis, a plan, an alert, or a source-backed answer the farmer can act on. Chat is the front door; the platform — context, memory, diagnosis, alerts, records — is the product.

- **In practice:** every message is resolved against context before generation; every answer is actionable; passive chit-chat is explicitly out of scope.
- **Verify:** each feature spec states the decision outcome it serves; generic "assistant" framing is rejected in reviews.

## APP-02 — Zero-question context (never ask what we can already know)

The AI must **never ask the farmer for information that can be automatically obtained, inferred, remembered, or fetched**. The platform collects context proactively — from GPS, from the farm profile, from history, from government data, from the knowledge base — and only asks when the information cannot be derived by any automatic means.

- **In practice:** no "which district are you in?" if GPS can resolve it; no "which crop?" if the farm profile knows; no re-asking across sessions (Farm Memory). Every onboarding question must justify itself against this principle.
- **Verify:** a design pass asking "could the system know this already?" must return "no" for every question the UI shows. Documented in the Context Engine domain map (09_AI_Architecture §4).

## APP-03 — Context before generation (Context Engine)

Before the LLM is invoked, a **Context Engine** assembles the situation automatically from nine domains:

1. **Farm Profile** — farmer, plots, area, primary crops, resources.
2. **Farm Location** — village/block/district resolution.
3. **GPS** — precise coordinates (privacy-controlled) for weather/soil matching.
4. **Weather** — current + forecast for the farm's location.
5. **Soil Type** — district/village soil data.
6. **Season** — kharif/rabi/summer + current growth stage.
7. **Crop History** — what was grown, what happened, outcomes.
8. **Government Advisories** — official seasonal advisories, pest alerts, schemes (sourced only).
9. **Agricultural Knowledge** — RAG retrieval over the curated TN knowledge base.

The LLM **never runs without an assembled context block**; missing domains degrade gracefully (explicit "unknown" flags) rather than silently.

- **In practice:** one orchestration step gathers domains (each is optional-and-fetchable), assembles a structured context snapshot, and passes it to the model.
- **Verify:** traceability — every response can be attributed to the context snapshot it used (see 09_AI_Architecture §4, §10).

## APP-04 — Farm Memory is a core capability

The platform **remembers the farm**: profile, plots, crop history, past questions, decisions, and outcomes — across sessions, seasons, and channels. Memory is what turns one-off answers into compounding value and the data moat.

- **In practice:** a follow-up after two months is answered in the context of the last season's decisions; the farmer never restates their situation.
- **Verify:** memory surfaced in every conversation; retention of "as we discussed" without the farmer repeating themselves; outcome capture feeds better future advice.

## APP-05 — Model-agnostic AI (Model Adapter)

No business logic depends on a specific model vendor. All model access — chat, streaming, vision, embeddings — goes through a **Model Adapter** layer. **Gemini is the current provider, not the only provider.** Llama, Qwen, Mistral, or our own fine-tuned model can replace it by configuration, with zero change to business logic.

- **In practice:** a uniform interface (`ask`, `stream`, `vision`, `embed`); provider selected by `MODEL_PROVIDER`; adapters are thin, isolated, and tested against a contract.
- **Verify:** swapping `MODEL_PROVIDER=gemini` → `MODEL_PROVIDER=llama` in config changes no service-layer code (ADR-015).

## APP-06 — Evidence over opinion

Answers are grounded in the knowledge base or explicitly flagged as general guidance. The platform **never fabricates** data, prices, schemes, or numbers; when uncertain, it says so and defers to a human expert.

- **In practice:** RAG-sourced claims, uncertainty signaling, and "consult your local agricultural officer" guardrails; sources surfaced when available.
- **Verify:** AI eval rubric (groundedness, actionability, safety) in 13_Testing_Strategy §4.

## APP-07 — Images are diagnoses, not photos

An uploaded image is not displayed-and-discarded: it enters an **AI diagnosis pipeline** that fuses vision analysis with the assembled context (weather, soil, crop, location) before producing a recommendation. The output is a structured diagnosis (cause → treatment → safety → escalation), not a description.

- **In practice:** image + Context Engine snapshot → unified diagnosis; never image alone, never text alone.
- **Verify:** the diagnosis card always shows the context that informed it (ADR-017).

## APP-08 — Tamil-first; voice and image are accessibility, not features

The farmer's language is the product's language. Typing is the edge case: voice and images are the primary input modes for the primary persona.

## APP-09 — Trust and safety before scale

A single wrong answer can cost a harvest. No real users are onboarded before verified authentication, grounded answers, and evaluation gates are in place (Phase 1).

## APP-10 — Privacy by design

Context Engine and Farm Memory mean the platform holds more data — that is precisely why privacy is non-negotiable: consent, minimization, encryption at rest, no PII in logs/URLs, and export/delete rights. Precise GPS is collected only with explicit consent and used for matching, not stored by default.

## APP-11 — Depth over breadth

Win Tamil Nadu district by district, crop by crop, language by language before expanding. A perfect answer for Thanjavur paddy beats a mediocre answer for everything.

## APP-12 — Measurable AI

Every model/provider decision is governed by measured quality (golden-set eval), cost per conversation, and latency — not by vendor preference. Model Adapter makes switching to a cheaper/better provider a config change *that must pass the same eval gates*.

## APP-13 — Human-in-the-loop for high-stakes

Where a wrong answer is expensive or irreversible (pesticide rates, disease emergencies, legal/financial), the platform either escalates to a verified human expert or clearly defers. Full automation of high-stakes advice is only allowed after eval evidence shows it is safe.

---

## How these principles govern work

| Artifact | Gate |
|---|---|
| **New feature (04, 17)** | Spec states the decision outcome (APP-01), the questions it eliminates (APP-02), the context domains it uses (APP-03), the memory it reads/writes (APP-04), and the adapters it touches (APP-05). |
| **New/updated ADR (18)** | Records which principles it serves or conflicts with. |
| **Code review (12 §11)** | Model calls only via adapter; context only via Context Engine; no vendor SDK in business logic; no new farmer-facing question without APP-02 justification. |
| **Design review (11)** | Every visible question traced to APP-02; trust cues (APP-06); diagnosis cards (APP-07). |
| **AI eval (13 §4)** | Context-aware rubric dimension; provider-parity tests (APP-05, APP-12). |

Status labels: `[ACCEPTED]` in this document means the principle is binding now; individual implementation is tracked in 04 (features), 05 (roadmap), and 17 (backlog).
