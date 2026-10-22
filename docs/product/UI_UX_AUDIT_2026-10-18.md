# UI/UX Audit & Enhancement Plan — Vivasayi AI Frontend

> **Metadata**
> - **Title:** UI/UX Audit & Enhancement Plan — Vivasayi AI Frontend
> - **Version:** 1.0
> - **Status:** `[COMPLETE]` — approved roadmap fully executed. Steps 1–8 (UX-11, UX-12, UX-04, UX-09, D1, UX-03, UX-08, UX-05, UX-13, UX-06, D4, UX-07, UX-01, UX-02, UX-10, UX-15, UX-17, UX-18, UX-14 partial, D5, App.tsx loading splash) implemented and verified; see "Implementation log" below. UX-19 intentionally deferred.
> - **Owner:** Design / Frontend
> - **Last Reviewed:** 2026-10-18
> - **Related Documents:** [11_UI_UX_Guidelines](11_UI_UX_Guidelines.md) · [12_Technical_Guidelines](../engineering/12_Technical_Guidelines.md) · [FRONTEND_CONTRACT_2026-10](../architecture/FRONTEND_CONTRACT_2026-10.md) · [PROGRESS_CONTRACT_v1](../architecture/PROGRESS_CONTRACT_v1.md) · [18_DECISIONS](../decisions/18_DECISIONS.md)

> **Why this document exists:** The screenshot review surfaced ten perceived problems (A–J) in the Vivasayi AI frontend. This audit verifies each against the actual codebase, records root causes with file:line evidence, distinguishes verified causes from hypotheses, and defines a phased, regression-safe enhancement plan. **Enhancement, not redesign**: every existing feature, route, workflow, API contract, and the established green agricultural identity is preserved. No code has been changed as part of this document.

**Frontend repository:** `tn-farming-assistant-frontend` (Vite + React 19 + TypeScript strict + Tailwind + Vitest + Playwright).

---

## A. Current-state inventory

### A.1 Stack and architecture

| Area | Actual state |
|---|---|
| Build | Vite 7, React 19, TypeScript strict (`tsc --noEmit`), Tailwind 3 (`tailwind.config.js`) |
| Routing | Hash router (`src/routing/hashRoute.ts`, `useHashRoute.ts`). Sections: `chat` (default), `claims`, `admin`. Claims sub-routes: `#/claims`, `#/claims/new`, `#/claims/:id` (id pattern `[A-Za-z0-9_-]{1,64}`). Unknown hashes are replaced with the default route (`App.tsx:63-65`). Cognito round-trip preserves target via `sessionStorage` `vivasayi.nav:returnTo` |
| App shell | `App.tsx:191` — `flex h-dvh flex-col overflow-hidden`: `Navbar` (in-flow, `shrink-0`) → `WeatherPanel` (in-flow, `shrink-0`, hidden on `#/admin`) → workspace row `relative flex min-h-0 flex-1 overflow-hidden` (`App.tsx:213`) containing `ChatSidebar` + `ChatInterface` (chat), `ClaimsPage` (claims), or `AdminReviewPage` (admin). Profile error bar, onboarding overlay, farm-profile and parcel modals, and the Sonner `Toaster` are layered at the bottom |
| Auth | `AuthContext` (Cognito OAuth). Google sign-in; session token in `sessionStorage` `vivasayi.auth:accessToken`; 401 flips the app back to the landing page |
| i18n | `react-i18next`; dictionaries `src/i18n.ts` (core, en/ta) + `src/locales/v2.en.ts` / `v2.ta.ts` (spread in). `src/i18n.test.ts` enforces en/ta key parity |
| Icons | `lucide-react` throughout (emoji used in three legacy spots — see UX-18) |
| Toasts | Sonner, top-right, 3s (`App.tsx:298-304`) |

### A.2 Routes and pages (complete)

| Route | Screen | Components |
|---|---|---|
| unauthenticated (any) | Public landing / Google sign-in | `LoginScreen.tsx` (two-panel: brand + context + tips + features left, sign-in card right) |
| `#/chat` (default) | Assistant workspace | `ChatSidebar.tsx` + `ChatInterface.tsx` (+ `MessageBubble`, `VoiceRecorder`, `PersistedChatImage`, `DiagnosisCard`) |
| `#/claims` | Claims list | `ClaimsPage.tsx` → `ClaimsList` (lines 164–278) |
| `#/claims/new` | Claim submission wizard | `ClaimWizard.tsx` + `claims/wizard/*` (Event, Parcel, Evidence, Relationship, Review steps; sticky footer; draft persistence) |
| `#/claims/:id` | Claim detail / tracker | `claims/ClaimTracker.tsx` (+ `TrackerHeader`, `ProgressStages`, `SatelliteCard`, `EvidenceSummary`, `ActionRequiredCallouts`, evidence gallery, ownership documents, appeal panel) |
| `#/admin` (role-gated) | Reviewer workflow | `AdminReviewPage.tsx` (1204 lines: dashboard, queue, investigation, detail, override modal) |
| Overlays (not routes) | `ProfileOnboarding`, `FarmProfileEditor`, `ManageParcels` (+ parcel draw map, location search), image viewer dialog, delete-chat dialog, claim confirm dialogs (`ConfirmDialog`) |

### A.3 Design tokens and styling conventions (existing — to be reused, never replaced)

- `tailwind.config.js:19-58` — semantic tokens: `brand` (= emerald palette), `ink` (DEFAULT/muted/subtle), `surface` (DEFAULT/muted/sunken/border), `success`/`warning`/`danger`/`info`/`quiet` (each with fg/bg/border/solid), `rounded-control`/`rounded-card`, `text-2xs`, `shadow-card`, Tamil-capable `sans` stack.
- `src/index.css` — global `:focus-visible` ring (brand-700 on light, white on `data-surface="dark"`), `prefers-reduced-motion` handling, iOS 16px input rule, safe-area padding, thin scrollbars.
- `src/components/ui/` — `Button`, `Alert`, `Card` (+Header/Title/Body), `ConfirmDialog` (proper focus trap + Esc), `EmptyState`, `Skeleton`, `StatusPill`, `Badge`, `Stepper`, `tones.ts` (tone → token-class map). `tokens.test.ts` pins contrast-critical pairs; `ui.test.tsx` pins primitive behavior.
- `src/test/static.test.ts` — design-system ratchet: bans the `from-emerald-600 to-green-700` gradient, `window.confirm`, ad-hoc 10/11px type in claim files, progress bars/percentages on farmer claim screens, hard-coded English `aria-label`/`title`/`alt` in four cleaned-up files (MessageBubble, ManageParcels, FarmProfileEditor, ProfileOnboarding — **not** AdminReviewPage), and device place-names on Navbar/LoginScreen.

**Token adoption is only partial.** `MessageBubble`, `Navbar`, `ClaimWizard`, `ClaimTracker` children and `ClaimsPage` use tokens; `ChatInterface`, `ChatSidebar`, `LoginScreen`, `ProfileOnboarding`, `FarmProfileEditor`, `ManageParcels`, `AdminReviewPage` (82 raw-palette matches), `VoiceRecorder`, `ClaimAppealPanel`, `ClaimOwnershipDocuments` still hard-code `emerald/red/amber/gray/green` utilities (details in UX-11).

### A.4 Existing interactions and capabilities (all must survive)

See the full checklist in section E. High level: Google sign-in/out; chat create/select/history/delete/clear-all; text + image + voice input; parcel selector; Tamil/English switching; farm profile create/edit; parcel management with map; weather (farm-district default, opt-in device source, retry/fallback); claims create → evidence → submit → tracker (progress polling, satellite supporting card, evidence gallery, ownership documents, withdraw/resubmit/appeal); admin review (role-gated); toasts; onboarding skip/resume.

### A.5 Existing responsive behavior

- Sidebar: `absolute` drawer (`w-72`) below `lg`, `static` rail (`w-64`) at `lg`+ (`ChatSidebar.tsx:167-178`), dark overlay below `lg`.
- Claims cards: `useClaimsViewport()` (`utils/claimResponsive.ts`) — 1 col <640, 2 cols ≥640, 3 cols ≥1024; parcel/crop row hidden on compact. Pinned by `claimResponsive.test.ts` (mandatory 360…1440 matrix).
- Claim wizard: `stepIndicator`/`reviewStacked` from the same utility.
- Navbar: section-toggle labels become `sr-only` below `sm`; language pills show short codes.
- Documented verification width: **360px** (`11_UI_UX_Guidelines.md` §7).

### A.6 Test and screenshot infrastructure (baseline established 2026-10-18)

