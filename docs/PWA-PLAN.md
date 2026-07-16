# PWA Support — Design & Implementation Plan

> Status: **implemented & build-verified** (2026-07-16). Scope: **installable
> PWA** (web app manifest + icon set + Apple/iOS metadata) with a **service
> worker** that provides installability and an **offline app-shell fallback**,
> plus an optional **install affordance**. The service worker deliberately
> caches almost nothing — a live terminal is inherently online. All changes are
> scoped to `apps/terminal/`. Typecheck + lint clean, production build succeeds,
> and every new route (`/manifest.webmanifest`, icons, `/sw.js`, `/offline.html`)
> was confirmed to serve `200` from a real `next start`. This doc is the
> decision record; the sections below describe the shipped design.

Make the Sparklab web terminal installable to the home screen / app dock. The
product framing motivates it directly: **jobs survive the browser and the
gateway** — closing the tab, losing the network, or restarting the gateway
never kills a running process (persistent tmux sessions). Installing the
terminal as a standalone app makes that durability tangible: **your sessions
are always one tap away, right where you left them.**

---

## 0. Grounding (verified against source)

- `apps/terminal/src/app/layout.tsx` already exports `viewport` with
  `themeColor: "#2b2622"`, `viewportFit: "cover"`,
  `interactiveWidget: "resizes-content"` (a documented mobile-UX spec — left
  untouched). `metadata` had only `title` + `description`.
- `apps/terminal/src/app/icon.svg` exists: rounded-rect (`rx="7"`) `#2b2622`
  background, `#f7f5f0` terminal-prompt glyph (chevron + line). Next already
  emits it as the favicon (`/icon.svg` route) — reused as the artwork basis.
- No `public/`, no manifest, no service worker existed before this change.
- `next.config.ts` proxies `/api/:path*` to the gateway (same-origin for the
  browser) and there is a live WebSocket at `/attach`. The SW must never touch
  either.
- `Providers` (`src/components/providers.tsx`, a `"use client"` component)
  wraps the whole tree (login gate + terminal) — the natural mount point for a
  client-only SW registrar.
- Design tokens / palette from `DESIGN.md`: warm canvas `#2b2622`, ink
  `#f7f5f0`, canvas-soft `#383330`, body `#c9c0ad`; tight radii (3–4px);
  lucide-react icons at `size-3.5`; `@sparklab/ui` primitives.

---

## 1. Architectural decisions

- **D1 — Manifest via App Router native `app/manifest.ts`.** Return a
  `MetadataRoute.Manifest`; Next emits `/manifest.webmanifest` and injects
  `<link rel="manifest">`. No hand-written JSON, type-checked at build.
- **D2 — Offline is _deliberately_ minimal; only the app shell is cacheable.**
  A terminal is raw bytes over a WebSocket plus a REST control surface — none of
  it is meaningfully cacheable and serving any of it stale would be actively
  wrong (a cached `/api/sessions` list, a replayed screen). So the SW caches
  **only** (a) a static offline fallback page and (b) immutable Next build
  assets. It **never** caches `/api/*`, the dynamic root document, or anything
  cross-origin. The `/attach` WebSocket is a non-issue: service workers do not
  intercept WS upgrades, so `fetch` never fires for it — but the `/api/*`
  early-return is the load-bearing bypass and is asserted explicitly in the SW.
- **D3 — Hand-written service worker, no `next-pwa`/Workbox.** Matches the
  repo's dependency-minimal ethos (the gateway is plain JS by design). The SW is
  ~90 lines of vanilla `ServiceWorkerGlobalScope` code with no build step.
- **D4 — A dedicated maskable icon, not "the favicon with padding".** The
  existing `icon.svg` has rounded corners and transparent margins — wrong for
  Android adaptive icons, whose mask carves the shape and would clip ragged
  corners. The maskable variant is a **full-bleed square** `#2b2622` fill with
  the glyph scaled into the **safe zone** (~62% centered). Kept as a **separate**
  manifest entry (`purpose: "maskable"`) from the `purpose: "any"` icons — never
  `"any maskable"` on one file.
- **D5 — Prod-only SW registration.** Registered from a client component guarded
  on `process.env.NODE_ENV === "production"` + `"serviceWorker" in navigator`. A
  dev-registered SW caching `/_next/static` would poison `next dev` sessions.
