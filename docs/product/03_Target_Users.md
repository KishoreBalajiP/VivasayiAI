# 03 — Target Users

> **Metadata**
> - **Title:** 03 — Target Users
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Product / PM
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [02_Product_Overview](02_Product_Overview.md) · [10_User_Flows](10_User_Flows.md) · [11_UI_UX_Guidelines](11_UI_UX_Guidelines.md)

> **Why this document exists:** Product decisions — what to build, in what language, on which channel, at what reading level — are only defensible if they are tied to a named, understood human being. This document defines the personas Vivasayi AI serves, their goals, pains, digital literacy, needs, and journeys. It separates the **end user** (farmer) from the **economic customer** (dealer, industry, government, research) and the **internal user** (admin).

---

## 1. Persona Overview

| Persona | Role | Relationship to product | Primary goal |
|---|---|---|---|
| P1 Tamil Farmer | End user | Uses the assistant | Get fast, local, trustworthy answers |
| P2 Commercial Farmer | End user / premium | Pays for pro features | Optimize yield & margins |
| P3 Agri-Input Dealer | Economic customer | Local partner / advertiser | Reach nearby farmers, sell inputs |
| P4 Agronomist / Extension Officer | Professional user | Expert reviewer / escalator | Serve more farmers accurately |
| P5 Government (TN Agri-Extension) | Economic customer | Institutional partner | Extension reach + program data |
| P6 Research Organization | Data partner | Knowledge/licensing partner | Data + field validation |
| P7 Admin / Platform Team | Internal | Operates the product | Keep system healthy & safe |

---

## 2. P1 — Tamil Farmer (Primary End User)

> **"Ramesh, 42, Thanjavur district"** — the persona every default decision is made for.

### Profile
- Owns ~2.5 acres (paddy + a vegetable plot), sometimes leased additional land.
- Smartphone: ₹7,000–₹15,000 Android; uses WhatsApp daily; rarely installs new apps.
- Reads and writes Tamil fluently; **low English literacy**; may have minimal formal typing skill.
- Prefers voice calls; family group chats are his digital life.
- Mobile data: limited; often 4G but metered; rural connectivity drops.

### Goals
- Protect the crop: know when to spray, irrigate, sow.
- Reduce cost: avoid wrong/over-priced inputs.
- Sell better: know fair market prices before going to the mandi.
- Learn quietly: ask questions he would not ask publicly (status, embarrassment, or fear of showing ignorance).

### Pain Points
- Government/state advice is slow, office-hours only, and often in English or bureaucratic Tamil.
- Local dealer advice is biased toward selling products.
- No one remembers his field from one season to the next.
- A single mistake (wrong pesticide, wrong timing) can cost a season's income.
- Typing a question in Tamil on a phone keyboard is slow and error-prone.

### Digital Literacy
- **Medium-low.** Comfortable with WhatsApp voice notes, photos, videos; uncomfortable with forms, typing, logins, and multi-step flows. Camera is second-nature; keyboard is not.

### Needs
1. Speak or show, not type.
2. Answer in spoken Tamil, simple and direct, no English jargon.
3. Answers grounded in *his* district, crop, and season — **without him having to state them every time** (zero-question principle, APP-02: the platform auto-detects location from GPS and remembers the farm).
4. Fast — he is at the field, not at a desk.
5. Reassurance on safety ("consult your local officer" when uncertain).
6. Zero-cost access (free tier).

### User Journey
1. **Discover:** sees a forwarded message/video in a WhatsApp group ("paddy problem? ask here"), or a district event/demo.
2. **First contact:** opens web app (or later WhatsApp bot), chooses **Tamil** immediately.
3. **Ask:** taps the mic → speaks "என் தக்காளி இலை மஞ்சள்" — the platform auto-detects his location, looks up his farm profile + weather + soil, and prepares the context. *(Today: he still picks a district from chips; the Context Engine removes that step — F-46.)*
4. **Receive:** gets a spoken-Tamil answer with 2-3 actionable steps; asks a follow-up.
5. **Repeat:** returns at the next sign of trouble (pest, weather, price). If alerted by WhatsApp at the right moment, he stays.
6. **Trust milestone:** a decision saves a crop → he tells his farmer group → viral loop.

---

## 3. P2 — Commercial Farmer / Premium User

> **"Meenakshi, 35, Coimbatore"** — manages 15 acres of horticulture (tomatoes, chilies), uses agronomy services and pays for quality.

### Profile
- College-educated; comfortable typing in English and Tamil; uses apps (agri market apps, YouTube agronomy).
- Runs a small agri business with staff; measures inputs and yields.

