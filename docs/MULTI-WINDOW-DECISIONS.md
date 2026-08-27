# Multi-window terminal display — §8 open-decision resolutions

Resolves the six open decisions in `docs/MULTI-WINDOW-PLAN.md` §8, plus the
store-layer implementation notes needed by FE (phase 2+) and BE. This phase
(SA, §5.1 — store/types foundation) touched only `store.ts`, the new
`resolve-pane-sessions.ts` + its test, `__tests__/store-layout.test.ts`, and
(as a required consequence, not scope creep) `__tests__/store-persist.test.ts`,
whose exact-match `partialize` assertion needed the new `layout` key added to
stay green.

## §8 resolutions

1. **`activeSessionId` — sync-on-write mirror.** Implemented exactly as the
   plan describes: `activeSessionId` stays a real top-level field, recomputed
   by every layout-mutating action (`deriveActiveSessionId(layout)`) rather
   than a derived selector. This keeps every existing call site (`store.ts`
   §"Grounding" lists ~10 across the app) byte-identical — same field name,
   same setter signature, same plain-field read pattern.

2. **`<ResizableSplit>` — hand-rolled (D3).** Not built in this phase; the
   store's `layout.ratios` shape (documented in `store.ts` above
   `defaultRatios`) is deliberately generic enough for a hand-rolled
   flex-basis + pointer-drag primitive to consume directly, with no
   dependency on any specific split-library's ratio convention.

3. **New-pane auto-fill.** `setLayoutMode` fills newly added panes from
   `recentSessionIds`, most-recent first, skipping any id already shown in
   another pane; once `recentSessionIds` is exhausted (or empty), remaining
   new panes are left with `sessionId: null`. `recentSessionIds` is used
   as-is with no cross-check against the live session list (that list isn't
   store state) — a stale recent id surfacing in a pane is harmless, because
   the grid-aware vanish-fallback (`resolvePaneSessions` + `reconcilePanes`,
   wired by FE in the next phase) cleans it up the moment sessions load.

4. **Pane cap — 4 (`grid-2x2`).** Implemented as-is; `PANE_COUNT` has no
   6-pane mode. Raising the cap later is a `PANE_COUNT`/`RATIOS_LENGTH`
   table edit plus a new `<ResizableSplit>` composition — isolated from
   everything else in this slice.

5. **Close-pane target mode.** `closePane` uses a static downgrade table
   (`CLOSE_PANE_DOWNGRADE` in `store.ts`) keyed by the mode being closed
   _from_, chosen so that removing exactly one pane always lands exactly on
   the remaining pane count: `cols-2`/`rows-2` (2) → `single` (1); `cols-3`
   (3) → `cols-2` (2 — preserving the column orientation over `rows-2`, an
   arbitrary but deterministic tie-break); `grid-2x2` (4) → `cols-3` (3).
   Focus: if the closed pane was NOT focused, focus is preserved unchanged;
   if it WAS focused, focus moves to the first remaining pane (there is no
   more-principled "next" target once the focused pane itself is gone).
   `ratios` resets to the new mode's default (a stale ratio array from the
   old, larger split has no meaningful mapping onto the smaller one). The
   downgrade table assumes `panes.length === PANE_COUNT[mode]` going in;
   `closePane` re-checks `remaining.length === PANE_COUNT[downgrade]` and
   no-ops otherwise, so an already off-count layout (should one ever reach
   this action outside the normal actions/rehydrate path) can't produce
   another off-count one.

6. **Keyboard pane navigation — deferred**, per the plan. No store surface
   was added for it in this phase; when it lands, it almost certainly wants
   `focusPane` with a "next/prev pane in some order" helper layered on top,
   not a new store action, since `focusPane(paneId)` already exists.

## Implementation notes for FE/BE

- **`resolvePaneSessions` tie-break (D4 + D7 reconciled).** The plan's D7
  prose ("only the focused pane falls back to `sessions[0]`") is
  under-specified for the multi-pane case: `sessions[0]` may already be
  claimed by another pane, and handing it to the focused pane too would
  violate D4. Implemented rule: after dropping invalid ids and deduping
  (first pane wins), the focused pane — if still empty — auto-fills with
  the **first session in `sessions` order not already claimed by another
  pane**; if every session is already shown somewhere, it stays empty. In
  `single` mode there is no "other pane," so this degrades to exactly
  `resolveActiveSession`'s "attach to `sessions[0]`" rule — asserted by a
  dedicated test (`resolve-pane-sessions.test.ts`) so the D10
  default-UI-unchanged guarantee holds at the resolver level, not just at
  the component level.
- **"Unchanged → `undefined`" is load-bearing.** Both `resolvePaneSessions`
  and `reconcilePanes` return/leave the identical reference when nothing
  would change. The caller effect (FE, next phase) is expected to gate on
  `!== undefined` before calling `reconcilePanes`, mirroring the existing
  `resolveActiveSession` → `setActiveSessionId` pattern in
  `terminal-shell.tsx` — a fresh-but-equal array here would otherwise create
  a new reference every render and refire the effect forever.
