# Multi-window terminal display — Design & Implementation Plan

> Status: **design, not started** (2026-08-27). Scope: show **2–4 terminal
> sessions side by side** in the main terminal viewport as a preset grid with
> draggable split handles, click-to-focus, and all existing session-scoped UI
> (header, footer/git, file explorer, agent target, connection status) bound to
> the **focused pane**. Desktop-only. Store-persisted layout. No recursive
> tiling, no per-pane deep-link, no mobile in v1.

Today the terminal viewport renders exactly one `<DynamicXTerm sessionId={activeSessionId}>`.
This feature lets the user split that region into up to four independent panes,
each attached to its own session, without touching the three-lifetimes model,
the raw-bytes pipeline, or the reconnect logic.

---

## 0. Grounding (verified against source)

- **Single-pane render site:** `apps/terminal/src/features/terminal/components/terminal-shell.tsx:~470`
  — the `activeSessionId ? <DynamicXTerm …/> : <emptyState/>` block inside
  `<div className="relative min-h-0 flex-1 overflow-hidden" ref={termContainerRef}>`.
  Siblings in that container: `<BrowserViewOverlay/>`, the `reconnecting`
  overlay, the `activeServerUnreachable` overlay, `<AgentActivityOverlay
activeSessionId={…}/>`, `<AgentFab/>`, `<TerminalSwitcher/>`.
- **`XTermComponent` is already a self-contained, StrictMode-safe unit**
  (`components/xterm.tsx`): one `Terminal` + `FitAddon` + `ResizeObserver` +
  WebGL addon created in a one-shot `useEffect([])`; the cleanup fully disposes
  the `Connection`, all xterm disposables, the RO, and the terminal. A second
  `useEffect([sessionId])` swaps the `Connection` imperatively — **the terminal
  is never remounted on session switch**. Mounting/unmounting the _whole_
  component is the tested StrictMode path.
- **`Connection` (`connection.ts`) owns one WS** to
  `${NEXT_PUBLIC_GATEWAY_URL}/attach?session=<id>`, its reconnect/backoff,
  heartbeat, and scrollback fetch+inject. Its module doc asserts "exactly ONE
  connection is live at a time" — that is a statement about **one
  `XTermComponent`**, not a global; N independent instances each owning one WS
  is fine, and cross-tab multi-viewing of one session is already supported
  (DESIGN-SYSTEM.md goal 3).
- **`activeSessionId` / `setActiveSessionId`** (`store.ts`) is read by: the
  shell header (name, org/project crumbs), `TerminalFooter` (git),
  `FileExplorerDialog`, `SettingsDialog` (session count is separate),
  `AgentActivityOverlay`, `TerminalSwitcher`, `useSessionUrlSync` (`?session=`),
  the vanish-fallback effect, and the auto-expand-ancestors effect. **Redefining
  it as "the focused pane's session" keeps every one of these working
  untouched.**
- **Focus restoration is fragile** (`terminal-shell.tsx` `handleDialogClose`):
  it reads `termContainerRef.current?.firstElementChild` and calls a
  `__termFocus` closure stashed on that div by `XTermComponent`'s effect;
  fallback is `termContainerRef.current?.querySelector(".xterm-helper-textarea")`.
  With a grid wrapper as `firstElementChild`, `__termFocus` is `undefined` and
  the fallback grabs the **first xterm in DOM order** — see D6.
- **`terminalHandleRef`** (a single `useRef<TerminalHandle|null>` in the shell)
  is handed to `XTermComponent`, which does `handleRef.current = {…}` on mount
  and `= null` on cleanup. It feeds `ExtraKeysBar` and `TerminalSwitcher`
  focus. One shared ref + N panes = last-mount-wins and any-unmount-nulls — see
  D6.
- **`modifiersRef`** (sticky Ctrl/Alt) is likewise shared; it only matters for
  the pane receiving keystrokes, so a single shared ref is fine (D6).