| Check | Command | Baseline result |
|---|---|---|
| Unit + component | `npm run test` (Vitest: node `*.test.ts` + jsdom `*.test.tsx`) | **53 files, 726 tests — all passing** (38.9s) |
| Type check | `npm run typecheck` | **Clean** |
| Lint | `npm run lint` | **0 errors**, 2 pre-existing `react-refresh/only-export-components` warnings (ClaimStatusCard.tsx:30, AuthContext.tsx:69) |
| Contract sync | `npm run contract:check` | available (backend schema sync) |
| E2E | `npm run e2e` (Playwright, hermetic per ADR-024; 15 specs; desktop + mobile chromium; ~22 min; requires backend harness) | not run in this audit; must be run per implementation step |

Key suites constraining UI changes: `App.routing.test.tsx` (shell + farm-chip states), `App.claimsRoute.test.tsx`, `LoginScreen.test.tsx` (LOC-11: farm-first landing, no device place, no location prompt), `Navbar.test.tsx`, `WeatherPanel.test.tsx` (LOC-12 matrix incl. outside-TN), `ClaimsPage.test.tsx`, `claims/ClaimTracker.test.tsx` (TRK-1…16, pins Playwright selector contract), `ClaimWizard.test.tsx`, `static.test.ts` (ratchets), `ui.test.tsx`, `i18n.test.ts` (en/ta parity). E2E selector contracts live in `e2e/pages/*.ts` and spec-level `data-testid` assertions (e.g. `weather-panel`, `weather-device-note`, `claim-tracker`, `tracker-satellite`, `claim-action`).

---

## B. Findings

Severity: **Critical** = broken/inaccessible capability or misleading information; **High** = strong negative effect on core flows or accessibility; **Medium** = coherence/usability debt; **Low** = polish.
"Root cause" is marked **VERIFIED** (confirmed in code) or **HYPOTHESIS** (needs browser confirmation).

### UX-01 — Landing page feels like a different product than the app (Issue A)

- **Page/component:** `src/components/LoginScreen.tsx` (whole file).
- **Observed:** The landing uses the raw emerald palette and different surface conventions from the authenticated shell: logo tile `bg-gradient-to-br from-emerald-500 to-green-700` (line 51), `text-emerald-950` headings (55, 60), cards `border-emerald-100` with `shadow-sm` (68, 77, 104) instead of `rounded-card border-surface-border shadow-card`, and the page background `bg-emerald-50/60` (44). The authenticated app uses a `brand-900` header, `ink`/`surface` tokens and `shadow-card`. Only 8 token uses vs 12 raw-palette uses in the file.
- **Root cause:** **VERIFIED** — the landing predates the token system and was never migrated; there is no shared header between the public and authenticated experiences, so the visual hand-off at sign-in is abrupt.
- **User impact:** The farmer cannot tell that sign-in leads to the same product; the green identity reads as two dialects of green.
- **Severity:** High.
- **Proposed correction:** Token-only restyle of LoginScreen (keep the two-panel structure, copy keys, Google button and farm-first card content). Reuse the same logo treatment, typography hierarchy, card and border conventions as the shell. Add a slim public top bar using the same `brand-900` brand block as `Navbar` (brand + name + kicker only — no authenticated controls) so the post-login header is visually continuous. No new color, logo, or type system.
- **Dependencies:** Step 1 (token conventions).
- **Regression risks:** `LoginScreen.test.tsx` LOC-11 pins exact strings ("Weather and advice for your farm"), absence of device place / "Outside Tamil Nadu", no location prompt, `role=alert` present, Google button `type=button` — restyle must not alter these. `static.test.ts:192-197` bans device place-names here.
- **Verification:** Vitest LoginScreen + static suites; browser check at 360/768/1440 before/after; en + ta.

### UX-02 — Landing location context is present but not prominent or actionable (Issue B)

- **Page/component:** `LoginScreen.tsx:66-81` (context card); copy keys `landingContextTitle`, `landingFarmFirstTitle/Body`, `signInForWeather` (`i18n.ts:106-110`).
- **Observed:** Pre-login the app has **no** farm-profile access (GET /profile requires auth) and device location is never requested (`autoRequest={false}`, `App.tsx:176`; LOC-11 test pins this). The context card therefore explains the farm-district model in words plus "Sign in to see live weather and farming insight." Signed-in context is delivered by the shell itself: navbar farm chip (`Navbar.tsx:71-90`) and the weather strip.
- **Root cause:** **VERIFIED** — there is no data source pre-login that could honestly show "Farm district: Chennai"; the "farm-first" copy is already correct and honest. The gap is presentation: the context card is small, sits below the hero, and the sign-in CTA is visually detached from it (login card is a separate panel ordered first on mobile).
- **User impact:** The farmer cannot see at a glance why location matters or what they will get after signing in.
- **Severity:** Medium.
- **Proposed correction:** Strengthen the existing context card hierarchy (clearer "why location matters" framing, better association with the sign-in action) using existing copy keys where sufficient; add new i18n keys (en + ta) only where wording is genuinely missing. **Do not** fetch profile or request device location pre-login, and **do not** display any device place name (ratchet `static.test.ts:192-197`). Signed-in users keep the existing farm-district chip + weather strip as their location summary.
- **Dependencies:** Step 1 (tokens), Step 8 (landing pass).
- **Regression risks:** LOC-11 assertions; Tamil rendering.
- **Verification:** LoginScreen tests; browser at 360/1440 en/ta.

### UX-03 — Weather banner occupies too much vertical space and cannot be collapsed (Issue C)

- **Page/component:** `src/components/WeatherPanel.tsx` (329-361 shell; source-state rows 133-222; weather body 234-342).
- **Observed:** The strip is always fully expanded, `shrink-0` (`App.tsx:204-210`), and contains (a) a source/location row, (b) current temperature (up to `text-4xl`), (c) up to three+ forecast cards ~72-84px tall in a horizontal scroller, (d) a farming-insight line. Worst case (device-outside-TN + farm district, mobile) ≈ 260-310px — over a third of a 780px viewport. **There is no collapse/hide/expand mechanism anywhere** (grep over `src/**` for collapse|dismiss|expand|aria-expanded in this component: zero hits — VERIFIED).
- **Root cause:** **VERIFIED** — the strip was designed as an always-on "farm-first" surface (plan B6) with no density affordance; `shrink-0` + full forecast row + insight line stack vertically below `lg`.
- **User impact:** The assistant workspace and claims content are pushed down permanently; on phones the strip dominates the viewport.
- **Severity:** High.
- **Proposed correction:**
  1. Add an accessible collapse toggle (button with `aria-expanded`, chevron icon, `t()`-labeled) on the strip header row. Persist the preference in `localStorage` as `vivasayi.weatherCollapsed.v1` following the exact `useWeatherSource` pattern (`useWeatherSource.ts:10-28`: versioned key, try/catch, per-device — **not** cross-account or cross-device).
  2. Collapsed state = a single compact row (~36-44px): active district + current temperature (when data exists) + expand control. **Location warnings (outside-TN / denied / no-farm-district) and weather-fetch errors must remain visible even when collapsed** — collapse hides forecasts and the insight, never the warning or the active-location label. The `weather-device-note` test id and its content stay rendered in the collapsed state when relevant.
  3. Tighten the expanded layout (smaller temp type on mobile, insight folded into the source row where possible) without removing any information.
  4. Keep the strip below the navbar and `shrink-0` in both states; do not overlay content.
- **Dependencies:** Step 1; interacts with UX-08 (copy restructure in the same file — do them in the same step to avoid churn).
- **Regression risks:** `WeatherPanel.test.tsx` (6 tests: LOC-12 source matrix, device-note testid, 8 claim-free message keys, denied+no-farm CTA, persistence of weather source); `App.routing.test.tsx:160-185` asserts the farm-district line renders/during profile load states — collapsed-state markup must keep that text in the DOM (use height/visibility, not unmount, for the duplicated district label, or render it in the compact row). E2E selector `weather-panel` / `weather-device-note` must keep working.
- **Verification:** new component tests (see F); weather E2E if extended; browser 360/1440 with collapse/expand + reload persistence; keyboard-only toggle.

### UX-04 — Chat sidebar / workspace feel unbalanced; sidebar reads as floating content (Issue D)

- **Page/component:** Shell `App.tsx:191-250`; `ChatSidebar.tsx:159-178`; `ChatInterface.tsx:358-465`; `Navbar.tsx:60`; `WeatherPanel.tsx:350`.
- **Observed (verified chain):**
  1. At `lg`+ the sidebar **is** correctly left-anchored: `static` flex child of the full-bleed workspace row (`App.tsx:213`, `ChatSidebar.tsx:170` `lg:static lg:w-64`). There is **no** `max-w`/`mx-auto` ancestor centering it (VERIFIED — "accidentally centered by a shared container" is ruled out).
  2. The sidebar background is `bg-gray-50` (`ChatSidebar.tsx:171`) — **identical** to the chat body background (`ChatInterface.tsx:358`), separated only by a 1px border, so the two regions visually merge into one continuous field instead of "chrome + workspace".
  3. Competing center axes: navbar and weather content center to the **viewport** (`mx-auto max-w-6xl`, `Navbar.tsx:60`, `WeatherPanel.tsx:350`), while the conversation column and composer center to the **chat pane** (`mx-auto max-w-3xl`, `ChatInterface.tsx:379,465`) — pane center = sidebar offset + remaining/2, i.e. up to 128px right of the chrome axis at 1920px.
  4. Inside the pane, the workspace header is full-bleed with only `px-3 sm:px-4` (`ChatInterface.tsx:360`) — no `max-w-3xl` wrapper — so the title hugs the pane's left edge while messages/composer sit on the centered column; the two left edges never align.
