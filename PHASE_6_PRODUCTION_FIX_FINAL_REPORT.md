# PHASE 6 — Production Fix: COMPLETE PERSISTED CHAT IMAGE RENDERING

**Status:** Implementation complete — all deterministic tests green.
**Scope:** This pass ONLY. No commits, no pushes, no deploys. Agricultural loss-claim Phase 1–5 and claim verification were NOT touched.

---

## 1. Original root cause (issue 1 — first pass)

`ChatSession` already persisted image turns (`models/ChatSession.js` message schema has `imageId` = the server-generated `uploadId` → `ImageRecord`; `services/chatImage.service.js` sets it on user turns; `GET /chatsessions/:id` returns it). The frontend bug was `toViewMessages` in `ChatInterface.tsx` dropping `imageId` during history reconstruction, so reloaded chats showed image turns as a bare/empty text bubble.

## 2. New root cause / fix for historical image rendering

Even with `imageId` preserved, a reloaded chat could NOT render the actual image: the API serves no binary and there was no authorized way to load the private S3 object — so the previous pass rendered a permanent "Photo attached" placeholder. **Fix:** the backend now mints an **authorized, short-lived signed GET URL on demand**, and the frontend resolves each persisted `imageId` to that URL and renders the actual image in the message bubble (loads/errors are controlled and bounded). The stable source of truth remains `imageId`; the signed URL is never persisted anywhere.

## 3. Exact backend files changed

| File | Change |
|---|---|
| `routes/upload.js` | Added `GET /:uploadId/view` (reuses `uploadParams` validation; GET reads are unmetered per existing GET convention). |
| `controllers/upload.controller.js` | Added `viewImage` handler (identity from `req.user`, never body/query). |
| `services/uploadPresign.service.js` | Added `createImageViewUrl({ uploadId, cognitoSub })` — owned-record lookup (404), pending/uploaded guard (400), `headObject` existence check (sanitized 404), mint signed GET URL. |
| `services/s3.service.js` | Added `getSignedGetUrl({ key, expiresInSeconds })` (real SIGv4 presign + deterministic `IMAGE_STORAGE_MODE=mock` stand-in). |
| `config/env.js` | Added `imageViewUrlTtlSeconds` (default 300 s; existing config pattern). |
| `.env.example` | Documented `IMAGE_VIEW_URL_TTL_SECONDS=300`. |
| `docs/architecture/08_API_Documentation.md`, `07_Database_Design.md`, `09_AI_Architecture.md` | Documented the endpoint, ownership/TTL/no-persist rules, and updated the D-23 note. |
| `t220-image-view-verify.mjs` | NEW — endpoint security + chat-history reconstruction suite. |

## 4. Exact frontend files changed

| File | Change |
|---|---|
| `src/api.ts` | Added `getChatImageUrl(uploadId)` → `GET /upload/:uploadId/view` (path-segment-encoded), typed `ChatImageView`. |
| `src/api/client.ts` | Unchanged (already attaches Bearer token to every request). |
| `src/components/PersistedChatImage.tsx` | NEW — resolves `imageId` → signed URL on mount, renders `<img>`, bounded loading/error states (single request, no retry loop, `onError` collapse). |
| `src/components/MessageBubble.tsx` | Replaced the permanent placeholder with `PersistedChatImage` (shared attachment area with the live `previewUrl` path). |
| `src/i18n.ts` | Added `imageUnavailable` (en/ta); `photoAttached` retained as the loading chip. |
| `src/types.ts` | Updated `Message.imageId` comment (served via authorized on-demand URL now). |
| `src/api/imageView.test.ts` | NEW — 6 tests (URL shape, auth header, encoding, 404/401/network mapping). |

## 5. Image retrieval endpoint

`GET /upload/:uploadId/view` (authenticated). Returns exactly `{ uploadId, mediaType, signedUrl, expiresIn }`. No limiter added (GET reads match the existing `/chatsessions/:id` and `/weather` convention).

## 6. Authorization / ownership behavior

Lookup is `ImageRecord.findOne({ uploadId, cognitoSub })` — a foreign or unknown id returns `404 Image upload not found`, indistinguishable from a non-existent upload (same E3 convention as `POST /chat`; no existence disclosure). Pending/uploaded (not yet completed) records → `400 Image has not been uploaded yet`. A record whose private object was removed → sanitized `404 Image not found` (no key/bucket details).

## 7. Signed URL behavior