- **tmux sizing:** sessions are created `window-size latest` +
  `aggressive-resize on` (DESIGN-SYSTEM.md → "Resize with multiple viewers"),
  i.e. tmux follows the **most recently active client**. Two panes showing the
  **same** session at **different** sizes → tmux tracks whichever resized last,
  the other redraws at the wrong width (D4).
- **Resize path, per pane:** `ResizeObserver` → `fitAddon.fit()` →
  `term.onResize` → `connection.sendResize()` (a JSON `{type:"resize",cols,rows}`
  frame). There is **no debounce** today — fine for one-off window resizes,
  a problem for a divider drag (D5).
- **Vanish-fallback** is the pure `resolveActiveSession(sessionsLoaded,
sessions, activeSessionId)` in `session-fallback.ts`; its contract is "fall
  back to `sessions[0]`". Running it per-pane collapses every pane onto
  `sessions[0]` (D7).
- **Persistence** (`store.ts` `persist`): `partialize` allow-lists
  `activeSessionId`, `recentSessionIds`, `sidebarCollapsed`,
  `terminalFontSize`, `collapsedGroups`. `onRehydrateStorage` runs
  `normalizeSessionRef` on `activeSessionId` (bare `web-…` → `local/web-…`).
- **Mobile gate:** `useMediaQuery("(max-width: 767px)")` → `isMobile`; the
  inline sidebar is unmounted and replaced by a `Sheet` on mobile. Same gate
  will force single-pane (D9).
- **`@sparklab/ui`** ships `button dialog dropdown-menu tooltip separator
sheet scroll-area alert-dialog input label` — **no** resizable-panel
  primitive. No `react-resizable-panels` / `allotment` / `react-split` in
  `apps/terminal/package.json` or the lockfile (D3).
- **E2E assumptions** (`apps/e2e/specs/`): `gate-6` uses
  `.locator(".xterm-helper-textarea")` (unqualified), `gate-8` uses
  `.locator(".xterm").first()` and `document.querySelectorAll(".xterm-rows >
div")`, `strictmode-check` asserts a session has **exactly 1** tmux client.
  All run against the **default single-pane** UI and stay valid; grid is opt-in
  (D10).

---

## 1. Architectural decisions

### D1 — Reuse `XTermComponent` verbatim as the per-pane unit

Each pane renders one `<DynamicXTerm sessionId={pane.sessionId}>`. The component
is already self-contained (own Terminal/Connection/FitAddon/RO/WebGL) and its
cleanup fully disposes everything, so N-on-screen is just "mount N of the tested
StrictMode-safe unit." **No changes to `xterm.tsx`'s lifecycle**; the only
edits it needs are cosmetic (accepting a `paneId` to register its handle — D6).

- _Rejected:_ one `Terminal` with N `Connection`s multiplexed onto it — xterm
  can't render N grids in one instance; would require N terminals anyway.
- _Rejected:_ an `<iframe>` per pane — kills the shared React tree, the store,
  and the raw-bytes `TextEncoder` path.

### D2 — Preset layouts, capped at 4 panes; no recursive tiling