- **Root cause:** **VERIFIED** (items 2-4 are code facts; their perceptual weight is **HYPOTHESIS** pending browser confirmation in Step 0).
- **User impact:** The interface reads as "content floating in the middle", not an application shell with a real sidebar; the chat header appears misaligned with the conversation.
- **Severity:** High.
- **Proposed correction (visual + layout only; all chat behavior untouched):**
  1. Make the sidebar read as chrome: `bg-white` + `border-surface-border` rail against the `surface-muted` chat pane (or the inverse, decided in browser) — a surface change only.
  2. Align the chat header with the conversation column: keep the full-width `border-b` band but give its inner content the same gutters/max-width as the message column, so header, messages and composer share one axis.
  3. Decision **D1** (needs approval, see §B end): unify shell gutters by removing `mx-auto max-w-6xl` from `Navbar` and `WeatherPanel` inner containers (full-bleed header with `px-3 sm:px-4` gutters matching the workspace) **or** keep the centered chrome. Recommendation: full-bleed, so the whole shell shares one grid; purely visual and reversible.
  4. Decision **D2**: conversation column width — keep `max-w-3xl` (readable bubbles ≤~80 chars) or move to the documented `max-w-4xl` (`11_UI_UX_Guidelines.md` §4). Recommendation: keep `max-w-3xl` for bubble readability; record the deviation from the guideline in this document rather than widening.
  5. Keep the mobile drawer exactly as it behaves today (overlay, auto-close points, widths); fix the stale comment at `ChatSidebar.tsx:166` ("slides under the navbar" — it cannot, the row is `overflow-hidden`).
- **Dependencies:** Step 1 (token classes used by the surface change).
- **Regression risks:** `e2e/responsive.spec.ts` asserts header controls named + white focus ring on the dark header + no horizontal overflow — do not change `data-surface="dark"` or control names. `Navbar.test.tsx` may pin structure; verify before editing. Sidebar scroll independence and composer pinning are already correct (`overflow-hidden` chain) — changes must not touch the `min-h-0` flex chain.
- **Verification:** browser at 1024/1440/1920 (chat empty + active conversation): header/column axis alignment measured visually; sidebar rail distinct; mobile drawer open/select/close; full unit suite.

### UX-05 — Assistant welcome state is plain; vertical balance is weak (Issue E)

- **Page/component:** `ChatInterface.tsx:388-426` (welcome), 358-386 (header/scroller), 464-567 (composer), `MessageBubble.tsx`.
- **Observed:** The welcome block is top-aligned in the scroller (`pt-10 sm:pt-16`, line 389), not vertically centered in the available pane, so the screen reads top-heavy with dead space below the suggestion pills. Logo tile, greeting (`goodMorning/Afternoon/Evening` with `displayName` = `user.name` → email local-part fallback, lines 346-353), `askVivasayi` subline, optional place chip (only when geolocation granted), and four suggestion pills as a wrapped flex row (`max-w-xl`, line 413). The composer is correctly pinned; the header is full-bleed (see UX-04). Loading copy for history reuse is `t('processing')` (line 431) — semantically wrong for a session fetch. Text-send failure appends a **hard-coded English** bubble `'Server error. Please try again.'` (line 320) although the `serverError` key exists (`i18n.ts:165` en / `:983` ta).
- **Root cause:** **VERIFIED** — the welcome block was written as a simple stack; no centering container, no hierarchy pass. i18n gaps as noted.
- **User impact:** The empty assistant screen feels like a placeholder; Tamil users see English on send failures; the drawer heading on mobile renders the raw key **"chats"** (see UX-12).
- **Severity:** Medium (High for the i18n defects, tracked as UX-13/UX-12).
- **Proposed correction:** Center the welcome state in the pane (`min-h-full` flex centering inside the scroller, composer still pinned), refine hierarchy (greeting → subline → context chip → suggestions), restyle suggestion pills with existing tokens and slightly stronger affordance (keep the same four keys `cropSuggestions/pestControl/fertilizerQuestion/weather` and the click-fills-input behavior), align header/column axes per UX-04. Fix the history loader copy (new key `loadingChatHistory`, en+ta). Fix the error bubble to `t('serverError')`. Keep `displayName` logic (name preferred; email local-part fallback — never the raw email address, which is already the case).
- **Dependencies:** Step 4 (assistant workspace), UX-04/UX-12/UX-13.
- **Regression risks:** none known for the welcome block (no test pins it); the error-bubble change is covered by adding a unit assertion; ensure `messagesEndRef` auto-scroll still fires (welcome block removal from the flow when messages arrive must not break scrolling).
- **Verification:** new unit tests (welcome centering classes, error bubble uses i18n key); browser empty-state at 360/768/1440 en/ta.

### UX-06 — Claims list is sparse and under-designed (Issue F)

- **Page/component:** `ClaimsPage.tsx:164-278` (`ClaimsList`).
- **Observed:** Container `mx-auto max-w-4xl` (line 211) — narrower than the claim detail page (`max-w-5xl`, `ClaimTracker.tsx:206`), so list and detail jump in width. Header is a single title row + File-a-Claim button (212-218) with no supporting copy. Cards (246-272) show: event type, state badge, event date, claimed area, parcel/crop (hidden <640), filed date, evidence count. **No next-step line** (VERIFIED: `ClaimCardViewModel` in `utils/claimFlow.ts` has no next-step field, and no card renders one). Grid: 1 col <640 → 2 ≥640 → 3 ≥1024 (`claimResponsive.ts`). Loading is a centered spinner; empty uses `EmptyState`; error uses warning `Alert` + retry — all present.
- **Root cause:** **VERIFIED** — narrow container + minimal header + thin card rows leave the page under-filled on desktop; the grid logic itself is sound and test-pinned.
- **User impact:** Hard to scan; the page wastes width; status is the only strong signal.
- **Severity:** Medium.
- **Proposed correction:**
  1. Widen the list container to `max-w-5xl` to match the detail page (one page width for the claims section).
  2. Strengthen the header: title + existing supporting copy (new i18n key if needed, en+ta) + action; consistent `pt` with other pages.
  3. Rebalance card anatomy: clearer internal spacing, status badge prominence, consistent meta rows; keep every existing field and the compact hiding rule.
  4. Next-step hints: **only if derived from existing workflow state** — e.g. for `draft` claims show the existing "continue/submit" affordance already used by the wizard/tracker, for `more_evidence_required` the existing "add evidence" phrasing. No invented statuses, no fake metrics/counts/success rates. If no existing vocabulary fits, defer (see decision **D4**).
- **Dependencies:** Step 5.
- **Regression risks:** `ClaimsPage.test.tsx` (576 lines) asserts submit gates, backend-authoritative areas, held checklist, routing; card field assertions may exist — check before reordering DOM. `claimResponsive` matrix is untouchable.
- **Verification:** unit suite; browser 360/640/1024/1440 with 0/1/N claims (fixture-driven); en/ta.

### UX-07 — Claim details need stronger information hierarchy (Issue G)

- **Page/component:** `claims/ClaimTracker.tsx` (425 lines) + children.
- **Observed:** Structure (verified): back button + `t('claimDetailsTitle')` heading (212-217) → `TrackerHeader` (overall status pill, reference + copy, event, submitted/last-updated/checked, offline/refresh-error banners) → legacy note → optional decision card → `grid gap-3 lg:grid-cols-5` (left 3: `ProgressStages` + facts; right 2: `SatelliteCard` + `EvidenceSummary`) → held-details `<details>` → gallery → ownership documents → appeal panel → dialogs. Container `max-w-5xl`. Satellite card truthfully shows supporting-only status (badge `satelliteSupportingBadge`, note `satelliteSupportingNote` — `SatelliteCard.tsx:56-62,112-116`), never success/danger toned.
- **Root cause:** **VERIFIED** — the page is functional and contract-correct but flat: the title row is plain, sections use uniform `space-y-3` with no grouping, and the status/ref/date facts sit in a `dl` that does not read as the page's primary summary. Not a data problem — a hierarchy problem.
- **User impact:** The farmer must read the whole page to understand "what is my claim's state and what do I do next".
- **Severity:** Medium.
- **Proposed correction (presentation only):**
  1. Stronger page header: back affordance + claim title built from existing fields (event type label + formatted event date) + reference + overall status pill in the header band; keep `data-testid`/`data-claim-id`/`data-overall-status` attributes exactly.
  2. Group sections into visually distinct blocks (consistent card spacing rhythm `space-y-4` between groups, `space-y-3` within); keep the 5-column grid split and stacking below `lg`.
  3. Keep every control, explanation, warning, upload, review state, dialog, and the supporting-only satellite language verbatim.
