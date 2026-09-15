# 11 — UI/UX Guidelines

> **Metadata**
> - **Title:** 11 — UI/UX Guidelines
> - **Version:** 1.0
> - **Status:** `[ACTIVE]`
> - **Owner:** Design / Frontend
> - **Last Reviewed:** 2026-08-07
> - **Related Documents:** [03_Target_Users](03_Target_Users.md) · [10_User_Flows](10_User_Flows.md) · [AI_Product_Principles](AI_Product_Principles.md) · [PRODUCT_PRINCIPLES](PRODUCT_PRINCIPLES.md)

> **Why this document exists:** Consistent, accessible, mobile-first design is a product requirement for the target user (low digital literacy, low-end Android, variable connectivity), not an aesthetic preference. These guidelines describe the current system and the direction it must move toward. **Principle: usability over decoration.**

---

## 1. Design principles

1. **Language-first.** The interface language is chosen *before* anything else; Tamil is the default posture for Tamil-speaking users. Never make a farmer read English chrome to reach Tamil.
2. **Zero-typing goal.** A user should get their first useful answer with taps and voice — no keyboard required.
3. **Zero-re-asking (APP-02).** Never present a question the platform can already answer from the Context Engine or Farm Memory (GPS, district, weather, soil, crop history). Every on-screen question must be justified against "could the system know this already?" in the design review.
4. **One screen, one job.** Login → language → chat. No competing feature surfaces on the home screen.
5. **Clarity over cleverness.** Big targets, plain language, explicit state ("thinking…", "saved", "error").
6. **Fast feeling.** Streaming text, optimistic updates, and visible progress. A spinner for 15 seconds is failure.
7. **Trust cues.** Show what the platform knows ("Thanjavur · Paddy · 32°C · loamy soil") — the context chips make the Decision Platform's awareness visible and correctable; show demo/safety flags honestly, never fake data.
8. **Low-end friendly.** Works on ₹7-15k Android, metered data, variable connectivity.

## 2. Typography

| Role | Today | Direction |
|---|---|---|
| Display/headings | `text-3xl/4xl` on landing (very large) | Reduce scale; `text-2xl` max on mobile; `font-bold` |
| Body / chat | `text-base` / `text-lg` | `text-base` (16px) base; `text-lg` for chat answers is acceptable but cap at `text-lg` |
| Micro/captions | `text-xs`/`text-sm` | Keep; never below 12px for readable content |
| Tamil script | system font fallback | Use a Tamil-friendly stack (e.g., Noto Sans Tamil) and verify rendering; **Tamil glyphs must not render as boxes** |

- **RTL:** not needed (Tamil is LTR) — avoid RTL assumptions.
- **Line length:** chat bubbles ≤ ~80 chars; paragraphs short and actionable.

## 3. Colors (current Tailwind-based palette)