### Goals
- Maximize yield/acre and reduce input waste.
- Get rapid diagnosis for disease outbreaks.
- Keep records (spend, spray schedule, harvest) for decisions and bank finance.

### Pain Points
- Paid agronomy consultants are expensive and not always right.
- Data scattered across WhatsApp notes, paper, and memory.
- Wants proactive alerts, not just reactive Q&A.

### Digital Literacy
- **High.** App-native; will onboard herself if value is clear.

### Needs
- CropDoctor-style image diagnosis (paid), personal crop plan, reminders, farm records, price alerts.

### User Journey
1. Onboards with farm profile (district, crops, acres).
2. Uses image diagnosis during an outbreak → gets treatment + saves time/money.
3. Pays for the plan (premium) after first saved crop.
4. Becomes the reference user in her farmer network.

---

## 4. P3 — Agri-Input Dealer (Economic Customer)

> **"Suresh, 45, Salem"** — owns a seed/pesticide/fertilizer shop; margin-driven; trusted locally.

### Goals
- Drive qualified walk-ins/buyers to his shop.
- Be seen as the helpful, connected local expert.
- Sell more of the products he carries.

### Pain Points
- Can't afford digital marketing; competition from other dealers.
- No way to turn "farmer asked a question" into "farmer visited my shop."

### Digital Literacy
- **Medium.** Uses WhatsApp Business for order-taking; not a power user.

### Needs (Phase 3 marketplace)
- A verified dealer profile; appear when a farmer's query matches his stock/location.
- Pay-per-lead / display visibility; order/chat hand-off on WhatsApp.

### User Journey
1. Claims & verifies his shop on the platform (FPO/area proof).
2. Farmer asks "tomato fungicide" → Vivasayi recommends treatment + shows nearby verified dealer.
3. Farmer visits/WhatsApps Suresh → transaction → Suresh renews visibility.

---

## 5. P4 — Agronomist / Extension Officer

> **"Dr. Kumar, 39, TNAU/Dept of Agriculture"** — knows agronomy deeply; overwhelmed by demand.

### Goals
- Reach more farmers with accurate advice.
- See the patterns (what pests/diseases are surging where) to guide campaigns.
- Save time on repetitive questions.

### Pain Points
- Ratio of farmers to officers is impossible; most queries are repetitive.
- No data on what farmers actually struggle with.

### Digital Literacy
- **High** (professional).

### Needs
- Review/endorse answers (future expert loop), escalation inbox, district-level analytics (future).

### User Journey
1. Verifies as a professional.
2. Receives escalated/complex cases the AI flags.
3. Answers via app; answer is attributed and reused (curation loop).

---

## 6. P5 — Government (TN Agri-Extension)

### Goals
- Extend extension services at near-zero marginal cost.
- Run schemes more efficiently (reach the right farmers).
- Measure outcomes (adoption, yield) at district scale.

### Needs
- White-label / API access (future), district dashboards, scheme notification integration.

### Constraints
- Procurement, data-privacy, and vendor-approval requirements.

---

## 7. P6 — Research Organization (e.g., TNAU, ICAR)

### Goals
- Validate research in the field; gather real incidence data.
- Distribute crop advisories (e.g., seasonal pest calendars).

### Needs
- Knowledge contribution pipeline (curated content → RAG knowledge base) and field data (opt-in, de-identified).

---

## 8. P7 — Admin / Platform Team (Internal)

### Role
- Operating the product day-to-day: content quality, cost control, user safety, abuse.

### Goals
- Keep the AI grounded and safe; keep unit costs down; respond to escalations.
- Ship reliably (monitoring, error rates, latency).

### Needs
- Admin surfaces (future): dashboard of queries, cost per user, flagged content, content pipeline for the knowledge base, user/session management.

---

## 9. Design Implications Summary

| Persona | Default assumptions the team must honor |
|---|---|
| P1 Farmer | Tamil-first, voice-first, 2-tap onboarding, simple words, zero typing expected, **zero re-asking (auto context from GPS + Farm Memory)**, offline tolerance, free tier |
| P2 Commercial | Depth, records, alerts, willingness to pay, desktop parity |
| P3 Dealer | Simple partner tools, WhatsApp-based workflow |
| P4 Agronomist | Professional UI, curation tools, escalation queue |
| P5 Government | Security/compliance, dashboards, API |
| P6 Research | Content pipeline, data consent |
| P7 Admin | Monitoring, cost controls, moderation |

> **Cross-cutting (APP-02/03/04):** every screen is reviewed against the zero-question principle — the platform must auto-obtain location, weather, soil, season, and farm history from the Context Engine + Farm Memory, and must **never** ask a persona to repeat what it can already know. Any question that survives must be justified in the design review (see 11_UI_UX_Guidelines).