- **Dependencies:** Step 6.
- **Regression risks:** `claims/ClaimTracker.test.tsx` (TRK-1…16) pins header content, stage order, satellite rendering, decision card, dialogs, Tamil rendering, and the Playwright selector contract (`claim-tracker`, `tracker-stage`, `tracker-satellite`, `tracker-last-updated`, `tracker-refresh-error`, `decision-card`, `claim-action`). Any DOM reorder must keep these queries working.
- **Verification:** ClaimTracker + ClaimsPage suites; e2e `refresh-reopen`, `satellite-weather`, `no-fake-progress`, `decision-consistency`; browser at 360/768/1440 on a draft, a submitted, and a decided claim.

### UX-08 — Location messaging is redundant and can confuse device vs farm vs active (Issue H)

- **Page/component:** `WeatherPanel.tsx:155-191` (device-failure state); keys `weatherDeviceOutsideTn*` (`locales/v2.en.ts:36-41`, `v2.ta.ts:34-39`).
- **Observed:** The system already distinguishes the three concepts correctly in code: device location (`useLocation`), farm district (profile), active query district (`queryDistrict = deviceReady ? deviceDistrict : farmDistrict`, line 65), and `data-weather-source` honestly reports `farm` when the device is unusable (line 348). The copy is accurate but the **layout stacks three redundant statements**: (1) the outside-TN note ("…we are showing your farm district instead"), (2) a second row "Weather for your farm district: Chennai", (3) a "Use farm district (Chennai)" button that re-persists the already-active source, plus a Retry that deterministically fails for a cross-border user.
- **Root cause:** **VERIFIED** — the state was grown by cases (outside-TN / denied / unavailable × farm/no-farm) without consolidating the presentation; each case appends rows.
- **User impact:** Reads as three different location systems; the user cannot tell which location is active; the strip is tallest exactly when something went wrong.
- **Severity:** Medium.
- **Proposed correction:**
  1. Single concise note that names the **active farm district dynamically**: e.g. "Your device is outside Tamil Nadu. Weather is currently shown for your farm district, Chennai." — implemented via updated i18n key interpolation (district parameter), en + ta, never hardcoded. Apply the same consolidation to denied/unavailable variants.
  2. One active-location line (the existing `weatherForFarm`/`weatherNearYou` label) + controls on a single wrap row; remove only duplicated prose, never controls or semantics.
  3. Keep: Retry, "Use farm district (district)" (relabel to "Use farm location ({{district}})" only if copy review prefers — key change, en+ta), "Use my current location", "Set farm district" CTA, permission flows, `weather-device-note` testid, and the claim-free guarantee (WeatherPanel.test.tsx asserts no message mentions claims).
  4. With UX-03, keep the note visible in the collapsed strip.
- **Dependencies:** Step 3 (same file as UX-03).
- **Regression risks:** `WeatherPanel.test.tsx` asserts the device-note testid, that an Andhra district is never fetched, and the 8 message keys are claim-free in en/ta — key renames/interpolations must update both dictionaries (i18n parity test will catch asymmetry).
- **Verification:** unit suite; browser simulation of outside-TN state (component test with mocked LocationContext) + real farm-district flow.

### UX-09 — Header/navigation need production-grade finish (Issue I)

- **Page/component:** `Navbar.tsx` (219 lines) + transition to/from `LoginScreen`.
- **Observed:** Brand block, farm chip (profile district only — device location is correctly never shown), section toggle (Assistant/Claims/Admin) with `aria-current="page"` + visual active pill, language segmented control (`aria-pressed`, `lang` attr), user menu with Farm Profile / Manage Parcels / (admin items further down) / Logout, backdrop-close pattern, `data-surface="dark"` focus ring. Height `h-14`, inner `max-w-6xl` (see UX-04/D1). Mobile: labels collapse to `sr-only` below `sm`; all controls are buttons with accessible names. Missing/stale: the mobile chat drawer heading key bug (UX-12) affects the adjacent surface; farm chip and brand compete for the same visual weight; at 360px the row (brand + chip + toggle + language + avatar) is dense — needs a browser pass to confirm no wrap/clip (HYPOTHESIS).
- **Root cause:** **VERIFIED** for structure; **HYPOTHESIS** for small-viewport crowding (to be confirmed at Step 0 baseline).
- **User impact:** Dense chrome; brand chip hierarchy unclear; possible crowding at 360px.
- **Severity:** Medium.
- **Proposed correction:** Keep every control and menu item. Tune: brand block and farm chip as distinct hierarchy levels (chip slightly demoted), consistent paddings/gaps from the token spacing rhythm, verify 360px without clipping, verify keyboard order and focus visibility on dark surface, active-route indication unchanged. Apply decision D1 gutters if approved.
- **Dependencies:** Step 2 (shell/header), D1.
- **Regression risks:** `Navbar.test.tsx` pins section switching and language toggle; e2e `responsive.spec.ts` pins named header controls + white focus ring on dark header. Do not rename accessible names.
- **Verification:** Navbar tests; e2e responsive; browser keyboard walkthrough at 360/1440.

### UX-10 — Footer and page boundaries inconsistent (Issue J)

- **Page/component:** whole app. Only one semantic `<footer>` exists: the chat composer (`ChatInterface.tsx:464`). Landing footer note is a bare `<p>` (`LoginScreen.tsx:152`). No footer on claims/admin (correct for a `h-dvh` app shell).
- **Root cause:** **VERIFIED** — the authenticated app is a full-height workspace where a page footer would only steal space; the landing is a document-style page that deserves a landmark.
- **User impact:** Minor; landmark coverage and landing polish.
- **Severity:** Low.
- **Proposed correction:** Give the landing note a proper `<footer>` landmark with consistent gutters (same max-width container). **Do not** add a footer to the authenticated shell (documented decision, with rationale). No new legal/company/external links (none exist; none invented).
- **Dependencies:** Step 8.
- **Regression risks:** none expected.
- **Verification:** browser; axe-style manual landmark check.

### UX-11 — Design-token adoption is half-done; two contrast regressions re-entered the codebase

- **Components:** `ChatSidebar.tsx` (171, 213, 232-233, 245, 253-266, 278, 291-326), `ChatInterface.tsx` (358-602, ~20 raw-palette lines), `LoginScreen.tsx`, `ProfileOnboarding.tsx` (21 raw vs 1 token), `FarmProfileEditor.tsx`, `ManageParcels.tsx` (23 raw), `AdminReviewPage.tsx` (82 raw), `VoiceRecorder.tsx` (70, 77-78, 86), `ClaimAppealPanel.tsx`, `ClaimOwnershipDocuments.tsx`, `App.tsx:156-158`.
- **Observed:** The token system (`tailwind.config.js:19-58`, `tones.ts`) exists and the codebase's own comments document that `emerald-600`+white was replaced by `brand-700` for contrast (`Button.tsx:17-18`; `MessageBubble.tsx:50-52`). Yet: the sidebar active-chat row is `bg-emerald-600 … text-white` (`ChatSidebar.tsx:232`), the sidebar Retry button the same (`:213`), disabled row text `text-gray-400` (`:319` — the 2.5:1 color the token docs explicitly forbid), `VoiceRecorder` error text `text-red-500` on white (~4.0:1, below AA for small text) and a raw technical `error` object in user-visible copy (`:87`).
- **Root cause:** **VERIFIED** — token migration was completed for claims + navbar + message bubbles but not for the assistant surface, landing, profile/parcel modals, admin and voice recorder; the static ratchet does not guard raw-palette drift or these contrast pairs.
- **User impact:** Inconsistent greens/grays; measurable WCAG AA failures in the sidebar and voice error states; a future brand tweak would only half-apply.
- **Severity:** High (for the contrast regressions), Medium (for drift).
- **Proposed correction:** Migrate the listed components to `brand/ink/surface/danger/…` tokens **class-for-class** (same geometry, same layout) in early steps; fix the three contrast regressions to the documented token pairs; replace the VoiceRecorder raw error interpolation with an existing friendly i18n key + keep `aria-live`; optionally extend `static.test.ts` with a scoped raw-palette guard for the files this project touches (decision **D5**, only if it will not fail pre-existing debt outside scope).
- **Dependencies:** Step 1 (do first — everything else builds on it).
- **Regression risks:** Pure class swaps can still change computed styles subtly (hover/focus states). `ui/tokens.test.ts`, `static.test.ts`, `MessageBubble.test.tsx`, `WeatherPanel.test.tsx`, `Navbar.test.tsx` are the guard rails; run after each file.
- **Verification:** full unit suite after each component; browser visual diff at 1440.