v1 layouts: `single` (default, today's UI verbatim), `cols-2`, `rows-2`,
`cols-3`, `grid-2x2`. A pane count of 4 is the cap: each pane holds a live WS +
an xterm canvas + (ideally) a WebGL context; browsers cap WebGL contexts
(~16 in Chrome, lower on some GPUs) and each xterm is a few MB. Four is
comfortably safe and matches the useful screen budget on a laptop.

- _Rejected for v1:_ i3/tmux-style arbitrary recursive splits — a much larger
  state model (binary split tree), drag-to-reparent, and serialization; not
  justified before we see whether users want more than a 2×2.

### D3 — Hand-rolled `<ResizableSplit>`; no new dependency

A `<ResizableSplit direction axis panes onRatiosChange>` component: flex
children with `flex-basis` from a ratio array, a `role="separator"` divider
with `aria-orientation` / `aria-valuenow` / `aria-valuemin/max`, pointer-drag
(pointer capture, `pointermove` → clamp → `onRatiosChange`), and
Arrow-key/Home/End resize for a11y (this repo does bother — `aria-label` on
every icon button, `sr-only` sheet titles). Budget ~120 lines incl. a11y.
`grid-2x2` composes two of them (one row-split of two col-splits). Ratios are
clamped to a `MIN_PANE_PX` (≈ 240px ≈ 30 cols) so a pane can't collapse to
unusable.

- _Alternative:_ `react-resizable-panels` (~10 KB, shadcn's choice, handles
  nested groups + persistence). Take it **only** if the a11y hand-roll proves
  worse than the dep during build; decide then, note the swap here.

### D4 — A session may appear in at most one pane of the grid

The pane session-picker greys out any session already shown in another pane
(same treatment `TerminalSwitcher` gives the current session). Reason: it only
breaks on **asymmetric** splits — `window-size latest` makes tmux follow
whichever pane last resized, so the other pane's xterm renders at a size tmux
isn't drawing for (wrapping / truncation / stale redraw). A symmetric grid
would actually be fine, but "sometimes allowed" is a worse rule than "never,"
and two visibly-wrong panes side by side reads as a bug. **Cross-tab
multi-viewing of one session stays supported** (unchanged, and there the broken
pane isn't sitting next to the good one). Mirroring in a symmetric grid is a
deferred item (§8), not an omission.

### D5 — Coalesce resize frames during a divider drag

`sendResize` must not fire per `pointermove`. During an active drag,
`<ResizableSplit>` sets a "dragging" flag; each affected `XTermComponent`
coalesces `fitAddon.fit()` to one call per animation frame and **defers
`connection.sendResize()` to `pointerup`** (rAF-throttled `fit()` keeps the
local grid responsive; the gateway/tmux/ssh only hears the final size). Without
this, a two-pane drag is a continuous stream of `tmux resize-window` — over SSH
for remote sessions — and is the most likely source of jank + gateway load in
the whole feature.

Implementation seam: a `resizeCoalesced?: boolean` prop on `XTermComponent`
(or a small context the grid provides) that switches the existing RO handler
between "fit + sendResize now" and "rAF fit, sendResize on drag-end."

### D6 — Per-pane handle registry replaces the single shared ref + `__termFocus`

Add to the shell a `paneHandlesRef = useRef<Map<string, TerminalHandle>>(new
Map())`. `XTermComponent` gains a `paneId` prop and registers/unregisters
itself in that map (via a small `onRegisterHandle(paneId, handle | null)`
callback prop) instead of writing a single `handleRef.current`.

- `handleDialogClose` focuses `paneHandlesRef.current.get(focusedPaneId)?.focus()`.
- `ExtraKeysBar` and `TerminalSwitcher` are handed the **focused** pane's
  handle (looked up on each render from `focusedPaneId`).
- The `__termFocus`-on-`firstElementChild` mechanism is **removed** as part of
  this change — it was always a hack and cannot survive a wrapper element.
- `modifiersRef` stays a single shared ref: only the focused pane receives
  keystrokes, so sticky Ctrl/Alt has exactly one consumer at a time.

In `single` mode there is one pane, so the map has one entry and behavior is
identical to today.

### D7 — Grid-aware pane resolver, alongside `session-fallback.ts`

New pure, unit-tested `resolvePaneSessions(sessionsLoaded, sessions,
paneSessionIds: (string|null)[]): (string|null)[] | undefined`:

- returns `undefined` while `!sessionsLoaded` (same load-gate reason as
  `resolveActiveSession`);
- drops any pane id not in `sessions`;
- **dedupes** — if two panes resolved to the same id, later panes become
  `null`;
- prefers leaving a pane **empty** over auto-filling a duplicate; only the
  _focused_ pane, if empty after resolution, falls back to
  `sessions[0]` (so the app is never in a "no focused session" state when
  sessions exist — preserving today's guarantee).

`setActiveSessionId(id)` writes `id` into the **focused** pane (and, per D4,
clears that id from any other pane that held it).

### D8 — `?session=` continues to mean "the focused pane's session"

`useSessionUrlSync` is unchanged: URL → focused pane on mount, focused pane →
URL thereafter. The full grid (mode + per-pane ids + split ratios +
focusedPaneId) is **store-persisted only** in v1. A `?panes=` /
`?layout=` deep-link is deferred (§8) — calling it out here so the
`?session=`-only behavior reads as a decision.

### D9 — Grid is desktop-only; mobile force-collapses to the focused pane

Reuse the `isMobile` (`max-width: 767px`) gate. On mobile the shell renders a
single `<DynamicXTerm sessionId={focusedPaneSessionId}>` regardless of stored
`layout.mode`; the layout is retained in the store and re-expands when the
viewport grows. Same pattern as the sidebar's mobile collapse.

### D10 — Grid is opt-in; default UI and E2E stay single-pane

Default `layout.mode` is `single`, which renders the **exact** current subtree
(one `<DynamicXTerm>` + the existing overlays), so the header/footer/overlays
and every current E2E gate are pixel- and selector-identical. Multi-pane markup
adds `data-pane-id` on each pane wrapper and `data-testid="terminal-pane"` for
future grid E2E; `strictmode-check` stays valid (each pane is a distinct
session with 1 client each).

### D11 — Per-pane chrome only in multi-pane mode

In `single` mode the app header is the only chrome (unchanged). In multi-pane
mode each pane gets a slim (~26px) top strip: focus affordance + session name +
status dot + a session-picker dropdown (`DropdownMenu`, greys out
already-shown sessions per D4) + a close-pane button. `text-xs`,
`text-muted-foreground`, `border-border`; the focused pane's strip and a 1px
inset ring use `border-ring` / `bg-accent`. No new iconography beyond
`lucide-react` (`Columns2`, `Rows2`, `Columns3`, `LayoutGrid`, `X`,
`ChevronsUpDown`).

---

## 2. State — `store.ts`

New slice (persisted like `sidebarCollapsed`):

```ts
export type LayoutMode = "single" | "cols-2" | "rows-2" | "cols-3" | "grid-2x2";
export const PANE_COUNT: Record<LayoutMode, number> = {
  single: 1,
  "cols-2": 2,
  "rows-2": 2,
  "cols-3": 3,
  "grid-2x2": 4,
};

interface PaneState {
  id: string; // stable nanoid — NEVER the array index (D-note)
  sessionId: string | null;
}

interface LayoutSlice {
  layout: {
    mode: LayoutMode;
    panes: PaneState[]; // length === PANE_COUNT[mode]
    focusedPaneId: string; // always one of panes[].id
    ratios: number[]; // split ratios; shape depends on mode
  };
  setLayoutMode: (mode: LayoutMode) => void; // grows/shrinks panes[], auto-fills new panes from recentSessionIds minus already-shown, preserves focus if still present
  focusPane: (paneId: string) => void; // also mirrors to activeSessionId via the selector below
  setPaneSession: (paneId: string, sessionId: string | null) => void; // enforces D4 (clear elsewhere)
  closePane: (paneId: string) => void; // drops to the next-smaller sensible mode
  setРatios: (ratios: number[]) => void;
}
```

**`activeSessionId` migration.** Keep the field and setter names. Redefine:

```ts
// getter: focused pane's session
get activeSessionId() {
  return state.layout.panes.find(p => p.id === state.layout.focusedPaneId)?.sessionId ?? null;
}
setActiveSessionId: (id) => setPaneSession(state.layout.focusedPaneId, id)
```

(Zustand has no real getters — implement as a `activeSessionId` value kept in
sync inside `setPaneSession` / `focusPane` / `setLayoutMode`, or expose a
`useActiveSessionId()` selector hook and codemod the ~10 call sites. The
sync-on-write approach is smaller and keeps external consumers literally
unchanged — prefer it.)

**`partialize`:** add `layout`. **`onRehydrateStorage`:** run
`normalizeSessionRef` over every `layout.panes[].sessionId` (same as the
existing `activeSessionId` line), and defensively clamp `panes.length` to
`PANE_COUNT[mode]`.

**Vanish-fallback effect** (`terminal-shell.tsx`): replace the
`resolveActiveSession` call with `resolvePaneSessions` (D7); on a non-`undefined`
result, write the corrected id array back through a new
`store.reconcilePanes(ids)` action.

---

## 3. Frontend components

```
components/
  terminal-grid.tsx     NEW  — reads layout slice; renders <ResizableSplit> tree of <TerminalPane>
  terminal-pane.tsx     NEW  — one pane: slim chrome (multi-pane only) + <DynamicXTerm> + per-pane status overlay + focus ring; click → focusPane
  resizable-split.tsx   NEW  — D3 primitive (or swap for react-resizable-panels)
  layout-menu.tsx       NEW  — header popover: the 5 presets as little glyph buttons
  xterm.tsx             EDIT — add `paneId`, `onRegisterHandle`, `resizeCoalesced` props (lifecycle untouched)
  terminal-shell.tsx    EDIT — swap the single <DynamicXTerm> block for <TerminalGrid>; paneHandlesRef; focus/switcher/extra-keys wiring; move status to per-pane
```

### 3a. `terminal-shell.tsx` changes (surgical)

- Replace the `activeSessionId ? <DynamicXTerm…/> : <emptyState/>` block with
  `<TerminalGrid paneHandlesRef={paneHandlesRef} onPaneStatus={handlePaneStatus} … />`.
  The empty state moves **into** a pane (a pane with `sessionId === null` shows
  "Pick a session").
- `status` state becomes `Record<paneId, {state,text}>`; the **header dot** and
  the Settings → Connection tab read `statusByPane[focusedPaneId]`. Per-pane
  chrome reads its own. One rule: **session-scoped UI follows focus.**
- `handleDialogClose` → `paneHandlesRef.current.get(focusedPaneId)?.focus()`.
- `handleSwitcherSelect` → `setPaneSession(focusedPaneId, id)` (D7/D4 handle the
  rest); switcher's "already shown" greying uses `layout.panes`.
- The `reconnecting` / `activeServerUnreachable` overlays move from the viewport
  container into `<TerminalPane>` (each pane computes its own `server` +
  `unreachable` from its `sessionId`).
- `<BrowserViewOverlay/>`, `<AgentFab/>`, `<TerminalSwitcher/>` stay at the
  viewport-container level (they're grid-global).
- `<AgentActivityOverlay/>`: pass it `focusedPaneSessionId` **and** the grid
  geometry so it can highlight the _specific_ pane whose session the agent is
  driving; if the agent's target isn't in any pane, it renders a header-level
  "agent active in <name>" chip instead of an overlay. (Minimal v1: keep it
  overlaying the focused pane and only when the agent target === focused
  session; full per-pane targeting is a small follow-up.)
- Auto-expand-ancestors effect: run it for the **focused** pane's
  org/project/server (unchanged inputs, just sourced from the focused pane).

### 3b. `terminal-pane.tsx`

```
<div data-testid="terminal-pane" data-pane-id={pane.id}
     className={cn("relative flex min-h-0 min-w-0 flex-col",
                   focused && "ring-1 ring-ring ring-inset")}
     onPointerDownCapture={() => focusPane(pane.id)}>
  {multiPane && <PaneChrome …/>}         {/* name · status dot · session dropdown · X */}
  <div className="relative min-h-0 flex-1">
    {pane.sessionId
      ? <DynamicXTerm sessionId={pane.sessionId} paneId={pane.id}
                      onRegisterHandle={registerHandle}
                      onStatusChange={(s,t)=>onPaneStatus(pane.id,s,t)}
                      resizeCoalesced={dragging} … />
      : <PickSessionPlaceholder onPick={(id)=>setPaneSession(pane.id,id)} />}
    <PaneReconnectingOverlay …/>  <PaneUnreachableOverlay …/>
  </div>
</div>
```

`onPointerDownCapture` (not `onClick`) so focus tracks before xterm's own
mousedown handling; xterm's textarea focus then makes it the keystroke target
naturally.

### 3c. `terminal-grid.tsx`

Pure layout from `layout.mode`:

| mode       | tree                                                           |
| ---------- | -------------------------------------------------------------- |
| `single`   | `<TerminalPane pane={panes[0]}/>` (no split, no chrome)        |
| `cols-2`   | `<ResizableSplit axis="x" ratios=[r,1-r]>` 2 panes             |
| `rows-2`   | `<ResizableSplit axis="y">` 2 panes                            |
| `cols-3`   | `<ResizableSplit axis="x" ratios=[a,b,c]>` 3 panes             |
| `grid-2x2` | `<ResizableSplit axis="y">` of two `<ResizableSplit axis="x">` |

`dragging` state (from `<ResizableSplit>` callbacks) is threaded to panes for
D5. Ratios persist via `setRatios` on drag-end.

---

## 4. Interaction with existing features

| Feature                           | Behavior in grid mode                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| Header title / org-project crumbs | Focused pane's session (`activeSessionId` unchanged)                               |
| `TerminalFooter` (git)            | Focused pane's session (unchanged)                                                 |
| `FileExplorerDialog`              | Focused pane's session + its server (unchanged)                                    |
| `SettingsDialog` Connection tab   | Focused pane's status; session **count** is grid-wide (unchanged)                  |
| Connection status dot (header)    | Focused pane's status                                                              |
| `TerminalSwitcher` (⌘⇧O)          | Selects into the focused pane; greys sessions shown in other panes                 |
| `AgentActivityOverlay`            | Highlights the pane showing the agent's target session; header chip if not visible |
| Agent target session              | Still "the selected session" = focused pane (agent-service unchanged)              |
| `BrowserViewOverlay`              | Grid-global, covers the whole viewport (unchanged)                                 |
| `ExtraKeysBar`                    | Types into the focused pane's handle                                               |
| Push notifications                | Gateway-side, unaffected                                                           |
| Mobile                            | Force single-pane (D9)                                                             |

---

## 5. Phased implementation checklist

1. **Store slice + resolver.** `layout` slice, `PANE_COUNT`, `setLayoutMode`
   auto-fill, `setPaneSession` D4 enforcement, `activeSessionId` sync-on-write,
   `partialize` + `onRehydrateStorage`. New `resolvePaneSessions` +
   `reconcilePanes`. Unit tests for the resolver (dedupe, empty-over-duplicate,
   focused-pane fallback, load-gate) and the slice (mode grow/shrink, D4
   clear-elsewhere).
2. **`<ResizableSplit>`** (D3) with a11y + `dragging` callback. Unit test the
   clamp math; jsdom pointer-drag test.
3. **`xterm.tsx` props** — `paneId`, `onRegisterHandle`, `resizeCoalesced`.
   RO handler branches on `resizeCoalesced`. No lifecycle change; existing
   `xterm`/StrictMode behavior must stay identical for `single`.
4. **`<TerminalPane>` + `<TerminalGrid>`** — render tree, per-pane chrome,
   per-pane status/overlays, focus ring, `data-*` hooks.
5. **`terminal-shell.tsx` rewire** — `paneHandlesRef`, swap render block,
   per-pane `status`, `handleDialogClose` / switcher / extra-keys via focused
   handle, retire `__termFocus`. Overlays relocated.
6. **`<LayoutMenu>`** header control + the 4 new lucide glyphs; `?` no URL flag
   in v1.
7. **Mobile collapse** (D9) — `isMobile` short-circuits `<TerminalGrid>` to one
   pane.
8. **Typecheck + lint + `pnpm --filter @sparklab/terminal test`**; run the full
   E2E suite to prove single-pane is byte-identical (D10).

---

## 6. Testing

- **Unit (`apps/terminal/src/features/terminal/__tests__/`):**
  `resolve-pane-sessions.test.ts`, `store-layout.test.ts`,
  `resizable-split.test.ts`, plus a `terminal-pane.test.tsx` for
  focus-on-pointerdown + chrome-only-in-multi-pane.
- **Existing gates:** run `apps/e2e` unchanged — every current gate targets the
  default `single` layout and must stay green (the acceptance criterion for
  D10). `strictmode-check` still asserts 1 client/session.
- **New E2E (`gate-10-multi-window.spec.ts`, optional in v1):** open
  `cols-2`, attach two sessions, assert two `[data-testid=terminal-pane]` each
  with a live `.xterm`, type into pane B and assert only B's tmux received it,
  drag the divider and assert exactly **one** `resize` frame per pane
  (`pointerup`, not per move — D5), close a pane → back to `single`.
- **Manual:** 2×2 with one remote (SSH) session — divider drag must not lag;
  focused-pane switching must move the footer git summary and the file-explorer
  scope; agent typing must highlight the right pane.

---

## 7. Deliberately deferred (post-v1)

- **Recursive / arbitrary tiling** (split-tree model, drag-to-reparent).
- **`?panes=` / `?layout=` deep-link** and shareable grid URLs (v1:
  store-persist only; `?session=` = focused pane).
- **Same session mirrored in a symmetric grid** (D4) — needs a per-pane
  `resize` opt-out or a "viewer" attach mode on the gateway.
- **Mobile multi-pane** (swipe-between-panes carousel).
- **Drag a session from the sidebar onto a pane** to attach it.
- **Named / saved layout presets** ("dev", "logs+editor").
- **Per-pane font size / theme.**
- **Full per-pane agent attribution** (v1: focused pane / header chip only).
- **Zoom / temporarily-maximize a pane** (⌘⏎ toggle).

---

## 8. Open decisions worth confirming before build

1. **`activeSessionId` — sync-on-write vs. selector-hook codemod.** Plan
   assumes sync-on-write (smaller, zero external churn). Confirm we're OK
   keeping a denormalized mirror in the store.
2. **`<ResizableSplit>` hand-roll vs. `react-resizable-panels`** (D3). Default:
   hand-roll. Flip if the a11y work outweighs a 10 KB dep.
3. **New-pane auto-fill.** Plan: fill from `recentSessionIds` minus
   already-shown, else leave empty. Alternative: always leave new panes empty
   (more explicit, less magic).
4. **Pane cap.** 4 (`grid-2x2`). Raise to 6 (`cols-3` × 2 rows) later or hold
   at 4?
5. **Close-pane target mode.** From `grid-2x2` closing one pane → `cols-3`? or
   `rows-2` + `single` stack? Plan: drop to the next mode that fits the
   remaining count, focus preserved.
6. **Keyboard pane navigation.** Add `⌘⌥←/→/↑/↓` to move focus between panes in
   v1, or rely on click + the existing switcher?

---

## Critical files

- `apps/terminal/src/features/terminal/store.ts` — layout slice, `activeSessionId` redefinition, persistence.
- `apps/terminal/src/features/terminal/components/terminal-shell.tsx` — swap render block, `paneHandlesRef`, per-pane status, focus/switcher/extra-keys rewire, overlay relocation.
- `apps/terminal/src/features/terminal/components/xterm.tsx` — `paneId` / `onRegisterHandle` / `resizeCoalesced` props (lifecycle untouched).
- `apps/terminal/src/features/terminal/components/terminal-grid.tsx` · `terminal-pane.tsx` · `resizable-split.tsx` · `layout-menu.tsx` — NEW.
- `apps/terminal/src/features/terminal/session-fallback.ts` — sibling `resolve-pane-sessions.ts` (NEW).
- `apps/terminal/src/features/terminal/connection.ts` — **unchanged** (each pane owns one `Connection`; verify no hidden global assumptions).
- `apps/terminal/src/features/agent-chat/components/agent-activity-overlay.tsx` — pane-aware targeting (minimal v1 change).
- `apps/e2e/specs/` — new `gate-10-multi-window.spec.ts`; confirm gates 1–9 + strictmode stay green.
