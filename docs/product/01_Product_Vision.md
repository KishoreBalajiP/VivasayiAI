# 01 — Product Vision

> **Metadata**
> - **Title:** 01 — Product Vision
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Founding team
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [PRODUCT_PRINCIPLES](PRODUCT_PRINCIPLES.md) · [AI_Product_Principles](AI_Product_Principles.md) · [02_Product_Overview](02_Product_Overview.md) · [05_Product_Roadmap](05_Product_Roadmap.md)

> **Why this document exists:** A startup cannot be steered without a written north star. This document defines what Vivasayi AI is trying to become, what it will never be, and the principles that every decision — product, technical, or commercial — must respect. It is the reference point for saying "yes" or "no" to any feature.
>
> **Vision v2 (2026-08-07):** the permanent constitutional principles are codified in [PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md) (`PP-01`…`PP-14`); the binding operational principles are codified in [AI_Product_Principles.md](AI_Product_Principles.md) (`APP-01`…`APP-13`). This document sets the vision; the principles enforce it.

---

## 1. Vision

> **To become the operating system for Tamil Nadu's agriculture — the default trusted decision platform for every farming family in the state, and eventually for every Indian language.**

Vivasayi AI is an **AI Agriculture Decision Platform**, not a chatbot (APP-01). Every interaction ends in a decision-support outcome: a recommendation, a diagnosis, a plan, an alert, or a source-backed answer the farmer can act on. It grows from a conversational front door into a farm records system, a market intelligence source, and a marketplace connecting farmers to the inputs, information, and markets they deserve. The conversation is the front door; context, memory, diagnosis, alerts, and records are the platform.

## 2. Mission

> **Give every Tamil farmer a personal agronomy decision system in their pocket — one that speaks their language, listens to their voice, sees their crops with their camera, automatically knows their village's weather, soil, season, and history, and turns that into grounded, local, actionable decisions in seconds.**

We deliver on this mission through:

1. **A Tamil-first experience** — voice, text, and images, not just English text.
2. **Grounded decisions** — retrieval-augmented generation over a Tamil Nadu agricultural knowledge base, so advice is specific and sourced, not hallucinated.
3. **Automatic context** — a Context Engine that gathers farm profile, location, GPS, weather, soil, season, crop history, government advisories, and knowledge *before* the AI answers, so the farmer is never re-asked for what the platform can already know (APP-02, APP-03).
4. **Farm Memory** — the platform remembers the farm across sessions, seasons, and channels (APP-04).
5. **Provider-agnostic AI** — a Model Adapter keeps Gemini as the current provider but makes Llama, Qwen, Mistral, or our own model drop-in replaceable (APP-05).
6. **Trust as the product** — when a wrong answer can cost a harvest, accuracy and honesty are non-negotiable.

## 3. Problem Statement

Tamil Nadu has roughly **60 lakh (6 million) farming families**, and agriculture accounts for a meaningful share of the state's GDP. Yet farmers face a severe information gap:

- **State helplines and extension officers are scarce, slow, and office-hours-only.** A question asked at 8 PM goes unanswered until the next day — or never.
- **Existing digital resources are English-first and generic.** The farmer of a two-acre plot in Thanjavur and a technician in Delhi get the same one-size-fits-all content.
- **Illiteracy and digital literacy barriers** make text-based, English-first tools useless to the very people who need help most.
- **Crop failure from preventable causes is common** — wrong pesticide, wrong fertilizer timing, missed weather signals — because expert guidance does not reach the field in time.
- **There is no persistent memory.** A farmer tells one advisor about their plot, then starts over with the next. No system remembers the farm.

**Vivasayi AI exists to close that gap:** instant, personalized, bilingual, voice-first agricultural **decisions** grounded in Tamil Nadu-specific knowledge.

## 4. Goals

### 4.1 Product Goals
- **G1 — Accessible AI for every farmer:** usable by a Tamil-speaking farmer with minimal literacy, via voice and images, in under three taps from first open to first answer.
- **G2 — Trustworthy decisions:** every recommendation grounded in the knowledge base or clearly flagged as general guidance; never present fabricated data, prices, or schemes.
- **G3 — Zero-question personalization:** a Context Engine (farm profile, GPS, weather, soil, season, crop history, advisories, knowledge) auto-populates every answer; the platform never asks for what it can obtain, infer, remember, or fetch (APP-02).
- **G4 — Farm Memory:** the platform remembers the farm across sessions and seasons and compounds that knowledge into better advice (APP-04).
- **G5 — Retention through value:** a weekly active user is one who acted on a real farming decision — not one who installed an app.