### UX-12 — Missing i18n key: mobile chat-drawer heading renders the raw key "chats"

- **Component:** `ChatSidebar.tsx:181` calls `t('chats')`; **no `chats` key exists** in `i18n.ts` (en or ta) or `locales/v2.*.ts` (grep verified: zero definitions). i18next falls back to the key string, so every mobile user sees the literal word **"chats"** in the drawer header, in both languages.
- **Root cause:** **VERIFIED**.
- **User impact:** Broken localized string in a primary mobile surface.
- **Severity:** High.
- **Proposed correction:** Add `chats` to both dictionaries (en: "Chats"; ta: matching Tamil, reviewed against existing `noChats`/`newChat` tone). Covered by the existing en/ta parity test once added.
- **Dependencies:** Step 1 (with the sidebar token pass).
- **Regression risks:** none.
- **Verification:** i18n parity test; drawer heading assertion (new).

### UX-13 — Hard-coded English error bubble and mislabeled history loader

- **Component:** `ChatInterface.tsx:320` (`text: 'Server error. Please try again.'` — bypasses the existing `serverError` key, `i18n.ts:165` en / `:983` ta); `ChatInterface.tsx:431` reuses `t('processing')` for a session-history fetch.
- **Root cause:** **VERIFIED**. Violates `12_Technical_Guidelines.md` §4 (every user-facing string via `t()`).
- **User impact:** Tamil users receive English error text; confusing "Processing…" while history loads.
- **Severity:** High (i18n violation in an error path).
- **Proposed correction:** Use `t('serverError')` for the bubble; add a dedicated `loadingChatHistory` key (en+ta) for the history loader; keep staged send-stage copy (`uploadingImage`/`analyzingImage`/`processing`) unchanged.
- **Dependencies:** Step 4.
- **Regression risks:** minimal; add unit assertions.
- **Verification:** new unit test; i18n parity.

### UX-14 — Content-width drift: six page widths, no shared container convention

- **Observed (inventory):** `max-w-2xl` (wizard, parcel list), `3xl` (chat column/composer), `4xl` (claims list), `5xl` (claim detail, admin dashboard), `6xl` (navbar, weather, landing, admin queue), plus `lg/md` modals. Padding rhythms differ per page (`px-3 pt-1 sm:px-4` vs `px-3 py-4 sm:px-4` vs `px-4 py-5`). The documented guideline says chat and landing use `max-w-4xl` (`11_UI_UX_Guidelines.md` §4); chat actually uses `3xl`.
- **Root cause:** **VERIFIED** — no shared page-container primitive; each screen grew its own wrapper.
- **User impact:** Subtle jumps when moving between sections; perceived incoherence.
- **Severity:** Medium.
- **Proposed correction:** Define a convention (not a new dependency): section pages use `mx-auto w-full max-w-5xl px-3 pb-8 pt-2 sm:px-4` (claims list joins the detail page at 5xl; admin stays as-is or aligns in a later pass); chat keeps `max-w-3xl` column inside the full-bleed pane (documented deviation from the 4xl guideline, decision D2); wizard stays `max-w-2xl` (form focus). Document the convention in this file and, after implementation, append a dated note to `11_UI_UX_Guidelines.md` §4.
- **Dependencies:** Steps 2, 5, 6.
- **Regression risks:** width changes are visually safe but must be paired with per-page test runs (ClaimsPage, ClaimTracker, wizard).
- **Verification:** browser matrix; unit suites per page.

### UX-15 — Dialog/menu accessibility inconsistency

- **Observed:** Three dialog implementations coexist: `ui/ConfirmDialog.tsx` (correct: roles, focus trap, Esc, focus return); ad-hoc overlays in `ProfileOnboarding.tsx:124-127` and `FarmProfileEditor.tsx` and `ManageParcels.tsx:355-504` (`role="dialog" aria-modal` present in onboarding/editor but **no Esc, no focus trap, no focus return**); `AdminReviewPage.tsx:1009-1128` override modal has **no `role`/`aria-modal`**, a **hard-coded English** `aria-label="Close"` on the backdrop (line 1011 — the exact pattern the ratchet bans elsewhere), an **ArrowLeft icon used for a close action** (1020), raw `<button>`s instead of `Button`, and `focus:outline-none` on inputs. `MessageBubble`'s ⋯ menu (105-142) has no Esc handling.
- **Root cause:** **VERIFIED** — ConfirmDialog was added later; older modals predate it; AdminReviewPage is not in the ratchet's guarded file list.
- **User impact:** Keyboard users can get trapped or lose focus; inconsistent dismissal patterns; one untranslated accessible name on a reviewer surface.
- **Severity:** Medium.
- **Proposed correction:** Minimal, behavior-preserving a11y fixes: Esc-to-close + focus return on the three ad-hoc modals; `t()`-labeled close with a correct close icon, roles and focus management on the admin override modal; Esc on the message menu. **Do not** rewrite these modals onto a new primitive in this project (a shared `Modal` is noted as future work — the duplication finding UX-16 is explicitly deferred).
- **Dependencies:** Step 7.
- **Regression risks:** `AdminReviewPage.test.tsx`, `ManageParcels.test.tsx`, `ClaimEvidenceGallery.test.tsx` (ConfirmDialog behavior), `ui.test.tsx`. Keyboard handlers must not swallow typing in inputs.
- **Verification:** unit suites; manual keyboard pass per modal; optionally add AdminReviewPage to the static ratchet's guarded list after fixing.

### UX-16 — ProfileOnboarding ≈ FarmProfileEditor duplication (recorded, deferred)

- **Observed:** ~95% duplicated form/validation/JSX (validation at `ProfileOnboarding.tsx:73-86` vs `FarmProfileEditor.tsx:78-91`; identical district/crops/acres/language fields); both use raw palette and an emoji hero (`🌾`, lines 132/154).
- **Root cause:** **VERIFIED**.
- **Severity:** Low for users (Medium for maintainability).
- **Proposed correction:** **Deferred** — extracting a shared `FarmProfileForm` is a rewrite of working components with real regression risk and no user-visible gain proportional to the risk. Record here; schedule separately if approved. In this project, only token-align the classes and (optionally) replace the emoji with the existing `Sprout` icon.
- **Verification if ever done:** both components' tests + onboarding flow e2e.

### UX-17 — Voice recorder: contrast, touch target, raw error copy

- **Component:** `VoiceRecorder.tsx` — `bg-red-600`/`bg-red-500` record control (70, 77-78), `text-red-500` error text (~4.0:1, below AA), raw `error` object shown to the user (87), 40×40px target (68) vs the documented ≥44×44 (`11_UI_UX_Guidelines.md` §4), no `aria-live` on the error.
- **Root cause:** **VERIFIED**.
- **Severity:** Medium.
- **Proposed correction:** Token colors (`danger-*`, quiet tones), friendly existing error keys where available (keep the error string fallback only if a key cannot cover it — prefer adding an i18n key), 44px target, `role="alert"`/`aria-live` on the error. ADR-006 (Web Speech API, client-side) unchanged; no new speech behavior.
- **Dependencies:** Step 7.
- **Regression risks:** mic button tests (if any) and the composer layout; the Web Speech API cannot be unit-tested — keep the change purely presentational.
- **Verification:** browser with/without mic permission; unit for error rendering.

### UX-18 — Iconography and copy consistency nits

- **Observed:** `🗑️` emoji as the Clear-all-chats button glyph (`ChatSidebar.tsx:326`) and `🌾` hero emojis in onboarding/editor, against the lucide icon system and the "limit emoji-as-icon" guideline (§7); stale comment `ChatSidebar.tsx:166`; missing `aria-hidden` on the landing `CloudSun` icon (`LoginScreen.tsx:78`); dead ternary in `ManageParcels.tsx:377`; unused `chatEmptyState` key (`i18n.ts:129/953`).
- **Severity:** Low.
- **Proposed correction:** Replace emoji with lucide `Trash2`/`Sprout` (existing icons), fix comment/`aria-hidden`/dead ternary; leave the unused key in place (harmless; removing keys is out of scope) or remove it in the same i18n touch with parity test green.
- **Dependencies:** Steps 1, 4, 8.
- **Verification:** static ratchet; suites per file.

### UX-19 — Enter always sends; no Shift+Enter newline (observation)

- **Component:** `ChatInterface.tsx:549` — `onKeyDown={e => e.key === 'Enter' && handleSend()}` while bubbles render `whitespace-pre-wrap` (`MessageBubble.tsx:76`).
- **Severity:** Low.
- **Proposed correction:** Optional, deferred by default: add Shift+Enter → newline (does not remove any capability; Enter still sends). Only implement if approved, with a unit test; mobile Enter behavior unchanged.
- **Verification:** unit test for both keys.

### UX-20 — Public/authenticated transition and shell decision points (roll-up of A/B/D)

