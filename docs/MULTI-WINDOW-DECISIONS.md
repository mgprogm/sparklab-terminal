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