| Token | Value | Usage |
|---|---|---|
| Primary `green-600` (#16a34a) | Header, buttons, user bubbles | Brand + actions |
| `green-50/100` (#f0fdf4 / #dcfce7) | Page/chat backgrounds | Calm, agrarian feel |
| Accent `orange-600` (#ea580c) | Tamil language choice | Language identity |
| Danger `red-600` (#dc2626) | Delete/stop/recording | Destructive + active mic |
| Info `blue-600` (#2563eb) | Image upload | Secondary action |
| Warning `yellow-50/800` | Weather advice panel | Guidance highlight |
| Neutral gray | Text/secondary | Readability |

**Direction:** tokenize into semantic Tailwind theme tokens (e.g., `brand-primary`, `surface`, `text-primary`) so light/dark and themes can be introduced without hunting hex codes. Dark mode (dawn/night field use) planned.

## 4. Spacing & layout

- **Base unit:** 4px grid (Tailwind default). Chat input bar `py-3`, header `py-2`.
- **Max width:** content constrained to `max-w-4xl` for chat; landing card `max-w-4xl` → keep.
- **Touch targets:** ≥ 44×44px (current buttons mostly satisfy; the mic button is oversized — normalize).
- **Sidebar:** `w-72` mobile drawer / `lg:w-64` static desktop (current). Drawer must close on selection on mobile (current behavior).

## 5. Components

| Component | Current | Guideline |
|---|---|---|
| **Login screen** | Weather card + Google button | Keep weather *after* login in a compact strip; make login friction minimal |
| **Language screen** | Two big flag buttons | Keep as first-run screen (move before login, Phase 1) |
| **Chat bubble** | Green (user) / white (AI) rounded-2xl/3xl, timestamp | Keep; add sender label only when ambiguous; AI bubbles get a subtle "grounded/sources" indicator once RAG sources are surfaced |
| **Input bar** | Mic + image + text + send | Prioritize voice + image; text still available; show upload progress |
| **Message attachments** | Image preview bubble | Add upload progress + failure state + thumbnail |
| **Toasts (Sonner)** | top-right, 3s | Use for success/errors only; not for primary info |
| **Loading** | spinner + "Processing…" | Replace with streaming + skeleton; keep spinner as fallback |
| **Empty states** | "No chats yet" | Add first-run suggested questions + illustration |

## 6. Navigation

- **Global:** Header (logo, email, language toggle, logout) + sidebar (history) + chat body. Current structure is correct.
- **Mobile:** hamburger opens sidebar drawer + overlay (current). Close on selection (current).
- **Direction:** add a compact **"My farm" strip** (district · crop · weather · soil) accessible from header — visible context chips, editable (Phase 1-2, powered by Context Engine + Farm Memory). The chips show what the platform auto-knows (APP-02/03) and let the farmer correct it.

## 7. Responsive design

- **Mobile-first.** All screens currently mobile-usable; verify at 360px width.
- Breakpoints used: `sm (640)`, `md (768)`, `lg (1024)` — align to Tailwind defaults.
- Chat input reflows from column to row at `sm` (current).
- **Low-end devices:** avoid heavy shadows/gradients; limit emoji-as-icon usage (inconsistent rendering); preload the Tamil font.

## 8. Animations & micro-interactions

- **Purposeful only:** recording pulse (`animate-pulse`), send success, message scroll (`scrollIntoView smooth`), sidebar slide (`transition-transform`).
- **Rule:** no animation that delays interaction; respect `prefers-reduced-motion` (currently not handled — add).
- Typing/streaming cursor: simple caret or progress bar, not animated dots on low-end devices.

## 9. Accessibility

| Area | Requirement | Status |
|---|---|---|
| Contrast | WCAG AA (4.5:1) for text | Most current green-on-white pairs pass; verify Tamil text sizes |
| Touch | ≥44px targets | Mostly ok; normalize mic button |
| Forms | Labels + focus states | Chat input has placeholder only — add `aria-label` |
| Icon buttons | `aria-label` for mic/image/logout/language | **Missing** — add |
| Motion | `prefers-reduced-motion` | **Missing** — add |
| Keyboard | Enter sends; Esc closes dialogs/menus | Enter present; Esc for language menu missing |
| Screen readers | Semantic landmarks (header/main/footer) | Largely present via Tailwind markup; verify |
| Error messaging | Inline + toast, in the active language | Partial — standardize via i18n |

## 10. Copy & tone

- Farming user: short sentences, imperative verbs ("Apply urea 10-15 kg/acre"), Tamil-first.
- One concept per sentence; list steps with bullets.
- Error copy must be actionable, not technical ("Connection error. Please try again.").
- Always honor the AI's safety line: "Please consult your local agricultural officer" where the system is uncertain.
- Microcopy lives in `i18n.ts` (en/ta). Keep both dictionaries in sync on every UI change.

## 11. UI/UX success checklist (per screen)

- [ ] Usable with 0 typing.
- [ ] **No question shown that the Context Engine/Farm Memory can auto-answer (APP-02).**
- [ ] Fully functional in Tamil at 360px width.
- [ ] All interactive targets ≥44px, labeled, keyboard-accessible.
- [ ] No information the farmer needs is hidden behind hover-only (mobile).
- [ ] Loading/error/empty states defined for every async action.
- [ ] Reduced-motion respected; no pointless animation.
- [ ] Diagnosis cards show the context that informed them (weather/soil/crop/location chips).