- Decision **D1** — shell gutters: full-bleed header/weather (recommended) vs keep `max-w-6xl` centered chrome. Visual-only; reversible; verify in browser at 1440/1920.
- Decision **D2** — chat column width: keep `max-w-3xl` (recommended; document deviation) vs adopt guideline `max-w-4xl`.
- Decision **D3** — landing language toggle: adding the existing Tamil/English capability to the public page (new placement of an existing feature; optional, needs approval because it is new UI surface pre-login; must not request location or call authenticated APIs).
- Decision **D4** — claims list next-step hints: only if expressible with existing workflow vocabulary (see UX-06); otherwise skip.
- Decision **D5** — extend `static.test.ts` with a scoped raw-palette guard for files touched by this project (recommended after each file is clean).

---

## C. Implementation roadmap

Small, reviewable steps; each ends with tests + browser inspection before the next begins. (These are post-approval implementation steps — not to be confused with the Phase 1/Phase 2 gate of this engagement.)

| Step | Scope | Findings | Key files | Exit criteria |
|---|---|---|---|---|
| **0. Browser baseline** | Run the app locally; capture before-screenshots (landing, chat empty/conversation, claims list/detail/wizard, admin if possible) at 360/768/1440/1920; confirm hypotheses (sidebar blending, header crowding at 360, banner footprint). Run `npm run test/lint/typecheck` (baseline recorded). | all | — | Screenshot set stored; hypotheses confirmed/refined |
| **1. Token & i18n foundation** | Class-for-class token migration of `ChatSidebar`, then `ChatInterface` non-layout classes; add `chats` key; fix sidebar contrast regressions (active row → `brand-700`, retry → `Button` variant, disabled text → `ink-subtle`); `App.tsx` loading screen tokens. No layout/behavior change. | UX-11, UX-12 | ChatSidebar.tsx, ChatInterface.tsx, App.tsx, i18n.ts | Unit suite green; no visual geometry change |
| **2. App shell, header, sidebar-as-chrome** | Sidebar surface change; chat header/column axis alignment; D1 gutters (if approved); Navbar hierarchy/360px pass; stale comment fix. | UX-04, UX-09, UX-10 (partial), D1, D2 | App.tsx, Navbar.tsx, WeatherPanel.tsx (container only), ChatSidebar.tsx, ChatInterface.tsx | Browser: balanced shell at 1024/1440/1920; Navbar + responsive e2e green |
| **3. Weather banner: collapse + location copy** | Collapse toggle with `aria-expanded` + `vivasayi.weatherCollapsed.v1` persistence; compact collapsed row keeping warnings/active-district visible; density pass; outside-TN/denied/unavailable copy consolidation naming the farm district dynamically. | UX-03, UX-08 | WeatherPanel.tsx, useWeatherSource pattern, locales v2 en/ta | New collapse tests + existing 6 WeatherPanel tests green; browser 360/1440 expand/collapse/reload |
| **4. Assistant workspace polish** | Welcome-state centering + hierarchy + tokenized suggestions; history loader copy; error bubble via `t('serverError')`; composer visual separation. | UX-05, UX-13, UX-19 (if approved) | ChatInterface.tsx, i18n.ts, MessageBubble.tsx (minor) | New unit tests; browser empty + conversation states |
| **5. Claims list** | Container → `max-w-5xl`; header hierarchy; card anatomy rhythm; optional next-step hints per D4. | UX-06, D4 | ClaimsPage.tsx, i18n.ts (if new copy) | ClaimsPage suite green; browser 360/640/1024/1440 |
| **6. Claim details** | Header band (title/ref/status), section grouping rhythm, keep all content + selector contracts. | UX-07 | claims/ClaimTracker.tsx, TrackerHeader.tsx | ClaimTracker TRK suite + relevant e2e green; browser draft/submitted/decided |
| **7. Remaining surfaces & dialogs** | Landing token restyle + footer landmark (+ optional D3); profile/parcel modal Esc/focus; admin override modal a11y (roles, t() close label, close icon, focus); VoiceRecorder contrast/target/aria-live; emoji→lucide. | UX-01, UX-02, UX-10, UX-15, UX-17, UX-18, D3 | LoginScreen.tsx, ProfileOnboarding.tsx, FarmProfileEditor.tsx, ManageParcels.tsx, AdminReviewPage.tsx, VoiceRecorder.tsx | LoginScreen LOC-11 green; Admin/ManageParcels/Profile suites green |
| **8. Consistency sweep** | Padding/width convention audit (UX-14); scannable review of every route for spacing/hierarchy regressions introduced by prior steps; extend static ratchet if D5 approved. | UX-14, D5 | touched files, static.test.ts, docs note in 11_UI_UX_Guidelines | Full unit + lint + typecheck green |
| **9. Regression & verification** | Full `npm run test`, `npm run lint`, `npm run typecheck`, `npm run contract:check`; Playwright: `responsive`, `i18n`, `refresh-reopen`, `satellite-weather`, `no-fake-progress`, `authz`, `claim-submit-auto` (+ full 15-spec run if the hermetic harness is available); complete browser matrix (F.4); after-screenshot capture; final report. | all | — | All gates green; report produced |

Dependency notes: Step 1 must precede 2-7 (everything restyles onto tokens). Steps 3 (banner + copy) are intentionally one step to avoid double-touching WeatherPanel. Step 7 bundles low-risk presentational fixes; if a sub-item proves risky in review, it can slip to Step 8 without unblocking anything.

---

## D. Before-and-after acceptance criteria

| ID | Observable "after" condition |
|---|---|
| UX-01 | Landing uses only token classes for brand/surfaces/text; brand block matches the Navbar's treatment; sign-in card and context card share the shell's card conventions; LOC-11 test unchanged and passing. |
| UX-02 | Landing context card is visually tied to the sign-in action; copy explains farm-district-first weather; no device place, no location prompt, no pre-auth API calls. |
| UX-03 | A labeled toggle with `aria-expanded` shows/hides forecasts + insight; collapsed strip is one compact row showing active district (+ temperature when loaded) and keeps outside-TN/denied/no-farm warnings and the retry/set-district controls reachable; preference persists across reload on the same device (`localStorage` `vivasayi.weatherCollapsed.v1`) and resets nothing else; on a 360×740 viewport the expanded strip plus header occupy ≤ ~45% of the viewport (measured), collapsed ≤ ~15%. |
| UX-04 | At 1024/1440/1920: sidebar is a visually distinct left rail (different surface + border from the chat pane); chat header title's left edge aligns with the message column's content edge; composer pinned to the pane bottom; conversation column ≤ `max-w-3xl`; sidebar and conversation scroll independently; mobile drawer behavior identical to today (open/select/close/overlay). |
| UX-05 | Empty assistant state is vertically centered in the pane with greeting > subline > context chip > suggestions hierarchy; suggestions are the same four keys and still fill the composer on tap; send-failure bubble is localized in ta; history loading shows a history-specific localized label. |
| UX-06 | Claims list container is `max-w-5xl`; every existing card field still present with compact hiding rule intact; status badge scannable; header has title + action (+ supporting copy if added); no invented metrics; File-a-Claim action unchanged. |
| UX-07 | Claim detail header band shows back + event-type title + reference + overall status together; sections read as grouped blocks; every existing control/warning/upload/satellite explanation byte-identical in meaning; Playwright selector contract intact. |
| UX-08 | In the outside-TN + farm-district state the farmer sees one note naming the device situation and the active farm district, one active-location line, and the existing controls (Retry / Use farm location / Set farm district); no statement implies the device location is the farm; all 8 device-message keys remain claim-free in en/ta. |
| UX-09 | At 360px nothing clips or wraps in the header; all controls keep accessible names; `aria-current` marks the active section; language toggle keeps `aria-pressed`; keyboard tab order reaches every control with a visible white focus ring on the dark header. |
| UX-10 | Landing note is inside a `<footer>` landmark; authenticated app has no page footer; composer footer never overlapped. |
| UX-11 | No raw `emerald-600`+white pairing remains in ChatSidebar/ChatInterface; no `text-gray-400` on text; VoiceRecorder error text ≥4.5:1; token classes used consistently in touched files. |
| UX-12 | Mobile drawer heading renders "Chats"/Tamil equivalent in both languages. |
| UX-13 | Text-send failure bubble matches the `serverError` key in the active language. |
| UX-14 | Claims list and detail share one container width; chat column and composer share one axis; the width convention is documented. |
| UX-15 | Every modal closes with Esc, restores focus to its trigger, and has translated accessible names; admin override modal has `role="dialog"` + `aria-modal`. |
| UX-17 | Voice record button ≥44×44px; error announced via live region; friendly copy. |
| UX-18 | No emoji used as button/hero icons in the touched files; no stale comments. |

---

## E. Feature-preservation checklist

Every item below must still work after each step and at completion (spot-verified in F.4):

