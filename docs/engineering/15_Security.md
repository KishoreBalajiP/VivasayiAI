# 15 — Security

> **Metadata**
> - **Title:** 15 — Security
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Security / Backend
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [12_Technical_Guidelines](12_Technical_Guidelines.md) · [13_Testing_Strategy](13_Testing_Strategy.md) · [14_Deployment](14_Deployment.md) · [18_DECISIONS](../decisions/18_DECISIONS.md) · [AI_Product_Principles](../product/AI_Product_Principles.md)

> **Why this document exists:** Security is the difference between "a demo" and "a product we can put real farmers on." This document catalogues the current security posture honestly, ranks the risks, and defines the remediation plan. **Several findings are critical and must be fixed before any real users are onboarded (Phase 1).**

---

## 1. Risk summary (current state)

| ID | Finding | Severity | Status |
|---|---|---|---|
| SEC-01 | Backend decodes Cognito ID token **without verifying signature/issuer/audience/expiry** (`jwt.decode`) — a forged JWT can impersonate any user | **Critical** | `[RESOLVED]` E1-S2/E1-S3 — server-side JWKS verification (RS256, issuer-family constrained, audience, expiry, fail-closed); backend-issued session JWT; t206/t212 prove forged/invalid tokens rejected |
| SEC-02 | **No authentication on any API.** Chat/session identity is a `userEmail` the client sends in body/query — spoofable (IDOR: read/delete/clear others' chats) | **Critical** | `[RESOLVED]` E1-S4/E1-S5 — all app routes behind `requireAuth`; ownership is derived from the verified token's `cognitoSub` and client identity fields are ignored; unowned resources → 404; t207/t208/t212 prove IDOR negatives |
| SEC-03 | `/test/*` endpoints publicly expose **all users (PII) and all queries** | **Critical** | `[RESOLVED]` E1-S1 — `/test/*` routes + controller removed from the codebase |
| SEC-04 | CORS `origin: "*"` on the API | High | `[RESOLVED]` E1-S7 — strict allow-list from `CORS_ORIGINS` (`credentials:true`), disallowed origins rejected; t210 proves allow/deny/preflight/no-bypass |
| SEC-05 | Error responses leak internal stack traces to clients (`asyncHandler`) | High | `[RESOLVED]` E1-S6 — `errorHandler` returns generic messages (`ApiResponse` only); no stack/cause/message reaches clients; t209 proves it |
| SEC-06 | `id_token` + user stored in `localStorage` (XSS → token theft; no refresh/expiry handling) | High | `[EXISTING]` — rework |
| SEC-07 | Live secrets in plaintext `.env` on dev machines (Mongo, AWS, Gemini, Cohere, Chroma). `.env` is git-ignored (verified), but keys must be rotated & moved to a secret manager | High | `[EXISTING]` — rotate + migrate |
| SEC-08 | No rate limiting on auth/chat → brute force + cost abuse of paid AI APIs | Med | `[RESOLVED]` E1-S8 — auth (per IP, 10/60s), chat (per user, 30/60s + 300/24h), session mutations (per user, 30/60s: POST /new, POST /:id/message, DELETE /:id, DELETE /clear/all); reads unthrottled; 429 + `Retry-After`; t211 |
| SEC-09 | No input size caps on `message` (token/cost abuse) | Med | `[RESOLVED]` E1-S9 — zod length caps at the route boundary: `MESSAGE_MAX_LENGTH` (2000) on `POST /chat` `message` and `POST /chatsessions/:id/message` `text`; `title` ≤ 200; `crops` ≤ 20; `district` ≤ 80; t212 asserts over-limit → 400 |
| SEC-10 | Emails in URL paths (`/chatsessions/list/:email`) leak into logs | Med | `[RESOLVED]` E1-S5 — list is now `GET /chatsessions/list` scoped by the token; no email in any URL; request logging keyed by `requestId` |
| SEC-11 | Prompt injection: user input + retrieved content share the prompt; no sanitization of RAG content | Med | `[EXISTING]` — harden |
| SEC-12 | Auto-deploy to production on `push to main` with no tests/checks | Med | `[EXISTING]` — change pipeline |
| SEC-13 | No data-retention or consent framework for farmer PII (planned profile/phone data) | Med | `[PLANNED]` — design now |

---

## 2. Authentication (today → target)

**Today:** OAuth2 authorization-code flow. Frontend exchanges code for tokens; stores `id_token` in localStorage; backend `jwt.decode` (unverified); sessions keyed by email string.

**Target (Phase 1):**
```mermaid
flowchart LR
    FE[SPA] -->|authorize| COG[AWS Cognito]
    COG -->|code| FE
    FE -->|POST /auth/google {code}| API
    API -->|server-side token exchange + verify signature/issuer/aud/exp| COG
    API -->|issue signed session JWT (short-lived + refresh)| FE
    FE -->|Bearer JWT| API
    API -->|requireAuth: verify + derive userId| DB[(MongoDB)]
```
- Backend issues its own session JWT (or verifies Cognito tokens fully) with `cognitoSub` as the stable identity.
- All routes except `auth`/`health` behind `requireAuth`.
- Access token in memory or `httpOnly` cookie; refresh token flow; logout revokes server-side session.

## 3. Authorization (every request)

| Rule | Implementation |
|---|---|
| Identity is server-derived | `req.user` from verified token; never trust body/query identity fields |
| Resource ownership | Every session/profile query scoped by the authenticated `cognitoSub` (`req.user.id`) — returns 404 for others' resources (**implemented E1-S5, ADR-018**) |
| No admin surface without roles | `/test/*` removed; admin roles (future) gated by role claim |
| Negative test requirement | Cross-user read/delete/clear must be tested (13_Testing_Strategy §3) |

## 4. Secrets management

1. **Rotate now:** all keys in `.env` files (Mongo URI, AWS access keys, Gemini, Cohere, Chroma, Cognito) — treat as compromised since they exist in plaintext on developer machines.
2. **Move to managed storage:** AWS Secrets Manager/SSM for Lambda; GitHub Actions secrets for CI (already used for AWS creds).
3. **Commit `.env.example`** with placeholder values for both repos.
4. Add **secret scanning** (e.g., gitleaks) to CI so credentials can never re-enter history.
5. Never log secrets; never echo env in error responses.

## 5. Input validation & rate limiting

- **Validation:** express-validator/zod at route boundary — types, lengths, enums (`sender`, `language`), required fields. Current validation is manual and partial.
- **Input caps:** `message` length (e.g., 2000 chars); image size/type; list page sizes.
- **Rate limits:** auth attempts (per IP), chat (per user per minute/day), session mutations. Return `429` with `Retry-After`.
- **Body size limit:** `express.json({ limit: '1mb' })` (currently default).
- **Image upload (`POST /upload`):** approved MIME types (JPEG/PNG/WEBP only, magic-byte sniffed, declared Content-Type must match bytes); max size `IMAGE_UPLOAD_MAX_BYTES` (default 5 MB); per-user rate limit `UPLOAD_RATE_LIMIT_MAX` requests per `UPLOAD_RATE_LIMIT_WINDOW_MS` (default 10/60 s); original filename never trusted. E3 (D-22 Option 1) storage layer adds: **decode-based safety** — the payload must fully decode under sharp's strict decode + 20 MP pixel guard (magic bytes alone are never enough; corruption is a clean 400, never 500); **normalization** — re-encode with EXIF stripped (privacy, APP-10) and longest edge capped at `IMAGE_MAX_DIMENSION` (default 2048). **Binary is never persisted to MongoDB** — the normalized image goes to a **private S3 bucket** (owner-scoped, server-generated keys under an `uploads/` prefix; `s3Key`/bucket names are never exposed to clients in any response — errors surface only as generic `Image storage unavailable`). S3 credentials are validated lazily so unprovisioned environments still boot; `IMAGE_STORAGE_MODE=mock` (dev/test-only seam, `.env.example`) swaps in an in-memory stub — never client-controlled. Diagnosis (`POST /chat` with `uploadId`) only ever reads images **owned by the caller**; foreign/unknown ids → 404.
- **Image data flow (E3):** the only copy stored is the normalized re-encode (the original upload bytes are released after processing), so raw EXIF/GPS never persists. Retention/lifecycle and signed-URL retrieval remain pending product decision **D-23** (remove-with-user is a stated intent to implement), EXIF/consent per **D-24**, and the consent framework per **D-38**.

## 6. Data privacy

- **Minimization:** collect only what the product needs (district, crops — not precise GPS by default).
- **Consent:** explicit, plain-language (Tamil) consent for any data used beyond providing the answer; opt-in for analytics/alerts.
- **Retention:** define TTLs for logs, analytics, and inactive sessions.
- **De-identification:** B2B analytics (future) uses aggregate/de-identified data only.
- **PII handling:** phone numbers and precise locations encrypted at rest; never in logs/URLs.
- **Rights:** support export/delete of user data (regulatory readiness: DPDP Act India).

## 7. Transport & headers

- HTTPS everywhere (Lambda URL + API Gateway with TLS; frontend on HTTPS).
- HSTS, `X-Content-Type-Options`, CSP headers on the frontend.
- `Referrer-Policy`, no `window.opener` exposure on redirect flows.

## 8. AI-specific security

- **Prompt injection:** treat RAG content as untrusted; separate instruction vs. content blocks; test adversarial inputs in the eval set.
- **Output guardrails:** refuse out-of-scope (medical/veterinary/legal); never fabricate data/prices/schemes (prompt rule + eval enforcement).
- **Cost abuse:** quotas + rate limits + alerting on anomalous usage (tie to SEC-08/SEC-09).
- **Misuse logging:** flag and review unsafe/offensive queries (no PII).

## 9. OWASP Top 10 checklist (current vs target)

| OWASP | Area | Status today | Phase 1 target |
|---|---|---|---|
| A01 | Broken Access Control | **Partial** — IDOR via email claims fixed (E1-S5); legacy `/test` exposure remains | `requireAuth` + ownership scoping (E1-S4/S5) + remove `/test` |
| A02 | Cryptographic Failures | **Fail** — unverified JWT, secrets in plaintext | Full token verification, secret manager, HTTPS |
| A03 | Injection | Partial — Mongo via Mongoose is safe; prompt injection open | Input validation, prompt hardening |
| A04 | Insecure Design | Partial — no rate limits/quotas | Rate limiting, quotas, misuse logging |
| A05 | Security Misconfiguration | Partial — CORS allow-list + 1MB body limit enforced (E1-S7); error responses sanitized (E1-S6); auto-deploy remains | Rate limits (E1-S8), gated deploys |
| A06 | Vulnerable Components | Monitor | `npm audit` in CI, dependency update policy |
| A07 | Identification/Auth Failures | **Fail** — decode-without-verify | Verified tokens + refresh lifecycle |
| A08 | Software/Data Integrity | Partial — ECR images untagged by SHA | Tag images, pinned deps, SBOM (later) |
| A09 | Logging/Monitoring | **Fail** — no structured logging/alerting | Structured logs, Sentry, alerts |
| A10 | SSRF | Low (no fetch-on-user-URL today) | Keep validated external calls; no SSRF-prone patterns |

## 10. Remediation plan (ordered)

| Step | Effort | Blocks |
|---|---|---|
| 1. Remove `/test/*` routes + controller | S | SEC-03 |
| 2. Verified JWT + `requireAuth` + ownership scoping | M | SEC-01, SEC-02 |
| 3. Rate limits (CORS + body limits done — E1-S7) | M | SEC-08/09 |
| 4. Rotate all secrets; add `.env.example`; secret scanning in CI | S | SEC-07 |
| 5. Frontend token handling rework (httpOnly/short-lived + refresh) | M | SEC-06 |
| 6. PII-in-URL removal; request-id logging | S | SEC-10 |
| 7. Prompt-injection tests + output guardrails in AI eval | M | SEC-11 |
| 8. Gated releases (no direct-to-prod on push) | M | SEC-12 |
| 9. Privacy/consent/retention framework documented | M | SEC-13 |

> Every remediation is tracked in [17_Backlog.md](../planning/17_Backlog.md) and referenced from [18_DECISIONS.md](../decisions/18_DECISIONS.md).