Short-lived (`IMAGE_VIEW_URL_TTL_SECONDS`, default 300 s), minted on demand per history reconstruction, single-object GET-only, **never persisted** (not in Mongo — verified by test — and never in browser storage; the frontend holds it only in component state). The mock seam returns a deterministic stand-in; real mode uses the existing `@aws-sdk/s3-request-presigner` client.

## 8. S3 remains private

No bucket policy/ACL change; objects stay private. The only capability issued is a scoped presigned GET for one owned key.

## 9. No S3 keys / credentials exposed

Responses never contain the `s3Key` field, bucket configuration, region, or credentials. (Note: any presigned URL embeds the object key and the S3 virtual-host bucket endpoint inside the URL itself — that is how AWS presigning works and is the same for the existing presigned PUT upload transport.)

## 10. Current-turn image behavior

Unchanged and never slower: local `previewUrl` renders instantly after selection; the upload→analyze→reply flow is untouched (`MessageBubble` `previewUrl` block).

## 11. Reloaded-history image behavior

History loads an image turn with `imageId` → `PersistedChatImage` fetches the authorized signed URL → the actual image renders (loading chip while resolving).

## 12. Navigation-away-and-return behavior

Each history load reproduces step 11 from the same stable `imageId`; a fresh signed URL is minted every time (expired URLs are never reused because none persist).

## 13. Multiple image behavior

Each persisted `imageId` resolves independently (verified server-side for two image messages in one session in `t220`); image+text and image-only turns both render image + text.

## 14. Crop-recommendation fix remains intact

Untouched. `t220` section C re-asserts `selectTemplate` routing → `CROP_RECOMMENDATION` (EN + TA); `t219` (49/0) re-confirms template, soil-optional system guidance, and `renderContextBlock` rendering.

## 15. Backend test results (deterministic suites)

| Suite | Result |
|---|---|
| **t220-image-view-verify (NEW)** | **54/0** — security matrix + persistence-proof + history reconstruction + no-regression |
| t219-production-fixes-verify | 49/0 |
| t218-ux-verify | 66/0 |
| t217-s3fail-verify | 4/0 |
| t216-verify | 71/0 |
| t214-verify | 70/0 |
| t213-verify | 61/0 |
| t212-verify | 59/0 |
| t211-verify | 52/0 |
| t210-verify / t209 / t208 / t207 / t206 / t205 / t204 / t203 / t202 / t201 | 24/0 · 24/0 · 24/0 · 18/0 · 29/0 · 17/0 · 31/0 · 25/0 · 116/0 · 21/0 |

`t111-verify.mjs` is a legacy pre-auth-era suite (old `userEmail` body contract → 401 today): pre-existing, unrelated.
`t215-verify.mjs` (live provider E2E) failed today **only** on Google Gemini free-tier quota (`429 … Quota exceeded … limit: 20`) — environmental, no code change; not part of the deterministic set.

## 16. Frontend test results

`npm test` → **43/0** across 4 files (sessionMessages 6, imageView 6 NEW, turn 15, imageValidation 16).

## 17. Typecheck

`npm run typecheck` → clean (`tsc --noEmit`).

## 18. Build

`npm run build` → clean (`vite build`, 1522 modules; only the pre-existing `browserslist` out-of-date notice).

## 19. Lint

`npm run lint` → only the pre-existing findings, untouched: `VoiceRecorder.tsx:54` (error, `no-unused-expressions`), `AuthContext.tsx:33` (warning, fast-refresh).

## 20. Genuinely remaining issues

- TTL refresh for a long-open chat is deliberately bounded: if a signed URL expires mid-display and the `<img>` errors, the bubble collapses to a controlled "Image unavailable" chip (no retry loop) — the next history reload mints a fresh URL.
- Binary streaming through the backend vs. signed URL: not implemented — signed GET URLs match the approved transport.
- D-23 retention/lifecycle (dedicated bucket + 90-day lifecycle) remains a product decision, unchanged.
- Component-level render tests were not added (vitest runs in a node environment, no jsdom) — the resolution layer is covered by `imageView.test.ts` + `sessionMessages.test.ts`; the bubble render compiles via typecheck/build.
- Live Gemini E2E (`t215`) currently blocked by Google free-tier quota (external).

## 21. READY FOR REVIEW: YES

Nothing was committed, pushed, deployed, or written as claim Phase 6. Files above are the complete diff surface for review.