- **D6 — Static offline shell legitimately inlines hex.** The
  "use theme tokens, never hardcode hex" rule targets React components that have
  Tailwind tokens available. `public/offline.html` is a standalone static file
  with no Tailwind and must be fully self-contained (no external fonts/assets or
  it won't render offline), so it inlines `#2b2622`/`#f7f5f0` and a system font
  stack by necessity. Not a rule violation.

---

## 2. Web app manifest (`src/app/manifest.ts`)

`MetadataRoute.Manifest` with:

| Field                              | Value                                        | Why                                                                                     |
| ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `name`                             | `Sparklab Terminal`                          | Full install name.                                                                      |
| `short_name`                       | `Terminal`                                   | Home-screen label (fits under an icon).                                                 |
| `description`                      | `Web terminal with persistent tmux sessions` | Matches `<meta>`.                                                                       |
| `start_url`                        | `/`                                          | The app entry (auth gate → terminal).                                                   |
| `display`                          | `standalone`                                 | Chromeless app window.                                                                  |
| `orientation`                      | `any`                                        | A terminal must never lock rotation.                                                    |
| `theme_color` / `background_color` | `#2b2622`                                    | Warm canvas; matches `viewport.themeColor` so OS chrome + splash match the app exactly. |
| `icons`                            | 192 (any), 512 (any), 512 (maskable)         | See §3.                                                                                 |

## 3. Icons

Rasterized from SVG with `cairosvg` (available in the local Python env; SVG→PNG
with no runtime dep added), dimensions verified with PIL. Sources for the two
new SVGs are documented inline below so they can be regenerated.

| File                                 | Size    | Purpose                                                                  | Source                                |
| ------------------------------------ | ------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `public/icons/icon-192.png`          | 192×192 | manifest `any`                                                           | existing `icon.svg` (rounded)         |
| `public/icons/icon-512.png`          | 512×512 | manifest `any`                                                           | existing `icon.svg` (rounded)         |
| `public/icons/icon-maskable-512.png` | 512×512 | manifest `maskable`                                                      | full-bleed square, glyph in safe zone |
| `src/app/apple-icon.png`             | 180×180 | iOS touch icon (App Router auto-injects `<link rel="apple-touch-icon">`) | full-bleed square, normal glyph       |

The favicon stays the existing `app/icon.svg` route — no `app/icon.png` added
(the SVG already covers it). The apple-touch and maskable icons are full-bleed
squares (no `rx`, no transparency) because iOS applies its own corner rounding
and Android applies its own mask; a transparent/rounded source would clip badly.

Maskable source (rasterized at 512): full `#2b2622` rect, glyph group
`translate(48,48) scale(13)` so the ~15×11-unit glyph lands centered well inside
the safe zone (farthest corner ≈120px from center vs the ≈205px safe radius).
Apple source: `icon.svg` with `rx` removed (full-bleed square) and the
original-scale glyph.

Regenerate — the two square SVG sources:

```xml
<!-- maskable (rasterize at 512) -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#2b2622"/>
  <g transform="translate(48,48) scale(13)" fill="none" stroke="#f7f5f0"
     stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 11l5 5-5 5"/>
    <line x1="15.5" y1="22" x2="23" y2="22"/>
  </g>
</svg>

<!-- apple touch (rasterize at 180): icon.svg with rx removed -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" fill="#2b2622"/>
  <path d="M8 11l5 5-5 5" fill="none" stroke="#f7f5f0" stroke-width="2.5"
        stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="15.5" y1="22" x2="23" y2="22" stroke="#f7f5f0" stroke-width="2.5"
        stroke-linecap="round"/>
</svg>
```

then rasterize with `cairosvg` (verify each with PIL): `icon.svg` → 192/512
(`any`), maskable SVG → 512 (`maskable`), apple SVG → `src/app/apple-icon.png`
at 180.

## 4. Apple / iOS metadata (`src/app/layout.tsx`)

Added `appleWebApp` to `metadata` — **not** duplicating what `viewport` already
covers (theme color, viewport-fit):

- `capable: true` — launches full-screen from the home screen.
- `title: "Terminal"` — home-screen title.
- `statusBarStyle: "black-translucent"` — status bar sits over the warm canvas.

Also added `applicationName` and a `metadataBase`
(`process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"`) to silence
Next's "resolving metadata without a base URL" warning and anchor the manifest/
icon absolute URLs. The existing `viewport` export and its mobile-UX comments
are untouched.

## 5. Service worker (`public/sw.js`) + registration

**Caching strategy (versioned cache `sparklab-terminal-v1`):**

- `install` → precache **only** `/offline.html`; `skipWaiting()`.
- `activate` → delete any cache whose name ≠ the current version;
  `clients.claim()`. (So bumping `CACHE_VERSION` when `offline.html` or the SW
  changes evicts the stale shell — no permanently-stale offline page.)
- `fetch`:
  - Non-GET / cross-origin → **passthrough** (no `respondWith`).
  - `/api/*` → **passthrough** (load-bearing bypass; gateway REST + WS proxy
    never cached or served stale).
  - Navigations (`request.mode === "navigate"`) → **network-first**, fall back
    to `/offline.html` only when the network is unreachable. The dynamic root
    document is never precached.
  - `/_next/static/*` (hashed, immutable) → **cache-first** (fast, installable
    shell).
  - Everything else → **passthrough**.

**Registration** — `src/components/service-worker-register.tsx`, a client
component rendering `null`, mounted inside `Providers`. Guarded to production +
`"serviceWorker" in navigator`; registers `/sw.js` after `load` so it never
competes with first paint or the terminal attach. Registration failure is
swallowed (the app works fine without the SW).

## 6. Install affordance (`src/components/install-prompt.tsx`) — shipped

An unobtrusive, dismissible "Install app" pill:

- Listens for `beforeinstallprompt` (Android/desktop Chromium); calls
  `preventDefault()` and stashes the event, then shows the pill. iOS has no such
  event (Safari installs via the Share sheet), so it simply never appears there.
- Anchored **bottom-left** (`fixed bottom-4 left-4`) — the agent FAB owns
  bottom-right, so no collision.
- Styled per `DESIGN.md`: `bg-card` / `border-border` / theme tokens,
  `@sparklab/ui` `Button`, lucide `Download` + `X` at `size-3.5`, tight radius.
- Dismissal persists in `localStorage` (`sparklab.installPrompt.dismissed`) so
  it never nags; also hides on `appinstalled`.
- Mounted in `Providers` alongside the SW registrar.

---

## 7. Files added / changed

**Added**

- `apps/terminal/src/app/manifest.ts` — web app manifest route.
- `apps/terminal/src/app/apple-icon.png` — 180×180 iOS touch icon.
- `apps/terminal/public/icons/icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` — manifest icons.
- `apps/terminal/public/sw.js` — service worker.
- `apps/terminal/public/offline.html` — offline fallback shell.
- `apps/terminal/src/components/service-worker-register.tsx` — prod-only SW
  registrar.
- `apps/terminal/src/components/install-prompt.tsx` — install affordance.
- `docs/PWA-PLAN.md` — this doc.

**Changed**

- `apps/terminal/src/app/layout.tsx` — `appleWebApp`, `applicationName`,
  `metadataBase` in `metadata` (viewport untouched).
- `apps/terminal/src/components/providers.tsx` — mount
  `<ServiceWorkerRegister />` + `<InstallPrompt />`.
- `apps/terminal/eslint.config.mjs` — ignore `public/**` (static assets incl.
  the SW, which uses service-worker globals ESLint's default env doesn't know).

---

## 8. Deliberately out of scope (post-v1)

- **Precaching the app shell for full offline use.** The app is useless without
  the gateway (live sessions), so offline shows the fallback rather than a dead
  shell. Precaching hashed JS/CSS is handled opportunistically (cache-first on
  `/_next/static`), not via a generated precache manifest.
- **Background sync / push notifications** (e.g. "your job finished"). A natural
  future fit given persistent jobs, but requires gateway + VAPID work.
- **A richer install education flow / A2HS coaching on iOS** (Share-sheet
  instructions). The affordance is Chromium-only by design.
- **Screenshots / `shortcuts` in the manifest** (richer install UI on some
  platforms).
- **Periodic SW update prompts** ("a new version is available — reload"). The
  SW uses `skipWaiting` + `clients.claim`, so updates apply on next load; an
  explicit update toast is deferred.

---

## Critical files

- `apps/terminal/src/app/manifest.ts` — manifest
- `apps/terminal/public/sw.js` — service worker (caching strategy + bypasses)
- `apps/terminal/public/offline.html` — offline fallback shell
- `apps/terminal/src/components/service-worker-register.tsx` — SW registration
- `apps/terminal/src/components/install-prompt.tsx` — install affordance
- `apps/terminal/src/app/layout.tsx` — Apple/iOS metadata + metadataBase