1. **Auth:** Google sign-in (`login`), logout, 401 → landing, `returnTo` deep-link restore, admin role gating (`#/admin` denied for non-admins).
2. **Landing:** farm-first context card, tips, feature cards, sign-in error `Alert`, Google button, no location prompt, no device place.
3. **Header:** brand block, farm-district chip (or "Set farm district" when missing; hidden while profile unknown), Assistant/Claims/(Admin) toggle with active indication, Tamil/English switch persisting via AuthContext + `localStorage.language`, user menu (Farm Profile, Manage Parcels, admin entries, Logout), white focus ring on dark surface.
4. **Weather:** farm-district default; opt-in "Use my current location" (permission only on tap); silent re-grant when permission already granted; outside-TN/denied/unavailable/unsupported messages (claim-free); Retry; "Use farm district ({{district}})"; "Set farm district" CTA; forecast cards; farming insight derived only from backend numbers; `status:"unknown"` state; source persistence (`vivasayi.weatherSource.v1`); **plus new**: collapse/expand with persistence.
5. **Chat:** session list (loading/error/empty), New Chat, per-chat delete with inline confirm, Clear All with inline confirm, chat selection, message history load (incl. 404/401/429 handling), text send (Enter), image attach/validate/upload (5 MB, magic-byte sniffing) + staged send states, voice input (Web Speech), parcel selector (when >1 parcel), AI message rendering incl. knowledge-sources footer, image messages, contextual menu with whole-chat delete dialog, auto-scroll, toasts.
6. **i18n:** en/ta parity for every string; Tamil font stack; language persists across reload.
7. **Claims:** list (loading/error/empty/ready), File a Claim wizard (all five steps, draft persistence, idempotency, evidence limits 1–10 photos, land-document groups, relationship step, review+edit, submit phases, retry taxonomy, start-over), tracker (progress polling, stage order, current-stage explanation, refresh, offline/stale banners, held details, decision card with translated reasons, withdraw/resubmit/appeal via ConfirmDialog, evidence gallery, ownership documents, satellite supporting-only card), hash routing for all claim views incl. deep links and Back.
8. **Profile/parcels:** onboarding (complete/skip/resume from menu), farm profile edit, parcel CRUD with map draw/search, "My location" opt-in on the map.
9. **Admin:** queue, filters (incl. Held), investigation, detail, override modal, diagnostics — behavior untouched apart from a11y fixes in UX-15.
10. **Accessibility invariants:** one global focus ring; `data-surface` ring rules; reduced-motion CSS; ≥12px text; ratchet bans (gradient pair, window.confirm, 10/11px claim type, progress bars on claim screens, device place-names on Navbar/LoginScreen) all still enforced.

---

## F. Test strategy

### F.1 Existing gates (run at the end of every step)

`npm run test` (726 tests / 53 files baseline) · `npm run lint` (0 errors; 2 known warnings) · `npm run typecheck` · `npm run contract:check` (when backend schema could be affected — not expected for pure UI, but cheap insurance).

### F.2 Targeted suites per area

| Area | Suites |
|---|---|
| Shell/header | `App.routing.test.tsx`, `App.claimsRoute.test.tsx`, `App.adminOnboarding.test.tsx`, `Navbar.test.tsx`, `ui/ui.test.tsx`, `static.test.ts` |
| Landing | `LoginScreen.test.tsx` (LOC-11), `static.test.ts` |
| Weather/location | `WeatherPanel.test.tsx`, `useWeatherSource.test.tsx`, `LocationContext.test.tsx`, `App.routing.test.tsx` |
| Chat | `MessageBubble.test.tsx`, new `ChatInterface`/`ChatSidebar` tests (see F.3) |
| Claims | `ClaimsPage.test.tsx`, `claims/ClaimTracker.test.tsx`, `ClaimWizard.test.tsx`, `claimFlow*.test.ts`, `claimResponsive.test.ts` |
| Modals/voice | `ManageParcels.test.tsx`, `AdminReviewPage.test.tsx`, `ClaimEvidenceGallery.test.tsx`, `ClaimOwnershipDocuments.test.tsx` |
| i18n | `i18n.test.ts` (parity), `contracts/progressContract.test.ts` |

### F.3 New tests to add (with their implementation steps)

1. **WeatherPanel collapse (Step 3):** toggle shows/hides forecast+insight; `aria-expanded` reflects state; preference persists via storage (use the memory-storage injection pattern of `useWeatherSource.test.tsx`) and defaults to expanded; outside-TN note + retry remain rendered when collapsed; `data-weather-source` unchanged.
2. **WeatherPanel copy (Step 3):** outside-TN + farm-district state names the district in the note (i18n interpolation), stays claim-free.
3. **Chat sidebar (Step 1/4):** drawer heading renders a translated string (not the raw key); active-row classes use token pairs.
4. **Chat interface (Step 4):** send-failure path renders the `serverError` translation; history loader uses `loadingChatHistory`; welcome state centered (container classes) with the four suggestion keys.
5. **Claims list (Step 5):** container width class; card fields incl. compact hiding; any next-step hint derives from existing state gates.
6. **Claim tracker (Step 6):** header band contains back + title + reference + status pill with existing testids.
7. **Modals (Step 7):** Esc closes profile editor / parcel modals and restores focus; admin override modal has dialog roles and a translated close name.
8. **Static ratchet extensions (Step 8, D5):** scoped bans for raw `emerald-600`/`text-gray-400`/raw `aria-label="Close"` in the files this project cleaned (kept narrow to avoid failing out-of-scope debt).

### F.4 Browser verification matrix (manual or Playwright-assisted)

Routes: landing · `#/chat` (empty, active conversation, image turn, mobile drawer) · `#/claims` (0/1/many claims) · `#/claims/new` (steps) · `#/claims/:id` (draft / submitted / more_evidence_required / decided) · `#/admin` (if reviewer credentials available).
Viewports: **360×740**, 390×844, 768×1024, 1024×768, 1440×900, 1920×1080. Languages: English + Tamil (toggle mid-session). Checks per cell: no horizontal overflow; no clipped controls; focus ring visible; collapse/expand; drawer open/select/close; banner warnings visible in collapsed state; composer pinned; claim actions reachable; toasts not overlapping critical actions.

### F.5 E2E (Playwright, hermetic harness per ADR-024)

Minimum per the roadmap: `responsive`, `i18n`, `refresh-reopen`, `satellite-weather`, `no-fake-progress`, `authz`, `claim-submit-auto`, `review-appeal`. Full 15-spec run before sign-off when the backend harness is available (~22 min, `workers: 1`). E2E selector contracts (WeatherPanel, ClaimTracker page object, wizard testids) are treated as frozen: markup changes must keep them queryable.

### F.6 Evidence discipline

No step is reported complete on rendered-component appearance alone: each requires its listed suites green and the relevant browser matrix cells inspected, with before/after screenshots from Step 0/Step 9 kept alongside this document's history.

---

## G. Implementation log (approved roadmap, stepwise)

Each row is closed only when its listed suites are green and the browser matrix cells were inspected. Steps not listed are pending.

