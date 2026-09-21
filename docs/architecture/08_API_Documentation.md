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

**Conventions:** JSON bodies, `Content-Type: application/json`. Errors produce a safe envelope `{ statusCode, message, data:{} }` — `message` is a controlled literal for `ApiError`, or a fixed generic for internal/parse errors; no stack/cause is ever sent to clients (E1-S6, SEC-05 resolved; see **Security note** below).

---

## 0. Security & standards note (read first)

- **Authentication (E1-S4):** All application routes — `/chat`, `/chatsessions`, `/weather`, `/profile` — require `Authorization: Bearer <session JWT>` (obtained from `POST /auth/google`, E1-S3). Requests without a valid token return `401`. The public set is limited to `/`, `/health`, and `/auth`. Identity derives only from the verified token (`req.user`).
- **Ownership (E1-S5 / ADR-018 / D-35):** all `/chat`, `/chatsessions`, and `/profile` resources are scoped by the authenticated user's `cognitoSub` (`req.user.id`) — **never** a client-supplied `userEmail`. The client **no longer sends** `userEmail` in bodies/query/path on these routes; foreign/unowned resources return `404`. This replaces the interim email-keyed ownership that E1-S4 noted.
- **Error sanitization (E1-S6 / SEC-05 resolved):** error responses never leak internal stack traces or causes to clients. `errorHandler` (registered last in `index.js`) returns `ApiError.message` (controlled literals) for business errors, `"Internal server error"` for unexpected/internal failures, and `"Invalid JSON payload"` for body-parse failures — each with `data:{}`, no `stack`/`cause` in the body. Full `err` (with stack) is logged **server-side** only. Verified by `t209-verify.mjs`.
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
    "accessToken": "eyJhbGciOiJIUzI1NiIs…",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs…"
  }
}
```

**Errors:**
- `400` — `Missing authorization code`
- `500` — `Authentication failed` (Cognito exchange/verify error)

**Validation:** `code` required. **Auth:** none (this is the login endpoint).

> **E1-S2/E1-S3 (implemented):** the backend exchanges the code and **verifies** the Cognito ID token (signature/issuer/audience/expiry via JWKS, RS256-only — SEC-01), upserts `User` by `cognitoSub`, and returns **backend-issued session tokens** (`accessToken` short-lived ~15 min; `refreshToken` ~30 days, HS256-signed) rather than the raw Cognito `id_token`. The client presents `accessToken` as `Authorization: Bearer <token>` to `requireAuth`. The `POST /auth/refresh` endpoint and refresh-token rotation/revocation are deferred to later stories (D-34/E1-S12).

---

## 3. Chat (AI)

### 3.1 `POST /chat` — Send a message (RAG + context) or image diagnosis (E3)

**Request body:**
```json
{
  "message": "How should I water my tomatoes?",          // optional if uploadId is present (E3)
  "chatId": "670f8a5b1234567890abcdef",                  // optional — continue existing session
  "language": "en",                                      // optional "en"|"ta" — honored by the image path (E3)
  "district": "Thanjavur",                               // optional — feeds Context assembly (E2-S3)
  "uploadId": "img_1a2b…",                               // optional (E3) — image id from POST /upload → runs image diagnosis
}
```
> Ownership is derived from the verified token (`req.user`); the client does **not** send `userEmail` (E1-S5/ADR-018).

**Text-chat success `200`:** same envelope as below (no `uploadId`/`image` fields). `language` remains ignored by the text path (inferred from the question); the **image path honors it** (see 3.2).

**Image-diagnosis success `200`** (when `uploadId` is present):
```json
{
  "statusCode": 200,
  "message": "Chat response generated successfully",
  "data": {
    "chatId": "670f8a5b1234567890abcdef",
    "messages": [
      { "sender": "user", "text": "", "imageId": "img_1a2b…" },
      { "sender": "ai", "text": "உங்கள் நெல் இலைகளில்… / Your paddy leaves show…" }
    ],
    "response": "…farmer-facing diagnosis…",
    "uploadId": "img_1a2b…",
    "image": {
      "status": "completed",
      "processed": { "mediaType": "image/jpeg", "size": 41234, "width": 1024, "height": 768 },
      "vision": {
        "crop": "rice",
        "symptoms": ["yellowing of lower leaves"],
        "likelyIssues": [
          { "name": "Nitrogen deficiency", "type": "deficiency", "confidence": "medium", "evidence": ["…"] }
        ],
        "confidence": "medium",
        "uncertain": false,
        "summary": "…"
      }
    },
    "hasContext": true,
    "hasChatHistory": false,
    "sourceCount": 3,
    "timestamp": "2026-08-07T10:30:00.000Z",
    "session": { "…": "…" }
  }
}
```

**Behavior (image path, E3):**
- The `uploadId` must have been returned to the **same caller** by `POST /upload`; foreign/unknown ids → `404 Image upload not found` (no cross-user access).
- Pipeline (synchronous, D-22 Option 1 / D-41): S3 fetch → Gemini vision observation (structured JSON; explicit uncertainty — never fabricated) → Context assembly + RAG (both best-effort, as in text chat) → farmer reasoning → session persistence. Vision-API errors → sanitized `500`; unparseable vision output → conservative `unclear` response telling the farmer a clearer photo is needed.
- `language`: explicit `"ta"`/`"en"` wins; otherwise inferred from the message, then the caller's farm-profile language, then English. The stored AI message and `response` use that language; `messages[0].imageId` links the turn to the upload.

**Behavior (text path):**
- If `chatId` is provided and exists: loads history, appends user+AI messages, saves. Otherwise: creates a new session, title = first message (truncated).
- **Context assembly (E2-S3):** when `district` is provided, the backend assembles weather/soil/region/crop into a labelled "Context" block injected into the system prompt; missing domains degrade to explicit `unknown` (ADR-014, D-03), never 5xx.
- RAG + chat memory (last 6 messages) → prompt → Gemini → response. RAG failure falls back to chat-context-only.

**Errors:**
- `400` — `Message is required` (no message and no `uploadId`) / `Invalid image upload ID` / model error payload
- `404` — `Image upload not found` (foreign or unknown `uploadId`)
- `500` — `Failed to analyze the image` (vision provider failure; sanitized)

**Validation:** `message` (optional if `uploadId` present; else required; length capped at `MESSAGE_MAX_LENGTH`), `district` (optional, 1–80 chars), `language` (`en`/`ta`), `uploadId` (must match `img_<uuid>` server-issued format).

> **Removed (E4-S3, 2026-09-11):** the legacy `GET /chat/session/:chatId` and `GET /chat/sessions` routes duplicated Section 4 (`/chatsessions/*`). They are **gone**; the single sessions resource is Section 4. Requests to `/chat/session/*` / `/chat/sessions` now return `404` (token present) / `401` (no token). `t212-verify.mjs` asserts the retirement.

---

## 4. Chat sessions (CRUD)

### 4.1 `POST /chatsessions/new` — Create empty session

**Request body:** `{ "title": "New Chat" }` (`title` optional). Ownership = caller's `cognitoSub` (token).

**Success `200`:** `data.session` = new session (empty `messages`).

### 4.2 `POST /chatsessions/:id/message` — Append a message (manual)

**Request body:** `{ "sender": "user", "text": "…" }` — `sender` must be `user`/`ai`/`system`.

**Behavior:** sets title from the first message (first 40 chars) when session is empty.
**Success `200`:** `data.session` = updated session.
**Errors:** `400` — sender/text required; `404` — not found.

> Note: the `/chat` controller also appends messages; both paths write to the same embedded array. Consolidation planned (F-18).

### 4.3 `GET /chatsessions/list` — List the caller's sessions

**Success `200`:** `data.sessions` = all sessions owned by `req.user` (sorted `updatedAt` desc) — **no pagination** (planned F-28).

### 4.4 `GET /chatsessions/:id` — Get a session

**Success `200`:** `data.session` = full session with messages.
**Errors:** `404` — `Session not found` (unowned/foreign ids also 404).

### 4.5 `DELETE /chatsessions/:id` — Delete a session

**Success `200`:** `Chat session deleted successfully`. Deletes only the caller's session (`cognitoSub`); unowned/foreign → 404.
**Errors:** `404` — `Chat session not found`.
> E1-S5 (ADR-018): ownership from the token; no `userEmail` in the body. Foreign/deleted → 404, never 403.

### 4.6 `DELETE /chatsessions/clear/all` — Clear all sessions for the caller

Clears all sessions owned by `req.user` (`cognitoSub`). No request body.

**Success `200`:** `All chat sessions deleted (N chats removed)`.

> ⚠️ Route ordering note: this route must be registered **before** `/:id` so `clear/all` is not captured by `:id`. It is (line order in `routes/chatSessions.js`).

---

## 5. Weather (Context Engine — first slice)

### 5.1 `GET /weather?district=<name>` — Current + 1-day forecast (Open-Meteo proxy)

Backend proxy + Mongo cache for Open-Meteo. The frontend (login weather card) still uses Open-Meteo directly today; this endpoint exists so the Context Engine (F-20) can inject cached, fresh-labelled weather into prompts without each chat call hitting the upstream provider (E2-S1, D-15..D-18).

**Auth:** `Authorization: Bearer <token>` — required (behind `requireAuth`; `401` without a valid session token).

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
1:1 with a user, **owned/scoped by the caller's `cognitoSub` from the token** (E1-S5/ADR-018; `userEmail` is a retained display/legacy dual-key set server-side). The Context Engine auto-loads it for the caller (D-14) so a returning farmer is not re-asked
(APP-02) and its district/crops drive weather/soil/crop context.

### 6.1 `POST /profile` — Upsert (create or update) the caller's farm profile

| Field | Type | Rules |
|---|---|---|
| `district` | string | Required, 1–80 chars (same validator as `/weather`) |
| `crops` | string[] | Required, 1–20 crop names, each 1–100 chars |
| `acres` | number | Required, positive, ≤ 1e6 |
| `language` | string | Optional, `"en"` \| `"ta"` |

```json
{ "district": "Trichy", "crops": ["paddy", "groundnut"], "acres": 4.5 }
```

> Ownership/`userEmail` derive from the token; the client does **not** send `userEmail` (E1-S5/ADR-018).

**Response `200`:**
```json
{ "statusCode": 200, "message": "Farm profile saved", "data": { "profile": { "_id": "...", "cognitoSub": "...", "userEmail": "farmer@example.com", "district": "Trichy", "crops": ["paddy", "groundnut"], "acres": 4.5 } } }
```

**Errors:** `400` invalid fields.

### 6.2 `GET /profile` — Get the caller's farm profile

**Response `200`:**
```json
{ "statusCode": 200, "message": "Farm profile fetched", "data": { "profile": { "...": "..." } } }
```

**Errors:** `404` — no profile for the caller.

### 6.3 `DELETE /profile` — Delete the caller's farm profile

**Response `200`:** `{ "statusCode": 200, "message": "Farm profile deleted" }`

**Errors:** `404` — no profile for the caller.

### 6.4 Integration with chat

When a caller sends `POST /chat`, the backend looks up the caller's profile **by `cognitoSub` from the token** (E1-S5/ADR-018). If a profile
exists, its `district` and first crop drive weather/soil/crop context and the `Farm profile: known`
line (with district, crops, acres) is rendered at the top of the Context block. If no profile exists,
the farm-profile line renders `unknown` and no profile data is used.

---

## 7. Image upload (E3) + diagnosis

#### `POST /upload`
**Summary:** Authenticated multipart image upload → normalize → private-S3 store → metadata record. The returned `uploadId` is then passed to `POST /chat` (Section 3.1) to run the diagnosis pipeline.

**Request Content-Type:** `multipart/form-data; boundary=<boundary>`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `image` | binary file part | yes | field name must be `image` |

**Required headers:** `Authorization: Bearer <session-token>`

**Constraints (env-configurable):**
- Approved MIME types: `image/jpeg`, `image/png`, `image/webp` (magic-byte sniffed; declared type must match bytes; SVG excluded)
- Max file size: `IMAGE_UPLOAD_MAX_BYTES` (default 5 MB; enforced in-process, not just busboy)
- Per-user rate limit: `UPLOAD_RATE_LIMIT_WINDOW_MS` / `UPLOAD_RATE_LIMIT_MAX` (default 10 requests / 60 s)
- Single file only (`files: 1`); original filename is never trusted or echoed
- Decode + normalize (D-22 Option 1): the payload must be a real decodable image (sharp strict decode + 20 MP guard); the stored image is re-encoded in its original family with EXIF stripped, orientation applied, and longest edge capped at `IMAGE_MAX_DIMENSION` (default 2048). `IMAGE_STORAGE_MODE=mock` (dev/test only) swaps S3 for an in-memory stub.

**Response (200):**
```json
{
  "statusCode": 200,
  "message": "Image uploaded successfully",
  "data": {
    "uploadId": "img_<uuid>",
    "mediaType": "image/png",
    "extension": "png",
    "size": 1234,
    "status": "stored",
    "processed": { "mediaType": "image/png", "size": 980, "width": 1024, "height": 768 }
  }
}
```
`size`/`mediaType`/`extension` describe the original upload; `processed` describes the normalized image actually stored (metadata only — binary lives in private S3 under an owner-scoped, server-generated key; `s3Key` is **never** returned to clients).

| Status | Meaning |
|--------|---------|
| 200 | Upload normalized, stored in S3 and recorded (owned by caller, status `stored`) |
| 400 | Missing file, unsupported MIME, magic-byte mismatch, corrupt/undecodable bytes, unexpected field, multiple files |
| 401 | No / invalid bearer token |
| 413 | Image exceeds `IMAGE_UPLOAD_MAX_BYTES` |
| 429 | Per-user rate limit exceeded |
| 500 | Image storage unavailable (S3/config failure; sanitized) |

> **Diagnosis (E3-S2):** send `POST /chat { uploadId, message?, language?, chatId? }` (Section 3.1) to run vision analysis + agricultural reasoning on this image. The chat session's AI turn returns the diagnosis; the `image.vision` block carries the structured observation for the E3-S4 diagnosis card. **Remaining product decisions, unchanged by this work:** D-23 (S3 retention/lifecycle/signed-URL retrieval — configured on private storage with an `uploads/` prefix; bucket choice, 90-day lifecycle and presigned URL serving pending approval), D-24 (EXIF/consent — EXIF stripped at upload as the approved normalize side-effect), D-38 (privacy/consent framework). E3-S3/E3-S4 are frontend stories.

---

## 8. Test / admin CRUD `[LEGACY — to be removed in Phase 1]`

Exposed under `/test` for capstone demo. **No authentication. Must be removed or gated.**

| Endpoint | Method | Body | Purpose |
|---|---|---|---|
| `/test/user` | POST | `{ name, email }` | Create user |
| `/test/users` | GET | — | **List ALL users (PII)** |
| `/test/query` | POST | `{ userId, queryText, location }` | Create query log |
| `/test/queries` | GET | — | **List ALL queries** |
| `/test/context` | POST | `{ districtName, soilType, crops, fertilizerRecommendations }` | Create district context |
| `/test/contexts` | GET | — | List all contexts |

> **Removed (E1-S1):** the `/test/*` routes, `routes/test.js`, and `controllers/test.controller.js` are gone; the `queries`/`contexts` collections are legacy/unused. See [17_Backlog](../planning/17_Backlog.md).

---

## 9. Error reference

| Code | Meaning | Common cases |
|---|---|---|
| `200` | Success | — |
| `400` | Bad request | Missing/invalid fields, model errors, session not found (inconsistently used) |
| `401` | Unauthorized | Ownership mismatch on delete (today); will be auth failures post-Phase 1 |
| `404` | Not found | Session not found (used by some endpoints) |
| `500` | Server error | Cognito exchange failure, model/RAG errors → returns fixed generic `"Internal server error"`, no stack/cause (E1-S6) |
| `510` | (removed) | Uncaught error in `asyncHandler` — deprecated. `asyncHandler` forwards all errors to `errorHandler`, which sanitizes and returns `500`. No stack traces reach clients (E1-S6, SEC-05) |

## 10. Request/response examples (curl)

```bash
# Health
curl http://localhost:8000/

# Auth (code from Cognito redirect)
curl -X POST http://localhost:8000/auth/google \
  -H "Content-Type: application/json" \
  -d '{"code":"AUTH_CODE"}'

# New chat (RAG + context) — ownership from the Bearer token (E1-S5)
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"message":"Best fertilizer for paddy in delta region?"}'

# Follow-up with context
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"message":"How often should I apply it?","chatId":"670f8a5b1234567890abcdef"}'

# List the caller's sessions
curl "http://localhost:8000/chatsessions/list" \
  -H "Authorization: Bearer <ACCESS_TOKEN>"

# Delete the caller's session
curl -X DELETE http://localhost:8000/chatsessions/670f8a5b1234567890abcdef \
  -H "Authorization: Bearer <ACCESS_TOKEN>"

# Weather (Context Engine — first slice)
curl "http://localhost:8000/weather?district=Chennai"
```

## 11. Planned API changes (Phase 1 + vision-v2)

1. **Namespace:** `/api/v1/…` prefix; versioning.
2. **Auth:** `Authorization: Bearer <JWT>`; `requireAuth` middleware; identity from token only.
3. ~~Consolidation: single sessions resource; retire `/chat/session|sessions` duplicates~~ **Done (E4-S3).** `/chat/session|sessions` are removed; `/chatsessions/*` is the single sessions resource.
4. **Context Engine:** `POST /chat` accepts `{ message, image?, farmId? }`; the backend auto-assembles the context snapshot (farm profile, GPS, weather, soil, season, history, advisories, RAG) and returns `context` in the response for UI trust chips + traceability (F-46, ADR-014).
5. **Farm profile & memory:** `POST/GET/PATCH /api/v1/farms` (profile), `GET /api/v1/farms/:id/memory` (crop history, decisions, outcomes) (F-21, F-47).
6. **Diagnosis pipeline:** `POST /api/v1/diagnose` (multipart image + optional text) → context-fused structured diagnosis card (cause → treatment → safety → escalation) (F-22, ADR-017).
7. **Model provider health:** `GET /api/v1/ai/providers` → active adapter, model, latency — operational view for the Model Adapter (F-45).
8. **Streaming:** `GET`/SSE variant or `stream: true` flag (F-23). **Blocked (E4-S1):** production path is Lambda + `serverless-http` (buffered responses) with no `RESPONSE_STREAM` invoke mode; requires D-05 (SSE transport decision) + streaming-capable deploy infra before implementation.
9. **OpenAPI 3.1 spec** exported from the codebase (source of truth for QA tooling).
10. **Agricultural Loss Claim (Phase 1 — Parcel Foundation + Claim Verification):**
    - Farm Parcel Management (extends `/profile`):
      - `POST /profile/parcels` — create parcel with geometry (server calculates area)
      - `GET /profile/parcels` — list parcels with geometry + calculated area
      - `PATCH /profile/parcels/:parcelId` — update name/crop
      - `DELETE /profile/parcels/:parcelId`
      - `POST /profile/parcels/:parcelId/area` — recalculate area from geometry
    - Claim Lifecycle:
      - `POST /claims` — create draft claim (parcelId, eventType, eventDate, geometry, idempotencyKey)
      - `GET /claims` — list my claims (paginated)
      - `GET /claims/:id` — claim detail + evidence + assessment
      - `POST /claims/:id/submit` — draft → submitted (triggers processing)
      - `POST /claims/:id/withdraw` — draft/submitted → withdrawn
      - `POST /claims/:id/resubmit` — more_evidence_required → submitted (with new evidence)
    - Claim Evidence (reuses existing presigned S3 pipeline):
      - `POST /claims/:id/evidence/presign` — { contentType, size, filename? } → { uploadId, uploadUrl, expiresIn }
      - `POST /claims/:id/evidence/:evidenceId/complete` — verifies + stores (pHash dedup)
      - `DELETE /claims/:id/evidence/:evidenceId` — allowed in draft/submitted/more_evidence_required
      - `GET /claims/:id/evidence/:evidenceId/url` — signed GET (owner/admin only, 5 min TTL)
    - Claim Area Calculation (authoritative backend):
      - `POST /claims/calculate-area` — { geometry } → { areaAcres, remainingEligible, overlapWarnings }
    - Admin (Phase 10, exception-only):
      - `GET /admin/claims` — queue with filters/pagination
      - `GET /admin/claims/:id` — full detail + evidence signed URLs + assessment + audit
      - `POST /admin/claims/:id/override` — approved/rejected with reason (second-admin if >X acres)

All claim endpoints: `requireAuth` + ownership scoping (`cognitoSub`); `claimLimiter` + `evidenceLimiter` rate limits; 404 for foreign resources; idempotency keys on create/submit.

> **Status (Phase 2 implementation note):** implemented — `POST /claims`, `GET /claims`, `GET /claims/:id` (detail + evidence; `assessment: null` until the verification phases), `POST /claims/:id/submit`, `POST /claims/:id/withdraw`, `POST /claims/:id/resubmit`, and all four claim-evidence endpoints (presign / complete / delete / signed-GET url). **Deferred to later phases** (not part of Phase 2): `POST /claims/calculate-area` (needs the E9-S3/S4 area-eligibility/overlap engine, P5), admin endpoints (Phase 10), and pHash dedup on evidence complete (E9-S6). There is **no `PATCH /claims/:id`** draft-update endpoint — the finalized contract does not define one; draft claims are re-created or resubmitted per the contract.
