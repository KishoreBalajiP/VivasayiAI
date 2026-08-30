# 08 — API Documentation

> **Metadata**
> - **Title:** 08 — API Documentation
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Backend / Frontend / QA
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [06_System_Architecture](06_System_Architecture.md) · [07_Database_Design](07_Database_Design.md) · [12_Technical_Guidelines](../engineering/12_Technical_Guidelines.md) · [15_Security](../engineering/15_Security.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** The contract between frontend, backend, QA, and future integrations. Every live endpoint is documented with request/response shapes, auth, validation, and errors. It is the reference for building clients and for the Phase 1 API cleanup (deduping `/chat/*` vs `/chatsessions/*`).

**Base URL:** `http://localhost:8000` (dev) / deployed Lambda URL (prod). All responses use the `ApiResponse` envelope:

```json
{
  "statusCode": 200,
  "message": "…",
  "data": { }
}
```

**Conventions:** JSON bodies, `Content-Type: application/json`. Errors thrown by `ApiError` produce `{ statusCode, message, cause, error, icon }` (note: the current `asyncHandler` returns the stack as `cause` — see **Security note** below).

---

## 0. Security & standards note (read first)

- **There is no enforced authentication on any endpoint today.** Identity is an `email`/`userEmail` field the client sends. The Phase 1 `requireAuth` middleware will replace this (F-19). Until then, these contracts are **interim** and must not be assumed safe.
- **Error responses currently leak internal stack traces** via `asyncHandler`. Sanitization is scheduled (F-24).
- Planned standardization (F-18/F-19): `/api/v1` prefix, `requireAuth`, OpenAPI/Swagger export, typed client generation.
- **Vision-v2 (see [AI_Product_Principles.md](../product/AI_Product_Principles.md)):** the `/chat` contract evolves from "send text" to "submit an interaction the platform resolves with automatic context" — the Context Engine assembles farm context server-side (APP-03), the Model Adapter picks the provider (APP-05), and images enter the diagnosis pipeline (APP-07). New planned resources: farm profile, context snapshot, diagnosis, model-provider health.
- **Weather (`/weather`)** is the first Context Engine slice (E2-S1, F-20): a read-only proxy over Open-Meteo with a Mongo cache and degrade-to-unknown semantics (D-15..D-18). It is the input that the Context Engine will inject into prompts.

---

## 1. System / health

### 1.1 `GET /`
Backend liveness probe.

**Response `200`:**
```json
{ "statusCode": 200, "message": "Backend is Live!", "data": {} }
```
*Returns plain `{ "message": "Backend is Live!" }` in the current implementation.*

---

## 2. Auth

### 2.1 `POST /auth/google` — Google OAuth2 login (code exchange)

Exchanges the Cognito authorization code for tokens and creates/updates the user.

**Request body:**
```json
{ "code": "AUTHORIZATION_CODE_FROM_COGNITO_REDIRECT" }
```

**Success `200`:**
```json
{
  "statusCode": 200,
  "message": "Login successful",
  "data": {
    "user": { "_id": "…", "name": "Kishore", "email": "farmer@example.com" },
    "id_token": "eyJhbGciOi…"
  }
}
```

**Errors:**
- `400` — `Missing authorization code`
- `500` — `Authentication failed` (Cognito exchange/decode error)

**Validation:** `code` required. **Auth:** none (this is the login endpoint).

> ⚠️ **Interim implementation:** the backend calls `jwt.decode(id_token)` **without signature verification**, then upserts `User` by email. The returned `id_token` is what the frontend stores. This flow is replaced in Phase 1 (see [15_Security.md](../engineering/15_Security.md), [18_DECISIONS.md ADR-002](../decisions/18_DECISIONS.md)).

---

## 3. Chat (AI)

### 3.1 `POST /chat` — Send a message (RAG + context)

**Request body:**
```json
{
  "message": "How should I water my tomatoes?",
  "chatId": "670f8a5b1234567890abcdef",   // optional — continue existing session
  "userEmail": "farmer@example.com",       // required today
  "language": "en",                        // accepted by client; ignored by backend (response language is inferred from the question)
  "district": "Thanjavur"                  // optional — farmer district captured by the client; feeds Context assembly (E2-S3)
}
```

**Success `200`:**
```json
{
  "statusCode": 200,
  "message": "Chat response generated successfully",
  "data": {
    "chatId": "670f8a5b1234567890abcdef",
    "messages": [
      { "sender": "user", "text": "How should I water my tomatoes?" },
      { "sender": "ai", "text": "Based on our earlier discussion…" }
    ],
    "response": "Based on our earlier discussion…",
    "hasContext": true,
    "hasChatHistory": true,
    "sourceCount": 3,
    "chatHistoryCount": 4,
    "timestamp": "2026-08-07T10:30:00.000Z",
    "session": { "_id": "…", "userEmail": "farmer@example.com", "title": "How should I water my tomatoes?", "messages": [ … ] }
  }
}
```

**Behavior:**
- If `chatId` is provided and exists: loads history, appends user+AI messages, saves.
- Otherwise: creates a new session, title = first message (truncated).
- **Context assembly (E2-S3):** when `district` is provided, the backend assembles weather (E2-S1 proxy, cache-first), soil/region (E2-S2 `districts` reference) and crop (detected from the message) into a labelled plain-text "Context" block that is injected into the system prompt. Missing domains degrade to explicit `unknown` markers (ADR-014, D-03) and never cause a 5xx. Farm profile is `unknown` until E2-S4.
- RAG + chat memory (last 6 messages) → prompt → Gemini → response. RAG failure falls back to chat-context-only.

**Errors:**
- `400` — `Message is required` / `userEmail is required` / model error payload

**Validation:** `message` (required), `userEmail` (required today), `district` (optional, 1–80 chars); `message` length capped at `MESSAGE_MAX_LENGTH`. No other length caps yet (planned F-24).

### 3.2 `GET /chat/session/:chatId` — Get one session `[DEPRECATED — duplicates 4.4]`

**Query params:** `userEmail` (required today).

**Success `200`:** `data.chatSession` = full session document.
**Errors:** `400` — missing ids; `404` — `Chat session not found`.

### 3.3 `GET /chat/sessions?userEmail=…` — List sessions `[DEPRECATED — duplicates 4.3]`

**Query params:** `userEmail` (required today).

**Success `200`:**
```json
{
  "data": {
    "chatSessions": [
      { "_id": "…", "title": "…", "updatedAt": "…", "createdAt": "…", "messageCount": 5, "lastMessage": "…" }
    ],
    "total": 1
  }
}
```
Limited to 50 sessions, sorted by `updatedAt` desc. No pagination beyond the 50-cap.

---

## 4. Chat sessions (CRUD)

### 4.1 `POST /chatsessions/new` — Create empty session

**Request body:** `{ "userEmail": "farmer@example.com", "title": "New Chat" }` (`title` optional)

**Success `200`:** `data.session` = new session (empty `messages`).

### 4.2 `POST /chatsessions/:id/message` — Append a message (manual)

**Request body:** `{ "sender": "user", "text": "…" }` — `sender` must be `user`/`ai`/`system`.

**Behavior:** sets title from the first message (first 40 chars) when session is empty.
**Success `200`:** `data.session` = updated session.
**Errors:** `400` — sender/text required; `404` — not found.

> Note: the `/chat` controller also appends messages; both paths write to the same embedded array. Consolidation planned (F-18).

### 4.3 `GET /chatsessions/list/:email` — List a user's sessions

**Success `200`:** `data.sessions` = all sessions (sorted `updatedAt` desc) — **no pagination** (planned F-28).

### 4.4 `GET /chatsessions/:id` — Get a session

**Success `200`:** `data.session` = full session with messages.
**Errors:** `400` — `Session not found`.

### 4.5 `DELETE /chatsessions/:id` — Delete a session

**Request body:** `{ "userEmail": "farmer@example.com" }` *(used for ownership check)*

**Success `200`:** `Chat session deleted successfully`.
**Errors:** `400` — not found; `401` — `You cannot delete another user's chat` (only enforced when body email differs).

> ⚠️ Ownership check is client-supplied — spoofable. Replaced by token-derived identity in Phase 1 (F-19).

### 4.6 `DELETE /chatsessions/clear/all` — Clear all sessions for a user

**Request body:** `{ "userEmail": "farmer@example.com" }`

**Success `200`:** `All chat sessions deleted (N chats removed)`.

> ⚠️ Route ordering note: this route must be registered **before** `/:id` so `clear/all` is not captured by `:id`. It is (line order in `routes/chatSessions.js`).

---

## 5. Weather (Context Engine — first slice)

### 5.1 `GET /weather?district=<name>` — Current + 1-day forecast (Open-Meteo proxy)

Backend proxy + Mongo cache for Open-Meteo. The frontend (login weather card) still uses Open-Meteo directly today; this endpoint exists so the Context Engine (F-20) can inject cached, fresh-labelled weather into prompts without each chat call hitting the upstream provider (E2-S1, D-15..D-18).

**Query params:** `district` (required, 1–80 chars). Free-form name — resolved server-side via Open-Meteo geocoding; the 38-district reference set is a separate seed (E2-S2).

**Success `200`:**
```json
{
  "statusCode": 200,
  "message": "Weather retrieved successfully",
  "data": {
    "district": "chennai",
    "current": {
      "temperature": 31.4,
      "windspeed": 4.1,
      "weatherCode": 2,
      "isDay": 1,
      "summary": "Partly cloudy"
    },
    "forecast": [
      {
        "date": "2026-08-08",
        "temperatureMax": 34.2,
        "temperatureMin": 26.8,
        "weatherCode": 2,
        "precipitation": 0.3,
        "summary": "Partly cloudy"
      }
    ],
    "source": "open-meteo",
    "cached": true,
    "ageSeconds": 142,
    "freshness": "fresh"
  }
}
```

**Envelope fields:**
- `district` — lowercased district key (cache key).
- `current` — `null` when the provider failed and no cache exists.
- `forecast` — 1-day daily array (current `forecast_days` is 1).
- `source` — provider label (`open-meteo`).
- `cached` — `true` when served from Mongo cache.
- `ageSeconds` — seconds since the cached snapshot was written.
- `freshness` — `"fresh"` (within `WEATHER_CACHE_TTL_MS`, default 30 min) or `"stale"` (within `WEATHER_STALE_AFTER_MS`, default 60 min, per D-18 hybrid).

**Degraded responses (still `200`, per D-18 — never blocks the answer):**
```json
{
  "statusCode": 200,
  "message": "Weather retrieved successfully",
  "data": {
    "district": "atlantis",
    "current": null,
    "forecast": [],
    "source": "open-meteo",
    "cached": false,
    "ageSeconds": 0,
    "status": "unknown",
    "note": "District could not be resolved; no weather data available."
  }
}
```
- `status: "unknown"` is set when the district fails to geocode, or when the provider fails and no stale cache exists.
- A stale cache hit after provider failure is still labelled (`freshness: "stale"`, `cached: true`) so callers (and the future Context Engine snapshot) can hedge on time-sensitive advice.

**Errors:**
- `400` — `District is required` / `District name exceeds 80 character limit`.

**Validation:** `district` required, trimmed, max 80. **Auth:** none today (interim; will move behind `requireAuth` with F-19/F-20 context assembly). **Rate limiting:** not mounted today (light public-style read; revisit if abuse observed).

**Caching:** Mongo collection `weathercaches` with TTL index on `cachedAt` (auto-expire after `WEATHER_CACHE_TTL_MS` / 1000 seconds). Cache key is lowercased district name.

**Configuration (`.env`):**
- `WEATHER_CACHE_TTL_MS` (default `1800000` = 30 min)
- `WEATHER_FETCH_TIMEOUT_MS` (default `5000`)
- `WEATHER_STALE_AFTER_MS` (default `3600000` = 60 min)
- `OPEN_METEO_BASE_URL` (default `https://api.open-meteo.com/v1`)
- `OPEN_METEO_GEOCODING_BASE_URL` (default `https://geocoding-api.open-meteo.com/v1`)

---

## 6. Farm profile (Context Engine second slice)

The farm profile is the farmer's onboarding identity context (E2-S4, F-21, D-10 Option 1). It holds
`district`, `crops`, and `acres` — the minimal PII set per APP-10. Soil type and phone are deliberately
not collected (soil is district-derived per D-19; phone is PII deferred to WhatsApp, E6). A profile is
1:1 with a user (keyed by `userEmail`, the only identity available today; `cognitoSub` is planned in
E1-S3). The Context Engine auto-loads it for the caller (D-14) so a returning farmer is not re-asked
(APP-02) and its district/crops drive weather/soil/crop context.

### 6.1 `POST /profile` — Upsert (create or update) a farm profile

| Field | Type | Rules |
|---|---|---|
| `userEmail` | string | Required, valid email |
| `district` | string | Required, 1–80 chars (same validator as `/weather`) |
| `crops` | string[] | Required, 1–20 crop names, each 1–100 chars |
| `acres` | number | Required, positive, ≤ 1e6 |
| `language` | string | Optional, `"en"` \| `"ta"` |

```json
{ "userEmail": "farmer@example.com", "district": "Trichy", "crops": ["paddy", "groundnut"], "acres": 4.5 }
```

**Response `200`:**
```json
{ "statusCode": 200, "message": "Farm profile saved", "data": { "profile": { "_id": "...", "userEmail": "farmer@example.com", "district": "Trichy", "crops": ["paddy", "groundnut"], "acres": 4.5 } } }
```

**Errors:** `400` invalid fields.

### 6.2 `GET /profile/:email` — Get a farm profile

**Response `200`:**
```json
{ "statusCode": 200, "message": "Farm profile fetched", "data": { "profile": { "...": "..." } } }
```

**Errors:** `400` invalid email, `404` profile not found.

### 6.3 `DELETE /profile/:email` — Delete a farm profile

**Response `200`:** `{ "statusCode": 200, "message": "Farm profile deleted" }`

**Errors:** `400` invalid email, `404` profile not found.

### 6.4 Integration with chat

When a caller sends `POST /chat`, the backend passes `userEmail` to the Context Engine. If a profile
exists, its `district` and first crop drive weather/soil/crop context and the `Farm profile: known`
line (with district, crops, acres) is rendered at the top of the Context block. If no profile exists,
the farm-profile line renders `unknown` and no profile data is used.

---

## 7. Test / admin CRUD `[LEGACY — to be removed in Phase 1]`

Exposed under `/test` for capstone demo. **No authentication. Must be removed or gated.**

| Endpoint | Method | Body | Purpose |
|---|---|---|---|
| `/test/user` | POST | `{ name, email }` | Create user |
| `/test/users` | GET | — | **List ALL users (PII)** |
| `/test/query` | POST | `{ userId, queryText, location }` | Create query log |
| `/test/queries` | GET | — | **List ALL queries** |
| `/test/context` | POST | `{ districtName, soilType, crops, fertilizerRecommendations }` | Create district context |
| `/test/contexts` | GET | — | List all contexts |

**Action:** remove `routes/test.js` + `controllers/test.controller.js` in Phase 1 (backlog item [E1-S1](../planning/17_Backlog.md)).

---

## 8. Error reference

| Code | Meaning | Common cases |
|---|---|---|
| `200` | Success | — |
| `400` | Bad request | Missing/invalid fields, model errors, session not found (inconsistently used) |
| `401` | Unauthorized | Ownership mismatch on delete (today); will be auth failures post-Phase 1 |
| `404` | Not found | Session not found (used by some endpoints) |
| `500` | Server error | Cognito exchange failure, model/RAG errors |
| `510` | Programmer error | Uncaught error in `asyncHandler` — returns stack trace to client (must be sanitized, F-24) |

## 9. Request/response examples (curl)

```bash
# Health
curl http://localhost:8000/

# Auth (code from Cognito redirect)
curl -X POST http://localhost:8000/auth/google \
  -H "Content-Type: application/json" \
  -d '{"code":"AUTH_CODE"}'

# New chat (RAG + context)
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Best fertilizer for paddy in delta region?","userEmail":"farmer@example.com"}'

# Follow-up with context
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"How often should I apply it?","chatId":"670f8a5b1234567890abcdef","userEmail":"farmer@example.com"}'

# List sessions
curl "http://localhost:8000/chatsessions/list/farmer@example.com"

# Delete session (interim ownership check)
curl -X DELETE http://localhost:8000/chatsessions/670f8a5b1234567890abcdef \
  -H "Content-Type: application/json" \
  -d '{"userEmail":"farmer@example.com"}'

# Weather (Context Engine — first slice)
curl "http://localhost:8000/weather?district=Chennai"
```

## 9. Planned API changes (Phase 1 + vision-v2)

1. **Namespace:** `/api/v1/…` prefix; versioning.
2. **Auth:** `Authorization: Bearer <JWT>`; `requireAuth` middleware; identity from token only.
3. **Consolidation:** single sessions resource; retire `/chat/session|sessions` duplicates.
4. **Context Engine:** `POST /chat` accepts `{ message, image?, farmId? }`; the backend auto-assembles the context snapshot (farm profile, GPS, weather, soil, season, history, advisories, RAG) and returns `context` in the response for UI trust chips + traceability (F-46, ADR-014).
5. **Farm profile & memory:** `POST/GET/PATCH /api/v1/farms` (profile), `GET /api/v1/farms/:id/memory` (crop history, decisions, outcomes) (F-21, F-47).
6. **Diagnosis pipeline:** `POST /api/v1/diagnose` (multipart image + optional text) → context-fused structured diagnosis card (cause → treatment → safety → escalation) (F-22, ADR-017).
7. **Model provider health:** `GET /api/v1/ai/providers` → active adapter, model, latency — operational view for the Model Adapter (F-45).
8. **Streaming:** `GET`/SSE variant or `stream: true` flag (F-23).
9. **OpenAPI 3.1 spec** exported from the codebase (source of truth for QA tooling).