| Step | Items | What changed | Verification |
|---|---|---|---|
| 1 | UX-11, UX-12 | Token cleanup in `ChatSidebar`/`ChatInterface`; VoiceRecorder error contrast; drawer heading localized | `npm run test`, `npm run lint` (0 errors), `npm run typecheck` green |
| 2 | UX-04, UX-09, D1 | `Navbar.tsx` full-bleed header (sr-only labels below `lg`, `aria-current` active section, `aria-pressed` language toggle); `WeatherPanel.tsx` full-bleed; chat header/message column/composer share one axis; `e2e/responsive.spec.ts` E2E-21c added | unit + typecheck + lint; `responsive.spec.ts` + `chat-layout.spec.ts` green at desktop+mobile |
| 3 | UX-03, UX-08 | `WeatherPanel` collapse/expand toggle (`aria-expanded`, `data-weather-expanded`, persisted `vivasayi.weatherCollapsed.v1`); outside-TN note names the active district | `WeatherPanel.test.tsx`; E2E-21b green |
| 4 | UX-05, UX-13 | `ChatInterface.tsx`: welcome state vertically centered in the pane (`chat-column` `flex min-h-full`, `chat-welcome` `flex flex-1 items-center justify-center`); hierarchy greeting → subline → context chip → suggestions; suggestion pills restyled with token classes (same four keys, click-fills composer); send-failure bubble uses `t('serverError')` (en + ta) | new `ChatInterface.test.tsx` (4 tests); 734/734 unit; typecheck + lint; temporary Playwright spec verified welcome centering at 360/390/412/1440, keyboard composer reach, no overflow with weather expanded and in an active conversation, and the localized `serverError` bubble; `responsive.spec.ts` + `chat-layout.spec.ts` re-run green (12/12); after-screenshots captured |
| 5 | UX-06, D4 | `ClaimsPage.tsx` (`ClaimsList`): container widened `max-w-4xl` → `max-w-5xl` to match the detail page; header gains supporting copy (`claimsPageSubtitle`) beside the title; cards rebuilt as a `flex h-full flex-col` column with grouped meta rows (event+status → date/area/parcel → filed/evidence footer with a top border) using only existing tokens; new `claimNextStepKey(state)` in `utils/claimFlow.ts` derives a card hint from the **existing** state gates (`canSubmitClaim`/`canResubmitClaim`/`canAppealClaim`) — `draft`→submit, `more_evidence_required`→resubmit, `rejected`/`out_of_limit`/`duplicate_area`→appeal, every other state→no hint; hint rendered as a secondary `data-testid="claim-next-step"` line using the `nextStep_*`/`nextStepLabel` keys (en+ta) | `ClaimsPage.test.tsx` +6 tests (container `max-w-5xl`, subtitle, per-state hint, no-hint states, card still opens detail); `claimFlow.test.ts` +1 (`claimNextStepKey` mapping); 741/741 unit; typecheck (app+e2e) + lint (0 errors); temporary Playwright spec verified all widths 360/390/412/768/1024/1440/1920, no overflow, hints correct, no-hint states, Tamil, long-text clipping; `responsive.spec.ts` (E2E-21 list assertion) + `claim-submit-auto.spec.ts` + `area-overlap.spec.ts` re-run green (16/16); fresh after-screenshots at `test-results/ui-audit/after/<project>/claims-list-*.png` |
| 6 | UX-07 | `claims/ClaimTracker.tsx` page header band: back control keeps `aria-label={t('backToClaims')}` and the `h2` name `Claim details`; a new subtitle under the title shows the claim's identity from existing fields — `t(claimEventLabelKey(eventType))` · `formatClaimDate(eventDate)` — so the farmer sees *what* the claim is at the top. The page body is regrouped into four spaced blocks (`space-y-4` between groups, `space-y-3` within): **summary** (`TrackerHeader` + refresh-error / legacy / loading), **action** (`ActionRequiredCallouts` + `DecisionCard`), **details** (5-col grid: `ProgressStages` + `ClaimFacts` / `SatelliteCard` + `EvidenceSummary`, then the held-details disclosure) and **evidence** (gallery, ownership documents, appeal panel). To avoid a duplicate summary the event·date row was moved out of `TrackerHeader`'s `dl` into the page header; the status pill, reference + copy control, refresh action, last-updated indicator and every banner stay in `TrackerHeader` as the single source of status. Redundant `mb-3` removed from `TrackerHeader`, `ActionRequiredCallouts` and `DecisionCard` (each now spaced by its group) | `ClaimTracker.test.tsx` (TRK-1…16, incl. TRK-1 header/selector pin and TRK-15 Tamil no-English render) + `ClaimsPage.test.tsx` green; **741/741** unit; typecheck (app+e2e) + lint (**0 errors**, 2 pre-existing warnings); `satellite-weather.spec.ts` + `land-docs.spec.ts` + `refresh-reopen.spec.ts` + `no-fake-progress.spec.ts` + `decision-consistency.spec.ts` green (**56/56**, desktop+mobile); temporary Playwright spec verified in-progress **and** decided claims at 360/390/412/768/1024/1440/1920 (no horizontal overflow, header identity, all sections present), Tamil render at 360/1440 (no overflow, no English header strings); after-screenshots at `test-results/ui-audit/after/<project>/claim-detail-ux07-{inprogress,decided}-{360,1440}.png`; before baseline recovered to `test-results/ui-audit/before/<project>/claim-detail-before-*.png` (a genuine earlier capture of the pre-UX-07 page — no fabricated comparison) |

| 7 | UX-01, UX-02, UX-10, UX-15, UX-17, UX-18 | `LoginScreen.tsx`: raw emerald palette replaced with brand tokens (`bg-brand-50/60`, `text-brand-950/700/800/600`, `border-brand-100`); `<footer>` landmark added wrapping `landingFooterNote`; context strengthened with new `landingContextSubtitle` key. `ProfileOnboarding.tsx` / `FarmProfileEditor.tsx` / `ManageParcels.tsx` modals: Esc-to-close, `autoFocus`, focus-return via `focusRef`. `AdminReviewPage.tsx` OverrideDialog: `role="dialog"`, `aria-modal`, `t()` close label, `X` icon, Esc/focus-return. `MessageBubble.tsx` menu: Esc-to-close. `VoiceRecorder.tsx`: friendly error copy via new `micErrorBody` key (en+ta), `role="alert"` announcement, 44px touch target (`h-11 w-11`). Icons/copy nits: `🌾`→`Sprout` (lucide, `aria-hidden`), `🗑️` removed, stale comment cleaned. `i18n.ts`: `micErrorBody` (en+ta); English `landingContextSubtitle`; Tamil `landingContextSubtitle` parity added. New `VoiceRecorder.test.tsx` (4 tests). | `i18n.test.ts` 6/6 pass (EN/TA parity green); `LoginScreen.test.tsx` 1/1 pass (LOC-11 green); `VoiceRecorder.test.tsx` 4/4 pass; `MessageBubble.test.tsx` 5/5 pass (UI-15 a11y); `ManageParcels.test.tsx` 13/13 pass; full unit suite **745/745 pass**; typecheck app green; lint **0 new errors** on Step 7 files (18 pre-existing in Phase 3 restructure); no regressions on ADM-4 / UI-16 / LOC-11 selectors |
| 8 | UX-14 (partial), D5, App.tsx loading splash | `App.tsx` loading splash: raw emerald palette (`from-emerald-50 to-white`, `text-emerald-600`, `text-gray-600`) replaced with tokens (`bg-surface-muted`, `text-brand-700`, `text-ink-muted`). Phase 3 TypeScript errors fixed in `FarmProfileEditor.tsx`, `ProfileOnboarding.tsx`, `ManageParcels.tsx` (unused imports/vars removed, `setErrorFromKey` added, `focusRef` null-safety, raw palette → tokens). Lint clean (0 errors). | `npm run test` **745/745 pass** (including TRK-6 now passing); `npm run typecheck` clean; `npm run lint` 0 errors (2 pre-existing warnings); `npm run contract:check` OK; production build succeeds. Static tests + i18n parity + LOC-11 all green. |

**Explicitly not changed:** `api.ts`, `api/*`, `AuthContext`, `LocationContext`, `routing/*`, claim-flow/progress logic, backend, contracts, `tailwind.config.js` tokens, e2e selector values.

**Deferred (not part of this step):** UX-19 (composer density) remains. UX-14 (shared width convention doc) is partially implemented — claims list and detail share `max-w-5xl`; the written convention note in `11_UI_UX_Guidelines.md` §4 remains for future documentation.

**Report-only (not fixed here):** backend Chroma Cloud reach on `POST /chat` (`services/chat.service.js`); `ClaimTracker.test.tsx` TRK-6 load flakiness (observed once in the Step 5 run, passes in isolation and on every re-run — including both Step 6 full-suite runs and current run — deferred as documented).

---

## Appendix — files likely to change (per step)

| Step | Files |
|---|---|
| 1 | `src/components/ChatSidebar.tsx`, `src/components/ChatInterface.tsx` (classes only), `src/App.tsx` (loading screen), `src/i18n.ts` (+`locales/v2.*.ts` if `chats` lands in v2) |
| 2 | `src/App.tsx`, `src/components/Navbar.tsx`, `src/components/ChatSidebar.tsx`, `src/components/ChatInterface.tsx` (header wrapper), `src/components/WeatherPanel.tsx` (container class only) |
| 3 | `src/components/WeatherPanel.tsx`, `src/locales/v2.en.ts`, `src/locales/v2.ta.ts`, `src/components/WeatherPanel.test.tsx` |
| 4 | `src/components/ChatInterface.tsx`, `src/i18n.ts`, new `ChatInterface.test.tsx` |
| 5 | `src/components/ClaimsPage.tsx`, `src/i18n.ts`, `src/components/ClaimsPage.test.tsx` |
| 6 | `src/components/claims/ClaimTracker.tsx`, `src/components/claims/TrackerHeader.tsx`, `src/components/claims/ClaimTracker.test.tsx` |
| 7 | `src/components/LoginScreen.tsx`, `ProfileOnboarding.tsx`, `FarmProfileEditor.tsx`, `ManageParcels.tsx`, `AdminReviewPage.tsx`, `VoiceRecorder.tsx`, `MessageBubble.tsx` (menu Esc), `src/i18n.ts` |
| 8 | `src/test/static.test.ts` (D5), `docs/product/11_UI_UX_Guidelines.md` (dated note on the width convention) |

**Explicitly not changing:** `api.ts`, `api/*`, `context/AuthContext.tsx` behavior, `context/LocationContext.tsx` semantics, `routing/*`, `utils/claimFlow.ts`/`claimProgress.ts`/`claimResponsive.ts` logic, backend repositories, progress/claim contracts, `tailwind.config.js` token definitions (except no changes at all unless D5 requires a test), e2e selector values.
