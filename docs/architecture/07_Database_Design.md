# 07 — Database Design

> **Metadata**
> - **Title:** 07 — Database Design
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Backend / Data
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [06_System_Architecture](06_System_Architecture.md) · [08_API_Documentation](08_API_Documentation.md) · [09_AI_Architecture](09_AI_Architecture.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** Defines every MongoDB collection, its fields, constraints, indexes, and relationships, plus the ER diagram and the schema changes planned for production. It is the reference for any query, migration, or schema decision.

**Database:** MongoDB Atlas, database name `farmingDB`, accessed via Mongoose (`mongoose@8`).
**ORM:** Mongoose models in `tn-farming-assistant/models/`.

---

## 1. Collections overview

| Collection | Model file | Purpose | Status |
|---|---|---|---|
| `users` | `User.js` | Authenticated users (from Cognito) | `[EXISTING]` used |
| `chatsessions` | `ChatSession.js` | Chat sessions + embedded messages | `[EXISTING]` used |
| `imagerecords` | `ImageRecord.js` | Image metadata + vision result (E3) — binary in S3, never Mongo | `[NEW]` added (E3-S2) |
| `queries` | `Query.js` | Per-query logs with attachments/location | `[EXISTING]` schema, **unused** |
| `contexts` | `Context.js` | District soil/crop context | `[EXISTING]` schema, **unused** |
| `farmprofiles` | `FarmProfile.js` | Farmer onboarding: district, crops, acres, parcels | `[EXISTING]` used |
| `lossclaims` | `LossClaim.js` | Agricultural loss claim (affected-area geometry, event, state) | `[ACTIVE]` Phase 2 (lifecycle + state machine + idempotency) |
| `claimevidence` | `ClaimEvidence.js` | Claim evidence images (owner-scoped, presigned S3) | `[ACTIVE]` Phase 2 (presign/complete/delete/url; pHash deferred to E9-S6) |
| `claimassessment` | `ClaimAssessment.js` | Deterministic verification result + AI aggregate | `[ACTIVE]` Phase 4 = AI evidence assessment stage (E9-S4; decision fields reserved until E9-S5) |
| `claimaudit` | `ClaimAudit.js` | Append-only claim state-transition audit trail | `[ACTIVE]` Phase 2 (farmer transitions; engine/admin with verification phases) |

> **Note:** `queries` and `contexts` were designed for the capstone (context injection, query audit trail) but the chat flow never writes to them today. Under vision-v2, `contexts` becomes the seed for the **Context Engine's reference data** (districts/soil/season) and `queries` (or a successor) becomes the context-snapshot audit store (see §7). Phase 1 re-introduces their purpose via the redesigned Context Engine (F-20/F-46).

---

## 2. Collection: `users`

```js
{
  name:      String,            // from Cognito profile
  email:     String,            // UNIQUE — the current identity key
  language:  String,            // 'en' | 'ta' (field exists; not persisted by the app today)
  createdAt: Date,              // default now
}
```

- **Indexes:** `email` (unique, from schema).
- **Relationships:** 1 → N `chatsessions` (by `userEmail`), 1 → N `queries` (by `userId` — legacy).
- **Known gaps:**
  - No phone number, district, crops, or farm profile (planned F-21).
  - `language` is never updated server-side (`updateUserLanguage` is client-only).
  - Identity is email-string-based; must become `cognitoSub` (immutable, non-spoofable) in Phase 1 (F-19). **Done in E1-S3/E1-S5 (D-35):** `User.cognitoSub` added (unique, sparse) and set at login; `chatsessions`/`profiles` now scope ownership by `cognitoSub` (kept `userEmail` as a display/legacy dual-key).

## 3. Collection: `chatsessions`

```js
{
  cognitoSub: String,            // OWNER KEY (E1-S5/D-35) — required, indexed; from verified token
  userEmail:  String,            // display/legacy dual-key (server-set only) — indexed
  title:      String,            // default "New Chat"; set from first message
  messages: [                    // EMBEDDED ARRAY
    {
      sender:    "user" | "ai" | "system",   // enum, required
      text:      String,                     // required for plain turns; optional when imageId present (E3 — an image-only turn has no text)
      imageId:   String,                     // E3: link-only uploadId (`img_<uuid>`) for attached-image turns; binary never stored here
      timestamp: Date                        // default now
      // _id: false — subdocuments have NO ids
    }
  ],
  createdAt: Date,   // timestamps: true
  updatedAt: Date,
}
```

- **Indexes:** `cognitoSub` (1) · `userEmail` (1, legacy/backfill) · compound `{ cognitoSub: 1, updatedAt: -1 }` (serves `GET /chatsessions/list` — filter by user, sort by recency — added in the production-hardening pass, 2026-09-11).
- **Relationships:** N → 1 `users` (by `cognitoSub`; ownership scope). Image turns reference `imagerecords.uploadId` via `messages[].imageId` (link-only; the binary + vision metadata live in the image record / S3 — **never duplicated into `chatsessions`**, per the no-binary-in-Mongo rule).
- **API surface:** created via `POST /chatsessions/new`, appended via `POST /chatsessions/:id/message` or the `/chat` controller (including the E3 image-diagnosis path, which appends a user turn carrying `imageId`); listed via `GET /chatsessions/list`; fetched/removed via `GET/DELETE /chatsessions/:id`; cleared via `DELETE /chatsessions/clear/all`. The legacy `GET /chat/session|sessions` duplicates were removed (E4-S3). All scoped to the caller's `cognitoSub` from the token (E1-S5/D-35); unowned/foreign ids return 404.

### Migration note (E1-S5 / ADR-018)
`chatsessions` and `profiles` gain a `cognitoSub` ownership key (indexed; unique+sparse on `profiles` for 1:1). Legacy email-keyed rows are backfilled from the `users` collection (`User.email → User.cognitoSub`) via `scripts/backfillOwnership.js` (idempotent; `--dry-run` available). Rows with no known user mapping are re-keyed on the user's next login (auth upsert). Runs after the `users` collection has `cognitoSub` populated (E1-S3+).

### Known gaps & risks
| Issue | Impact | Plan |
|---|---|---|
| Messages stored as an **unbounded embedded array** | One document grows with every message; `slice(-6)` still loads the whole doc; Mongo 16MB doc limit is reachable in extreme cases | F-28: normalize `messages` into their own collection (or capped + archived) |
| No `_id` on messages | Frontend React keys fall back to indices; no stable message identity for edits/feedback | Part of F-28 |
| No pagination on list | `GET /chatsessions/list` returns all sessions | Add limit/offset + cursor |
| No per-user limits | Storage growth with no cap | Add session/message quotas |
| `updatedAt` not bumped consistently by all endpoints | `POST /chatsessions/:id/message` relies on explicit saves; some paths set `updatedAt` manually | Rely on Mongoose timestamps |

## 4. Collection: `imagerecords` (E3 — image metadata only, never binary)

```js
{
  cognitoSub:   String,       // OWNER KEY (E1-S5/D-35) — required, indexed; from verified token
  userEmail:    String,       // display/legacy dual-key (server-set)
  uploadId:     String,       // server-generated `img_<uuid>` — unique, indexed; never from client filename
  s3Key:        String,       // server-generated object key (owner-scoped under uploads/ prefix); never exposed to clients
  mediaType:    String,       // original declared+sniffed MIME (e.g. image/png)
  size:         Number,       // original upload byte-count
  processed:    {             // normalized image actually stored in S3
    mediaType:  String,
    size:       Number,
    width:      Number,
    height:     Number,
  },
  status:       "stored" | "processing" | "completed" | "failed",
  chatSessionId: ObjectId,    // ref → chatsessions (first owned session that ran analysis on this image; nullable)
  vision:       {             // structured observation returned by the vision stage (nullable)
    crop:       String,       // identified crop/plant or null
    symptoms:   [String],
    likelyIssues: [{
      name:       String,
      type:       "pest" | "disease" | "deficiency" | "environmental" | "other",
      confidence: "high" | "medium" | "low" | "uncertain",
      evidence:   [String],
    }],
    confidence: "high" | "medium" | "low" | "unclear",
    uncertain:  Boolean,
    summary:    String,
  },
  response:     {             // last farmer-facing diagnosis (nullable)
    text:       String,
    language:   "en" | "ta",
  },
  error:        {             // sanitized internal error state (never echoed to clients)
    stage:      String,
    message:    String,
  },
  createdAt:    Date,         // timestamps: true
  updatedAt:    Date,
}
```

- **Ownership / access:** scoped by `cognitoSub` (from the token). The upload (`POST /upload`) always reads/writes on the owner's behalf; diagnosis (`POST /chat` with `uploadId`) checks `{ uploadId, cognitoSub }` — foreign/unknown → 404. `s3Key` is **never** returned in API responses (15_Security §5).
- **Relationships:** 1 → N `chatsessions` via `chatSessionId`; the chat-session message stores the uploadId link via `messages[].imageId` (link-only; no binary stored there).
- **Binary:** the normalized image bytes live in **private S3** (`s3Key`). Mongo stores zero bytes of the image itself (07 rule: never store binary in Mongo).
- **State machine:** `stored → processing → completed | failed`. A completed image can be re-analyzed (status resets to `processing`, vision/response overwritten with the latest run).
- **D-23 pending (buckets/lifecycle):** today the image is stored under the existing `S3_BUCKET` with an `uploads/` prefix; a dedicated private bucket and 90-day lifecycle / signed-URL retrieval remain pending product approval (see `ARCHITECTURE_DECISIONS_PENDING.md` D-23).

---

## 5. Collection: `farmprofiles` (E2-S4 — farmer onboarding with parcels)

```js
{
  cognitoSub:   String,       // OWNER KEY (E1-S5/D-35) — required, unique, sparse, indexed
  userEmail:    String,       // display/legacy dual-key (server-set)
  district:     String,       // required, from 37 TN districts reference
  crops:        [String],     // required, at least one crop
  acres:        Number,       // total declared farm area (legacy field)
  language:     "en" | "ta",
  parcels: [                  // NEW: multiple parcels per farm
    {
      parcelId:       String,           // server-generated `par_<uuid>`
      name:           String,           // farmer-given: "North Field"
      crop:           String,           // primary crop for this parcel
      geometry: {                     // GeoJSON Polygon (WGS84)
        type: "Polygon",
        coordinates: [[[Number, Number]]] // exterior ring only (no holes MVP)
      },
      calculatedAreaAcres: Number,    // authoritative, from geometry
      createdAt: Date,
      updatedAt: Date
    }
  ],
  createdAt: Date,
  updatedAt: Date,
}
```

- **Indexes:** `cognitoSub` (unique, sparse) · `userEmail` · 2dsphere on `parcels.geometry`
- **Ownership / access:** scoped by `cognitoSub` from token; 404 for foreign
- **Parcel rules:**
  - Geometry is REQUIRED for any claim on that parcel
  - `calculatedAreaAcres` is authoritative — server computes from geometry; never client-supplied
  - Multiple parcels per FarmProfile allowed
  - Legacy FarmProfiles without parcels: users must configure parcel geometry before claiming; NO fabricated geometry from district centroid/GPS
- **Migration (additive):** parcels array is optional; existing profiles remain valid but cannot claim until parcel drawn

---

## 6. Collection: `lossclaims` (Agricultural Loss / Affected-Area Claim)

```js
{
  cognitoSub:          String,       // owner (indexed)
  profileId:           ObjectId,     // ref FarmProfile
  parcelId:            String,       // ref to parcels[].parcelId
  parcelSnapshot: {                 // denormalized for audit
    parcelId: String,
    crop: String,
    parcelAreaAcres: Number
  },
  eventType: {
    type: String,
    enum: ["flood", "storm", "drought", "pest", "disease", "fire", "other"],
    required: true
  },
  eventDate:           Date,         // when damage occurred (not future; within claim window)
  claimedGeometry: {                // GeoJSON Polygon (farmer-drawn)
    type: "Polygon",
    coordinates: [[[Number, Number]]]
  },
  claimedAreaAcres:      Number,     // SERVER-CALCULATED from geometry
  evidence:             [ObjectId],  // ClaimEvidence refs
  state: {
    type: String,
    enum: ["draft", "submitted", "processing", "verified", "partially_verified",
           "more_evidence_required", "rejected", "out_of_limit", "duplicate_area", "withdrawn"],
    default: "draft",
    index: true
  },
  idempotencyKey:       String,      // unique, sparse (client UUID)
  submittedAt:          Date,
  processedAt:          Date,
  decidedAt:            Date,
}, { timestamps: true }
```

- **Indexes:**
  - `{ cognitoSub: 1, createdAt: -1 }` — my claims
  - `{ parcelId: 1, state: 1 }` — active claims per parcel
  - **Partial unique** `{ parcelId: 1, eventDate: 1, eventType: 1 }` where `state ∈ [verified, partially_verified]` — prevents duplicate verified claims same event+parcel
- **Ownership:** scoped by `cognitoSub`; foreign → 404
- **State machine:** draft → submitted → processing → { verified | partially_verified | more_evidence_required | rejected | out_of_limit | duplicate_area } ; draft/submitted → withdrawn
- **Resubmission:** only from `more_evidence_required` → resubmitted → processing
- **Terminal states:** verified, partially_verified, rejected, out_of_limit, duplicate_area, withdrawn (no silent resubmit)

---

## 7. Collection: `claimevidence` (Claim Evidence Images)

```js
{
  claimId:           ObjectId,     // ref LossClaim (indexed)
  uploadId:          String,       // server-generated `img_<uuid>` — unique
  s3Key:             String,       // owner-scoped: `claims/<claimId>/<uploadId>/file.ext`
  mediaType:         String,
  size:              Number,
  width:             Number,
  height:            Number,
  exifGps: { lat: Number, lon: Number, accuracy: Number }, // if present (not trusted)
  perceptualHash:    String,       // pHash for deduplication
  aiAssessment: {                  // per-image AI output (optional, nullable)
    cropDetected: String,
    damageDetected: Boolean,
    damageType: String,
    severity: String,
    confidence: String,
    uncertain: Boolean,
    visibleAffectedPortion: String,
    imageQuality: String,
    observations: [String]
  },
  uploadedAt:        Date,
}, { timestamps: true }
```

- **Indexes:** `{ claimId: 1, uploadedAt: 1 }`, unique `{ uploadId }`
- **Storage:** reuses existing presigned S3 pipeline; private bucket; owner-scoped keys under `claims/`
- **Dedup:** pHash on complete → reject duplicate images (deferred — E9-S6 anti-fraud; not implemented)
- **State guard:** evidence mutable only in `draft`, `submitted`, `more_evidence_required` (centralized in `claimEvidence.service.js`, never in controllers)
- **Audit (Phase 3):** every evidence mutation appends a `ClaimAudit` row — `evidence_presigned` / `evidence_completed` / `evidence_deleted` (actor `farmer`, `requestId` correlated); audit metadata never contains `s3Key`/bucket/owner fields
- **Complete (Phase 3):** atomic + idempotent — a compare-and-swap on `status` (`pending → processing`) guarantees exactly one record per upload (concurrent duplicate completes share one row), repeated completes return the stored metadata, and a not-yet-uploaded object leaves the record `pending` so the same presigned capability remains retryable

---

## 8. Collection: `claimassessment` (Deterministic Verification Result)

```js
{
  claimId:           ObjectId,     // ref LossClaim (unique)
  // Geometry + area
  approvedGeometry:  Object,       // GeoJSON (same as claimed or trimmed)
  approvedAreaAcres: Number,       // authoritative approved area
  // AI aggregate
  aiAggregate: {
    damageDetected: Boolean,
    damageType: String,
    severity: String,
    confidence: String,
    uncertain: Boolean,
    inconsistencies: [String],
    imageCount: Number
  },
  // Weather correlation
  weatherCorrelation: {
    eventMatch: Boolean,
    precipitationMm: Number,
    weatherCode: Number,
    source: String
  },
  // Deterministic rule outputs
  rules: {
    areaCheck: { passed: Boolean, remainingEligible: Number },
    overlapCheck: { passed: Boolean, overlapArea: Number },
    aiCheck: { passed: Boolean, reason: String },
    weatherCheck: { passed: Boolean, reason: String },
    eventTypeCheck: { passed: Boolean },
    timelinessCheck: { passed: Boolean }
  },
  // Final
  state: String,                   // mirrors claim.state
  approvedAreaAcres: Number,
  reason: String,                  // human-readable
  decidedAt: Date,
  decidedBy: "engine" | "admin",   // MVP: always "engine"
  adminNote: String,               // if admin override
  // Verification subdocument (E9-S5 / Phase 5)
  verification: {
    status:        "pending" | "verifying" | "completed" | "failed",
    version:       String,         // VERIFICATION_ENGINE_VERSION ("1")
    startedAt:     Date,
    completedAt:   Date,
    failedAt:      Date,
    error:         { stage: String, message: String }
  },
}, { timestamps: true }
```

### Phase 4 (E9-S4) — AI evidence assessment additions

The `claimassessment` collection became writable in Phase 4 for the **AI evidence-only stage**. The
lifetime, versioning, and per-image AI observations are stored here; the **decision fields remain
reserved (`null`)** until the deterministic verification engine (E9-S5) writes them.

```js
{
  claimId:           ObjectId,     // ref LossClaim (unique, 1:1) — one row per claim
  status:            "pending" | "processing" | "completed" | "failed",
  version:           String,       // asset AI contract version (CLAIM_LOSS_ASSESSMENT_VERSION, currently "1")
  model:             String,       // "provider/model" that produced the observations
  evidenceVersion:   String,       // sha1 of sorted "uploadId:updatedAt" — idempotency boundary
  aiImageAssessments: [{           // one entry PER stored evidence image
    evidenceId:      ObjectId,     // ref ClaimEvidence
    uploadId:        String,
    observation:     {
      cropDetected:              String | null,   // FROZEN contract (asset-09 §6.1 / ADR-019)
      damageDetected:            Boolean | null,
      damageType:                String | null,   // flood|storm|drought|fire|pest|disease|other
      severity:                  String | null,   // minor|moderate|severe (qualitative ONLY)
      visibleAffectedPortion:    String | null,   // qualitative text — NEVER converted to acreage (P4)
      confidence:                String | null,   // high|medium|low|unclear
      uncertain:                 Boolean,         // uncertainty is first-class
      inconsistencies:           [String],
      observations:              [String],
      imageQuality:              String | null    // good|fair|poor|unclear
    }
  }],
  startedAt:         Date,
  completedAt:       Date,
  failedAt:          Date,
  error:             { stage: "storage" | "provider", message: String },  // sanitized
  // ...all documented decision/rule/weather fields below remain null until E9-S3/S4/S5
}
```

- **AI aggregate is deterministic** (documented rules): `damageDetected` = any true / all false /
  null; `damageType`/`severity` = most frequent (severity tie → more severe); `confidence` = most
  conservative (`high > medium > low > unclear`); `uncertain` = any image uncertain OR unknown
  damage; `inconsistencies` = union of per-image notes + deterministic cross-image conflicts
  (different crop / conflicting damage / different damage type / different severity).
- **Idempotency + concurrency:** `proceed:false` reuse semantics — a `processing` in-flight or
  `completed`-with-same-`evidenceVersion` row is returned as-is (never re-run); changed evidence
  re-assesses on the same row (new version boundary). Only one worker ever owns the slot (unique
  `claimId` + atomic status CAS).
- **Guardrails:** only the frozen whitelist fields may be persisted per image (server-side scrub);
  acres/polygon/boundary/compensation/status remain structurally impossible to store. Audit rows
  `ai_completed` / `assessment_failed` (actor `"engine"`) carry no s3Key/bucket/owner/prompt/URL.
- No public endpoint exposes this stage (internal service only; §18).

### Phase 5 (E9-S5) — Deterministic Verification Engine

The deterministic engine now **writes the final decision fields** (`state`, `reason`, `decidedAt`,
`decidedBy`, `approvedGeometry`, `approvedAreaAcres`, `weatherCorrelation`, `rules`) and the
`verification` subdocument. The engine is a pure function (`evaluateClaimVerification`) with these
rules evaluated in strict precedence:

1. **timelinessCheck** — `eventDate` not future and within `CLAIM_WINDOW_DAYS` → `rejected`
2. **eventTypeCheck** — `eventType` ∈ frozen vocabulary (`flood, storm, drought, pest, disease, fire, other`) → `rejected`
3. **areaCheck** — `claimedAreaAcres ≤ parcelAreaAcres × (1 + CLAIM_AREA_OVERAGE_FRACTION)` → `out_of_limit`
4. **overlapCheck** — `overlaps_verified` → `duplicate_area`; `overlaps_in_flight` → `more_evidence_required`; **unchecked** (E9-S3 deferred to E9-S6) → passes with zero overlap, flagged `overlapUnchecked`
5. **weatherCheck** — **supporting only**; absence never blocks → always `passed: true`
6. **aiCheck** — confident no-damage (`damageDetected===false && uncertain===false && confidence∈{high,medium}`) → `rejected`; any insufficiency (`uncertain`, `null` damage, low confidence, cross-image inconsistency, poor quality) → `more_evidence_required`; otherwise `verified`

Outcome `verified` produces geometry-derived `approvedGeometry`/`approvedAreaAcres`. AI acres/polygon/compensation/output are **structurally ignored** (guardrail). Crop consistency is informational only. The `verification` subdocument records the engine version, timing, and any failure stage (`storage` | `provider` | `assessment` | `processing`). The claim state is advanced via the centralized state machine (`submitted → processing → <outcome>`) with append-only `ClaimAudit` entries (actor `"engine"`, `requestId` correlated, metadata `{evidenceVersion, imageCount, overlapEvaluated:false, engineVersion}`).

### Phase 6 integration note (Verification API — the same persisted decision is now served by `POST /claims/:claimId/verify`)

The **write path is unchanged** from Phase 5 — Phase 6 added no new persistence structure. The new thin endpoint invokes the same guarded orchestration (`verifyClaim`), which persists the decision exactly as above (`claimassessment` row + claim-state transition + audit). Idempotent requests reuse the persisted row (`verification.status: "completed"`, no overwrite, no duplicate audit); concurrent requests write exactly one decision via the atomic `submitted → processing` CAS; a retryable gate failure leaves `verification.status: "failed"` with a `verification_failed` audit until the internal assessment completes. `GET /claims/:id` surfaces the same row additively (`assessment.state/rules/approvedAreaAcres/…`); `GET /claims` keeps the original contract (`assessment: null` in the list).

---

## 9. Collection: `claimaudit` (Append-Only Claim Audit Trail)

```js
{
  claimId:       ObjectId,       // ref LossClaim (indexed)
  actor:         String,         // "farmer" | "engine" | "admin"
  action:        String,         // "created", "submitted", "ai_completed", "assessment_failed",
                                 // "verified", "evidence_presigned", "evidence_completed",
                                 // "evidence_deleted", "withdrawn", "resubmitted", etc.
  fromState:     String,
  toState:       String,
  reason:        String,
  metadata:      Object,         // flexible context
  requestId:     String,         // from requestLogger
  createdAt:     Date,
}
```

- **Indexes:** `{ claimId: 1, createdAt: 1 }`
- **Immutable:** never updated/deleted; append-only

---

## 10. Collection: `queries` (legacy / unused)

```js
{
  userId:        ObjectId,   // ref "User" — required
  sessionId:     String,     // optional grouping
  queryText:     String,     // required
  responseText:  String,     // AI answer
  attachments:   [String],   // image/file URLs
  location:      String,     // district or GPS
  contextId:     ObjectId,   // ref "Context"
  createdAt:     Date,
  updatedAt:     Date,
}
```

- **Indexes:** `{userId, createdAt: -1}`, `{userId, sessionId, createdAt: -1}`.
- **Status:** schema + controller CRUD exist (`/test/*`) but nothing in the chat flow uses it. Candidate for removal or revival as an audit/analytics store in Phase 1.

## 11. Collection: `contexts` (legacy / unused)

```js
{
  districtName:           String,   // UNIQUE — required
  soilType:               String,
  crops:                  [String], // major crops
  fertilizerRecommendations: [String],
  lat:                    Number,   // GPS matching
  lon:                    Number,
  season:                 String,   // Kharif/Rabi/Summer
  month:                  [String], // month-specific advice
  createdAt:              Date,
  updatedAt:              Date,
}
```

- **Indexes:** `districtName` (unique).
- **Status:** schema + CRUD exist, unused (legacy). Superseded by the `districts` reference collection shipped under **E2-S2**: server-side source of truth in `config/districts.js` (37 TN districts mirrored from the frontend `tamilnaduDistricts.ts`), seeded via `node scripts/seedDistricts.js` (deploy step), and read by the Context Engine for soil/region (`services/context.service.js`). Per-district soil/crop detail is **not fabricated**; the schema reserves those fields and D-19 backfills them from the TNAU soil table + published crop lists. The Context Engine degrades to `unknown` when a district is not in reference data.

---

## 12. ER diagram (today — including Phase 0 planned claim collections)

```mermaid
erDiagram
    USER ||--o{ CHATSESSION : "owns (cognitoSub, E1-S5)"
    USER ||--o{ QUERY : "owns (userId, legacy)"
    USER ||--o{ FARMPROFILE : "owns (cognitoSub)"
    USER ||--o{ LOSSCLAIM : "owns (cognitoSub)"
    CONTEXT ||--o{ QUERY : "referenced (contextId, legacy)"
    FARMPROFILE ||--o{ PARCEL : "contains"
    FARMPROFILE ||--o{ LOSSCLAIM : "has"
    PARCEL ||--o{ LOSSCLAIM : "claims on"
    LOSSCLAIM ||--o{ CLAIMEVIDENCE : "has"
    LOSSCLAIM ||--o| CLAIMASSESSMENT : "has"
    LOSSCLAIM ||--o{ CLAIMAUDIT : "audits"
    CHATSESSION {
        ObjectId _id PK
        string cognitoSub FK
        string userEmail
        string title
        array messages
        date createdAt
        date updatedAt
    }
    USER {
        ObjectId _id PK
        string cognitoSub UK
        string email UK
        string name
        string language
        date createdAt
    }
    FARMPROFILE {
        ObjectId _id PK
        string cognitoSub UK
        string userEmail
        string district
        array crops
        number acres
        string language
        array parcels
        date createdAt
        date updatedAt
    }
    PARCEL {
        string parcelId UK
        string name
        string crop
        object geometry
        number calculatedAreaAcres
        date createdAt
    }
    LOSSCLAIM {
        ObjectId _id PK
        string cognitoSub FK
        ObjectId profileId FK
        string parcelId
        string eventType
        date eventDate
        object claimedGeometry
        number claimedAreaAcres
        array evidence
        string state
        string idempotencyKey
        date submittedAt
    }
    CLAIMEVIDENCE {
        ObjectId _id PK
        ObjectId claimId FK
        string uploadId UK
        string s3Key
        string perceptualHash
        object aiAssessment
        date uploadedAt
    }
    CLAIMASSESSMENT {
        ObjectId _id PK
        ObjectId claimId FK UK
        object approvedGeometry
        number approvedAreaAcres
        object aiAggregate
        object weatherCorrelation
        object rules
        string state
        string reason
        string decidedBy
        date decidedAt
    }
    CLAIMAUDIT {
        ObjectId _id PK
        ObjectId claimId FK
        string actor
        string action
        string fromState
        string toState
        string reason
        string requestId
        date createdAt
    }
    QUERY {
        ObjectId _id PK
        ObjectId userId FK
        string sessionId
        string queryText
        string responseText
        array attachments
        string location
        ObjectId contextId FK
    }
    CONTEXT {
        ObjectId _id PK
        string districtName UK
        string soilType
        array crops
        array fertilizerRecommendations
        number lat
        number lon
        string season
        array month
    }
```

## 13. Target schema (Phase 1-2, planned — includes Agricultural Loss Claim)

```mermaid
erDiagram
    USER ||--o{ PROFILE : "has 1"
    USER ||--o{ CHATSESSION : "owns"
    USER ||--o{ FARMPROFILE : "owns (cognitoSub)"
    USER ||--o{ LOSSCLAIM : "owns (cognitoSub)"
    CHATSESSION ||--o{ MESSAGE : "contains (normalized)"
    FARMPROFILE ||--o{ PARCEL : "contains"
    FARMPROFILE ||--o{ LOSSCLAIM : "has"
    PARCEL ||--o{ LOSSCLAIM : "claims on"
    LOSSCLAIM ||--o{ CLAIMEVIDENCE : "has"
    LOSSCLAIM ||--o| CLAIMASSESSMENT : "has"
    LOSSCLAIM ||--o{ CLAIMAUDIT : "audits"
    USER ||--o{ FARM : "owns"
    FARM ||--o{ FARMMEMORY : "history"
    USER ||--o{ CONTEXTSNAPSHOT : "captures"
    PROFILE {
        ObjectId _id PK
        ObjectId userId FK
        string language
        string district
        array crops
        string phone
        string cognitoSub UK
    }
    FARMPROFILE {
        ObjectId _id PK
        string cognitoSub UK
        string userEmail
        string district
        array crops
        number acres
        string language
        array parcels
        date createdAt
    }
    PARCEL {
        string parcelId UK
        string name
        string crop
        object geometry
        number calculatedAreaAcres
        date createdAt
    }
    LOSSCLAIM {
        ObjectId _id PK
        string cognitoSub FK
        ObjectId profileId FK
        string parcelId
        string eventType
        date eventDate
        object claimedGeometry
        number claimedAreaAcres
        array evidence
        string state
        string idempotencyKey
        date submittedAt
    }
    CLAIMEVIDENCE {
        ObjectId _id PK
        ObjectId claimId FK
        string uploadId UK
        string s3Key
        string perceptualHash
        object aiAssessment
        date uploadedAt
    }
    CLAIMASSESSMENT {
        ObjectId _id PK
        ObjectId claimId FK UK
        object approvedGeometry
        number approvedAreaAcres
        object aiAggregate
        object weatherCorrelation
        object rules
        string state
        string reason
        string decidedBy
        date decidedAt
    }
    CLAIMAUDIT {
        ObjectId _id PK
        ObjectId claimId FK
        string actor
        string action
        string fromState
        string toState
        string reason
        string requestId
        date createdAt
    }
    FARM {
        ObjectId _id PK
        ObjectId userId FK
        string name
        number areaAcres
        string district
        string soilType
        array crops
        float lat
        float lon
    }
    FARMMEMORY {
        ObjectId _id PK
        ObjectId farmId FK
        string type
        date seasonStart
        date seasonEnd
        string crop
        array decisions
        array outcomes
        date createdAt
    }
    CONTEXTSNAPSHOT {
        ObjectId _id PK
        ObjectId userId FK
        ObjectId sessionId FK
        string district
        string soilType
        string season
        string weather
        array crops
        date capturedAt
    }
    CHATSESSION {
        ObjectId _id PK
        ObjectId userId FK
        ObjectId farmId FK
        string title
        date createdAt
        date updatedAt
    }
    MESSAGE {
        ObjectId _id PK
        ObjectId sessionId FK
        string sender
        string text
        object image
        object metadata
        date createdAt
    }
```

### Planned changes (rationale)
- **Immutable user identity:** `cognitoSub` (unique) added in E1-S3; keep `email` for display. **E1-S5 (ADR-018):** `chatsessions` and `profiles` scope ownership by `cognitoSub`; `userEmail` retained as a display/legacy dual-key. Prevents email-spoofing across all queries (security).
- **Normalize messages** into a `messages` collection (or TTL-capped archive) to avoid unbounded documents and enable pagination (F-28).
- **Farm profile collections** (`profiles`, `farms`) to power personalization (F-21) and the Context Engine (F-46).
- **Farm Memory collection** (`farmmemory`): season-by-season crop history, decisions, and outcomes — the core memory capability (F-47, ADR-016).
- **Context snapshots** (`contextsnapshots`): every answer records the assembled context it used (district, soil, season, weather, crops) for traceability + eval (APP-03, APP-12).
- **Reference data:** seed `districts` (38 TN districts from frontend config + lat/lon + soil) and `knowledge-content` (curated, sourced) into the DB; keep authoritative source-of-truth server-side for the Context Engine.
- **Analytics/audit:** revive a `queries`-like store with consent flags, or use structured logs + a metrics store, for cost/quality analytics (F-27).
- **Agricultural Loss Claim collections** (`lossclaims`, `claimevidence`, `claimassessment`, `claimaudit`): parcel-based affected-area claims with backend-authoritative geometry, AI evidence-only boundary, deterministic verification engine, and append-only audit trail (Phase 0 ADR).

## 14. Migration & maintenance rules

1. Every schema change ships with a **migration note** recorded in [18_DECISIONS.md](../decisions/18_DECISIONS.md) and this document.
2. Add indexes **before** data volume demands them; use compound indexes aligned to query patterns.
3. Do not embed unbounded arrays; cap embedded arrays (e.g., recent 50) and archive the rest.
4. Sensitive PII (phone, precise location) must be **encrypted at rest** and **never logged** (see [15_Security.md](../engineering/15_Security.md)).
5. `districts`/reference data is the single source of truth server-side; the frontend copy is display-only.
6. **FarmProfile parcels migration:** parcels array is additive; existing profiles without parcels remain valid but cannot create claims until parcel geometry is configured. NO fabricated geometry from district centroid, GPS, or inferred location.
7. **Claim collections are additive only:** new collections (`lossclaims`, `claimevidence`, `claimassessment`, `claimaudit`) — no existing collection modified. Rollback = drop new collections.