- **`ratios` shape** (documented in `store.ts` next to `defaultRatios` and
  `RATIOS_LENGTH`): per-pane fractions for `single`/`cols-2`/`rows-2`/
  `cols-3` (`ratios.length === PANE_COUNT[mode]`); for `grid-2x2` it is
  `[rowRatio, topColRatio, bottomColRatio]` — **not** a per-pane array,
  since that mode composes two binary `<ResizableSplit>`s (one row split of
  two column splits, per plan §3c). `RATIOS_LENGTH[mode]` is exported so FE
  and the rehydrate validator both read one source of truth instead of
  counting from prose.
- **Rehydrate is pad-and-validate, not just clamp.** `normalizeLayout(raw,
legacyActiveSessionId)` — an exported, pure, directly-unit-tested function
  — is the actual `onRehydrateStorage` body (two lines: normalize, then
  resync the `activeSessionId` mirror). It enforces the full invariant set
  on whatever comes out of storage (including a hand-edited or pre-existing
  malformed blob): known `mode` (else `"single"`), `panes.length` **exactly**
  `PANE_COUNT[mode]` (padded with fresh empty panes, not just truncated — a
  short array would otherwise make the grid read `panes[n]` as `undefined`
  and crash), session ids normalized via `normalizeSessionRef` and deduped
  per D4 (first occurrence wins), `focusedPaneId` clamped to an existing
  pane, and `ratios` reset to the mode default when the wrong length.
