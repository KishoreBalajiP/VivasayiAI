# Vivasayi AI — Documentation Hub

> **Metadata**
> - **Title:** Documentation Hub — Vivasayi AI
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Docs Maintainer (Founding team)
> - **Last Reviewed:** 2026-10-17
> - **Related Documents:** [product/PRODUCT_PRINCIPLES.md](product/PRODUCT_PRINCIPLES.md) · [product/AI_Product_Principles.md](product/AI_Product_Principles.md) · [decisions/18_DECISIONS.md](decisions/18_DECISIONS.md) · [planning/19_CHANGELOG.md](planning/19_CHANGELOG.md)

> **Single source of truth for the Vivasayi AI product and engineering organization.**
> The backend repository (`VivasayiAI` on GitHub; package name `tn-farming-assistant`) is the **Product Repository**. It owns all
> product, business, AI, architecture, API, database, roadmap, engineering-standards, and planning
> documentation. The frontend repository (`VivasayiAI-Frontend`) contains frontend code, its README and `e2e/README.md`.

> **Status (2026-10-17).** Backend `develop` at `6dbe6b8` (on `origin/develop`, not on `main`, not deployed) plus a large uncommitted working tree with the 2026-10 completion work; frontend `develop` at `56f26eb` plus an uncommitted working tree. Nothing of the October work is deployed. Start with the [acceptance matrix](engineering/ACCEPTANCE_MATRIX_2026-10-17.md) and [known issues](engineering/KNOWN_ISSUES.md). The numbered documents 01-17 were written in August 2026; those touched since carry a dated note.

This documentation set describes **what exists today** (`[EXISTING]`), what is **planned** (`[PLANNED]`),
and what is **future work** (`[FUTURE]`) — grounded entirely in the current codebase.

> **Vision v2 (2026-08-07):** Vivasayi AI is an **AI Agriculture Decision Platform — not an AI chatbot**.
> The roadmap now centers on a **Context Engine** (automatic pre-LLM context assembly), a **Model Adapter**
> (provider-agnostic AI — Gemini is the current provider, replaceable), and **Farm Memory** (long-term farm
> intelligence). The binding principles are defined in
> [AI_Product_Principles.md](product/AI_Product_Principles.md) and are referenced throughout this set.

---

## Repository Layout

```
VivasayiAI/                           ← BACKEND · PRODUCT REPOSITORY (source of truth)
├── docs/                             ← THIS DOCUMENTATION
│   ├── product/                      ← Principles, Vision, Overview, Users, Features, Roadmap, UX
│   ├── architecture/                 ← System, Database, API, AI Architecture, claim flow, progress contract
│   ├── engineering/                  ← Guidelines, Testing, Deployment, Security, runbooks, known issues, acceptance
│   ├── research/                     ← Literature, evaluation results, manuscript
│   ├── business/                     ← Startup Plan
│   ├── planning/                     ← Backlog, CHANGELOG, pending architecture decisions
│   └── decisions/                    ← Architecture Decision Records (ADRs)
├── config/  controllers/  models/  routes/  services/  rag/  utils/  src/ai/   ← Backend source
├── scripts/  tests/  infra/                              ← Worker CLI, migrations, e2e harness, acceptance runner; tests; worker stack
├── .github/workflows/deploy-lambda.yml                    ← CI/CD
├── PHASE_*_REPORT.md, FINAL_RELEASE_VALIDATION_REPORT.md ← HISTORICAL phase reports (state at the time of writing)
├── Dockerfile  index.js  package.json
└── README.md                          ← Canonical project README (see docs/planning entry below)

VivasayiAI-Frontend/                  ← FRONTEND (code, README, e2e/ Playwright suite)
```

---

## Document Index

| # | Document | Folder | Audience | Purpose |
|---|---|---|---|---|
| — | [Product Principles (Constitution)](product/PRODUCT_PRINCIPLES.md) | product | Everyone | **Constitutional principles (PP-01…14): Decision Platform, zero-question, context enrichment, actionable decisions, Farm Memory, context fusion, Model Adapter, product-owned intelligence** |
| — | [AI Product Principles](product/AI_Product_Principles.md) | product | Everyone | **Binding product principles (APP-01…13): decision platform, zero-question context, Context Engine, Farm Memory, Model Adapter** |
| 01 | [Product Vision](product/01_Product_Vision.md) | product | Everyone | Why Vivasayi AI exists and the principles that guide it |
| 02 | [Product Overview](product/02_Product_Overview.md) | product | Everyone, Investors | What the product is today and where it is going |
| 03 | [Target Users](product/03_Target_Users.md) | product | PM, Design, Marketing | Personas, pain points, user journeys |
| 04 | [Feature List](product/04_Feature_List.md) | product | PM, Engineering | Every feature with status, value, and complexity |
| 05 | [Product Roadmap](product/05_Product_Roadmap.md) | product | PM, Leadership | Phased delivery plan with success metrics |
| 06 | [System Architecture](architecture/06_System_Architecture.md) | architecture | Engineering, Solution Architect | Architecture diagrams and components |
| 07 | [Database Design](architecture/07_Database_Design.md) | architecture | Backend, Data | Collections, indexes, ER diagram |
| 08 | [API Documentation](architecture/08_API_Documentation.md) | architecture | Frontend, QA, Integrations | Every endpoint, payload, and error |
| 09 | [AI Architecture](architecture/09_AI_Architecture.md) | architecture | AI Engineers | Prompt flow, RAG, embeddings, memory |
| 10 | [User Flows](product/10_User_Flows.md) | product | PM, Design, QA | Login, chat, diagnosis, voice, weather flows |
| 11 | [UI/UX Guidelines](product/11_UI_UX_Guidelines.md) | product | Design, Frontend | Design system, typography, accessibility |
| 12 | [Technical Guidelines](engineering/12_Technical_Guidelines.md) | engineering | All Engineers | Coding standards, git strategy, structure |
| 13 | [Testing Strategy](engineering/13_Testing_Strategy.md) | engineering | QA, Engineers | Test pyramid, AI eval, manual testing |
| 14 | [Deployment](engineering/14_Deployment.md) | engineering | DevOps, Backend | Environments, CI/CD, env variables |
| 15 | [Security](engineering/15_Security.md) | engineering | Security, Backend | Threats, OWASP checklist, remediation |
| 16 | [Startup Plan](business/16_Startup_Plan.md) | business | Founders, Investors | Business model, GTM, competitors, SWOT |
| 17 | [Backlog](planning/17_Backlog.md) | planning | PM, Engineering | Epics, stories, tasks, estimates |
| 18 | [DECISIONS](decisions/18_DECISIONS.md) | decisions | Engineering | Architecture Decision Records (ADRs) |
| 19 | [CHANGELOG](planning/19_CHANGELOG.md) | planning | Everyone | Release history from git |
| 20 | [README](../README.md) | repo root | Everyone | Professional project README (canonical copy) |
| — | [Chat Context Guide](architecture/CHAT_CONTEXT_GUIDE.md) | architecture | Backend | How chat memory/context works (historical) |
| — | [Pending architecture decisions](planning/ARCHITECTURE_DECISIONS_PENDING.md) | planning | Engineering, PM | Open decisions awaiting the owner |