### 4.2 Business Goals
- **G6 — Distribution at the farmer's home:** meet farmers on WhatsApp (their primary channel) in addition to the web app.
- **G7 — A data moat:** structured, consented farm data (crops, land, issues, outcomes) that compounds and becomes defensible.
- **G8 — Path to revenue:** a clear journey from free decisions → premium intelligence → marketplace and B2B data.

### 4.3 Technical Goals
- **G9 — Production-grade security:** verified authentication, authorization on every endpoint, secrets managed properly.
- **G10 — Measurable and affordable AI:** unit economics tracked per conversation; cost per active user is a first-class metric.
- **G11 — Testable AI:** an evaluation harness for Tamil/English answer quality so the model and prompts improve without regression.
- **G12 — Model-agnostic AI:** all model access behind a Model Adapter so providers are replaceable by configuration without touching business logic (APP-05).

## 5. Non-Goals (what Vivasayi AI will NOT do)

These are intentional boundaries. Anything not on this list is subject to the same scrutiny as new features.

| # | Non-Goal | Rationale |
|---|---|---|
| N1 | **General-purpose chatbot** ("ask me anything about the world") | We serve agriculture in Tamil Nadu; breadth dilutes trust and grounding |
| N2 | **Veterinary or human medical diagnosis** | Out of scope, high liability; we refer to professionals |
| N3 | **Legal/regulatory advice** (e.g., land disputes) | Out of scope |
| N4 | **Inventing market prices or government schemes** | We will only surface *sourced, verifiable* data when available (future), never fabricated numbers |
| N5 | **Replacing government extension officers** | We complement the ecosystem; we connect farmers to experts |
| N6 | **Multi-state expansion before Tamil Nadu is proven** | Depth first (TN district × crop × season knowledge), then breadth |
| N7 | **A social media platform** (farmer-to-farmer feeds) in the first year | Community features are future; the assistant is the focus |
| N8 | **Farming the data without consent** | Farmer data is never sold or used without explicit, transparent consent |

## 6. Core Principles

The **binding** principles are defined in [AI_Product_Principles.md](AI_Product_Principles.md) (`APP-01`–`APP-13`). The short form:

1. **We are a Decision Platform, not a chatbot** (APP-01). Every interaction ends in an actionable decision.
2. **Zero-question context** (APP-02). Never ask the farmer for anything the platform can automatically obtain, infer, remember, or fetch.
3. **Context before generation** (APP-03). A Context Engine assembles profile, location, GPS, weather, soil, season, crop history, advisories, and knowledge before the LLM runs.
4. **Farm Memory is core** (APP-04). The platform remembers the farm across sessions, seasons, and channels.
5. **Model-agnostic AI** (APP-05). Gemini is the current provider, not the only provider — all model access is behind a Model Adapter.
6. **Trust before scale** (APP-09). A single wrong answer costs a harvest. We optimize for grounded, honest responses and clearly state uncertainty rather than guess.
7. **Tamil first, always** (APP-08). The language of the farmer is the language of the product. English is a secondary mode, never the default for Tamil-speaking users.
8. **Voice and images are not features — they are accessibility** (APP-08). For our user, typing is the edge case; images enter an AI diagnosis pipeline, not a photo viewer (APP-07).
9. **Privacy by design** (APP-10). Context and memory mean we hold more data; consent, minimization, and encryption are non-negotiable.
10. **Simple beats clever.** If a feature cannot be explained in one sentence to a farmer, it is not ready.
11. **Measure what matters** (APP-12). Retention, answer quality, cost per conversation, and time-to-answer beat vanity metrics like downloads.
12. **Ship on the platforms farmers already use.** WhatsApp-first mindset; the web app is a complement.
13. **Security is a feature** (APP-09). A product that holds farmer data must be safe to use before it is good to use.

## 7. Product Philosophy

- **We are a farmer's decision system, not a search engine.** Search returns options and leaves the user to decide; Vivasayi AI advises, remembers, and follows up.
- **Grounding over generation** (APP-06). The AI is a reasoning layer on top of curated Tamil Nadu knowledge — not an oracle improvising from memory.
- **Context is collected, never extracted from the farmer** (APP-02/03). The platform assembles the situation automatically; the farmer only supplies what the platform cannot know.
- **Memory compounds value** (APP-04). Every decision recorded, every outcome remembered, makes the next answer better.
- **The conversation is the interface.** The chat is the product's primary surface today and the gateway to profiles, alerts, marketplaces, and records tomorrow.
- **Everything is a loop.** Every question improves our knowledge of the farmer and the gaps in our knowledge base. Feedback closes the loop: answer quality, user corrections, and missed-query detection drive the roadmap.
- **Build depth, not breadth** (APP-11). Win district by district, crop by crop, language by language. A perfect decision for Thanjavur paddy is worth more than a mediocre one for everything.