- **Legacy migration.** Pre-multi-window persisted storage has an
  `activeSessionId` field but no `layout` key at all; on rehydrate that
  merges onto the default single-pane layout (session `null`), while the
  legacy `activeSessionId` string is still present. Without special-casing
  this, an upgrading user's active session would silently vanish from the
  pane on first load, and the D7 vanish-fallback would then hand them
  `sessions[0]` instead of their own session. `normalizeLayout` detects this
  exactly (new-format storage always writes `activeSessionId` as a mirror
  consistent with `layout` at save time, so "truthy legacy id + every pane
  still empty" can only mean pre-layout storage) and seeds the sole/focused
  pane from it.
- **`partialize` keeps both `activeSessionId` and `layout`,** rather than
  dropping the standalone key. Reasoning: it costs nothing extra to persist
  (it's a scalar, always in sync at write time), keeps the persisted blob
  greppable/inspectable without decoding `layout`, and is exactly the value
  the legacy-migration path above depends on being present on the next
  upgrade after this one. `layout` remains the actual source of truth on
  rehydrate.
- **`reconcilePanes(ids: (string | null)[])`** was added alongside
  `resolvePaneSessions` per plan §5.1's own checklist wording ("New
  `resolvePaneSessions` + `reconcilePanes`"), even though the phase-1 task
  brief's action list didn't name it explicitly — it's the resolver's writer
  half and FE's vanish-fallback effect (phase 2) needs both.

## Phase 2 (FE) — implementation notes and deviations

Built: `components/resizable-split.tsx`, `terminal-pane.tsx`,
`terminal-grid.tsx`, `layout-menu.tsx` (all NEW); `xterm.tsx` (paneId /
onRegisterHandle / resizeCoalesced props, lifecycle untouched);
`terminal-shell.tsx` rewire; `extra-keys-bar.tsx` (handleRef prop type
widened to a read-only ref shape, see below). Unit tests:
`__tests__/resizable-split.test.tsx`, `__tests__/terminal-pane.test.tsx`.

- **D10 mechanics.** `TerminalPane` returns a bare fragment (no wrapper
  `<div>`, no `data-*`, no ring, no pointer-focus handler) when
  `multiPane === false` — exactly the subtree `terminal-shell.tsx` rendered
  directly before this feature. `[data-testid="terminal-pane"]` /
  `data-pane-id` exist **only** when `layout.mode !== "single"`, per the
  plan's own D10 wording ("_Multi-pane_ markup adds..."), which is narrower
  than the phase-2 task brief's literal wording ("always show the X in
  multiPane mode" implied testid always present) — the plan text wins.
  Reconnecting/unreachable overlays moved from the shell's viewport
  container into `TerminalPane`, changing their DOM nesting relative to
  `BrowserViewOverlay`/`AgentActivityOverlay`, but not their stacking:
  `BrowserViewOverlay` is `z-20` (unchanged) so it always wins regardless of
  DOM order, and the two moved overlays keep the same relative order to each
  other and to `AgentActivityOverlay` (all `z-10`) as before.
- **Accepted, not fixed: a layout-mode change remounts the affected
  `DynamicXTerm`(s).** Because `single`'s bare-fragment return and
  multi-pane's chrome-wrapped return are different tree shapes, React
  remounts on `setLayoutMode`/`closePane` (a fresh WS attach). The plan's
  no-remount invariant is about _session switching within a pane_, not
  _layout-mode switching_ — unifying the markup to avoid this would violate
  D10 instead, so it's accepted as-is.
- **RO throttling is scoped to `resizeCoalesced === true`, not universal.**
  Plan §3/D5 prose reads as if `fitAddon.fit()` becomes rAF-throttled
  unconditionally once the prop exists ("the ResizeObserver handler still
  calls fitAddon.fit() every time (rAF-throttled)"). Implemented instead:
  the RO handler stays byte-identical (synchronous `fit()` per firing) when
  `resizeCoalesced` is falsy/omitted — i.e. always in `single` mode — and
  only switches to rAF-batched `fit()` + deferred `sendResize()` while a
  divider drag is actually in progress. This is the more surgical reading
  and the one that keeps `single` mode's resize path untouched byte-for-byte
  (xterm.tsx's own doc calls it "the most safety-critical file").
- **`TerminalSwitcher` was NOT updated** to grey out sessions already shown
  in another pane, though plan §4's interaction table lists that as expected
  behavior. It wasn't in the phase-2 component edit list (only
  `xterm.tsx`/`dynamic-xterm.tsx`/`terminal-pane.tsx`/`terminal-grid.tsx`/
  `layout-menu.tsx`/`terminal-shell.tsx`), and D4 is still enforced
  correctly at the store layer regardless — picking an already-shown session
  via the switcher still works, it just also clears that session from the
  other pane that held it (store's `setPaneSession`), with no visual
  "already shown" cue in the switcher itself. Flagged as a small follow-up.
- **`LayoutMenu` is hidden on mobile** (`isMobile` gate in
  `terminal-shell.tsx`, alongside D9's grid force-collapse) — not specified
  either way by the plan, but consistent with the plan's "Desktop-only"
  framing and keeps the mobile header uncluttered without touching the
  persisted `layout.mode` (D9's re-expand-on-desktop guarantee is
  unaffected; the menu is simply not reachable from the mobile viewport).
- **`ExtraKeysBar`'s `handleRef` prop type was widened** from
  `RefObject<TerminalHandle | null>` to `{ readonly current: TerminalHandle
| null }` — a one-line, non-behavioral change (the component never writes
  `.current`). This lets the shell hand it a small getter object
  (`focusedHandleRef`) that always reads the currently focused pane's entry
  out of `paneHandlesRef` (a `Map`, not a single ref), instead of needing a
  reactive effect to keep a plain ref in sync with registry mutations that
  happen imperatively outside React state.
- **D5 has no test/observability hook.** `connection.ts` is explicitly
  unchanged per the plan, so there's no counter or log line BE can assert
  against to prove "one resize frame per drag, not per pointermove" from
  Playwright. Recommended (not built): a dev-only counter such as
  `window.__resizeFrames++` next to the `sendResize()` calls in
  `connection.ts`, added by BE if gate-10 needs to assert the coalescing
  property directly rather than just the post-drag `cols`/`rows` result.
  Note also that "exactly 1 frame after pointerup" is not quite the right
  assertion: `handleUp`'s `onRatiosChange` commit and the coalesced
  drag-end flush effect in `xterm.tsx` can each independently trigger a
  `sendResize()` in the same tick (both idempotent, same final dimensions)
  — BE should assert **zero frames during pointermove, ≥1 after
  pointerup**, not an exact count.
- **Box-model bugfix (caught by review before handoff, not by the unit
  suite — jsdom has no layout engine, so this class of bug is invisible to
  it).** The first cut of `<ResizableSplit>` sized its root with `flex-1`
  only, and each per-child wrapper div was `display:block` (no `flex`
  class). Both broke silently in multi-pane mode: (1) `flex-1` only takes
  effect when the _parent_ is `display:flex` — the shell's viewport
  container (`termContainerRef`'s div) is a plain block element (it's
  `relative min-h-0 flex-1 overflow-hidden`, not `flex`), so the split's
  root resolved to its content's natural (`auto`) height instead of filling
  the viewport; (2) even with a correctly-sized wrapper, `TerminalPane`'s
  own `flex-1` had no `display:flex` ancestor to grow inside, since the
  wrapper was block. Net effect: every multi-pane layout rendered each pane
  as just its ~26px chrome strip with a 0×0 xterm underneath —
  `fitAddon.fit()` ran against a zero-size container. Fixed by adding
  `h-full w-full` to `<ResizableSplit>`'s root (works whether its actual
  parent is flex or not) and `flex` to the per-child wrapper div (so a
  `TerminalPane` or nested `<ResizableSplit>` inside it has a flex ancestor
  to grow against). **Verified live** (not just by re-reading the CSS): a
  throwaway Playwright script against a real `pnpm dev` instance drove
  `cols-2` (each pane's xterm area 498×624 of a 514×650 pane, confirmed
  full-height, not 26px), a divider drag (pane widths reflowed 514/514 →
  661/366 with heights unchanged), and `grid-2x2` (four ~514×323 panes) —
  `single` mode still showed zero `[data-testid=terminal-pane]` elements
  throughout (D10 intact). Single mode was never affected by this bug
  in the first place (it never enters the `<ResizableSplit>` tree).