### Claim verification and operations (October 2026)

Status labels used in these documents: *implemented* (code exists and is wired in), *automated-test verified* (passes with an in-memory database and mocked providers), *live-provider verified* (run against the real provider), *real-world validated* (validated on real claims). Nothing in the claim flow is real-world validated.

| Document | Folder | Audience | Purpose |
|---|---|---|---|
| [Acceptance matrix 2026-10-17](engineering/ACCEPTANCE_MATRIX_2026-10-17.md) | engineering | Everyone | What is implemented, integrated, tested and live-validated, with evidence and release blockers |
| [Known issues](engineering/KNOWN_ISSUES.md) | engineering | Everyone | Open issues with sources and severity |
| [Claim flow](architecture/CLAIM_FLOW.md) | architecture | Engineering | Submit → plan → worker → engine sequence; frozen claim states and the "held" overlay; job state machine |
| [Progress contract v1](architecture/PROGRESS_CONTRACT_v1.md) | architecture | Frontend, Backend | What the farmer tracker is told (`GET /claims/:id/progress`); machine-readable vocabulary in `progress-contract-v1.json` |
| [Frontend contract 2026-10](architecture/FRONTEND_CONTRACT_2026-10.md) | architecture | Frontend | API changes of the October hardening |
| [Job orchestration](engineering/JOB_ORCHESTRATION.md) | engineering | Backend | Steps, dependencies, retries, error taxonomy, dead jobs, sweeps, log events |
| [Worker runbook](engineering/WORKER_RUNBOOK.md) | engineering | DevOps | Deploying and operating the scheduled verification worker (not deployed) |
| [Environment variables](engineering/ENVIRONMENT_VARIABLES.md) | engineering | DevOps, Backend, Frontend | Every variable read by the code: default, scope, secret, when it is read |
| [Live provider requirements](engineering/LIVE_PROVIDER_REQUIREMENTS.md) | engineering | DevOps, Owner | What each external provider needs and what was exercised live |
| [Satellite limitations](engineering/SATELLITE_LIMITATIONS.md) | engineering | Everyone | Why satellite is supporting evidence only |
| [Migration dry run 2026-10-16](engineering/MIGRATION_DRY_RUN_2026-10-16.md) | engineering | DevOps | Read-only dry run of the automation migration against production |
| [Baseline 2026-10](engineering/BASELINE_2026-10.md) | engineering | Engineering | Test baseline and fix log of the October hardening (historical) |
| [Final implementation report 2026-10](engineering/FINAL_IMPLEMENTATION_REPORT_2026-10.md) | engineering | Engineering | 16 October 2026 report (historical; see its status correction) |
| [Research and evaluation](research/evaluation/README.md) | research | Research | Synthetic benchmarks, live results, manuscript |

The `PHASE_*_REPORT.md` and `FINAL_RELEASE_VALIDATION_REPORT.md` files at the repository root are **historical**: their test counts, rate limits and branch or commit statements describe the state when each was written.

---

## How to use this documentation

- **New team member?** Start with PRODUCT_PRINCIPLES → AI_Product_Principles → 01 → 02 → 06 → 09, then your team-specific doc.
- **Investor or partner?** Start with 02 → 03 → 16 → 05.
- **Developer picking up a ticket?** Read 08 (API), 12 (guidelines), and the relevant section of 17 (Backlog).
- **Making an architecture decision?** Record it in 18 (DECISIONS) and cite the principles it serves (AI_Product_Principles).

## Versioning & maintenance

- Update **feature-status docs** (04, 05, 17) every sprint.
- Append to **19 (CHANGELOG)** on every release.
- Every important engineering decision **must** be recorded in **18 (DECISIONS)** with rationale and tradeoffs.
- Status labels: `[EXISTING]` shipped · `[PLANNED]` next milestone · `[FUTURE]` roadmap only.
