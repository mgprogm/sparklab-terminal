import { normalizeSessionRef } from "@sparklab/shared-types";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  orgCollapseKey,
  projectCollapseKey,
  serverCollapseKey,
} from "./server-grouping";

/** Terminal font-size preference: "auto" tracks the responsive default
 * (13/14 by breakpoint); a number overrides it with a fixed size. */
export type TerminalFontSize = number | "auto";

/** The selectable sections of the settings dialog. Order = tab order. */
export const SETTINGS_SECTIONS = [
  "appearance",
  "notifications",
  "agent",
  "account",
  "connection",
  "servers",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Runtime guard for a `?settings=<section>` value from the URL. */
export function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

// ---- Multi-window terminal layout ----
// See docs/MULTI-WINDOW-PLAN.md (design) and docs/MULTI-WINDOW-DECISIONS.md
// (§8 open-decision resolutions).

export type LayoutMode = "single" | "cols-2" | "rows-2" | "cols-3" | "grid-2x2";

/** Number of panes each layout mode holds. `layout.panes.length` must always
 * equal `PANE_COUNT[layout.mode]`. */
export const PANE_COUNT: Record<LayoutMode, number> = {
  single: 1,
  "cols-2": 2,
  "rows-2": 2,
  "cols-3": 3,
  "grid-2x2": 4,
};

/**
 * Required length of `layout.ratios` per mode. Diverges from `PANE_COUNT`
 * for `grid-2x2`: that mode is composed of two `<ResizableSplit>`s (one row
 * split of two column splits — D3/plan §3c), so it needs 3 independent
 * binary-split fractions, not 4 per-pane fractions.
 */
export const RATIOS_LENGTH: Record<LayoutMode, number> = {
  single: 1,
  "cols-2": 2,
  "rows-2": 2,
  "cols-3": 3,
  "grid-2x2": 3,
};

const LAYOUT_MODES: readonly LayoutMode[] = [
  "single",
  "cols-2",
  "rows-2",
  "cols-3",
  "grid-2x2",
];

function isLayoutMode(value: unknown): value is LayoutMode {
  return (
    typeof value === "string" &&
    (LAYOUT_MODES as readonly string[]).includes(value)
  );
}

/**
 * Split ratios for the current layout. Shape depends on mode:
 * - `single`: `[1]` (unused — the one pane fills the viewport).
 * - `cols-2` / `rows-2`: `[a, b]`, a+b≈1 — one binary split; `a` is the
 *   first pane's fraction.
 * - `cols-3`: `[a, b, c]`, a+b+c≈1 — three independent per-pane fractions.
 * - `grid-2x2`: `[rowRatio, topColRatio, bottomColRatio]` — NOT a per-pane
 *   array. `rowRatio` is the outer row split's top-row fraction (bottom row
 *   gets `1 - rowRatio`); `topColRatio`/`bottomColRatio` are each row's own
 *   left-pane fraction. See `RATIOS_LENGTH` above.
 */
export function defaultRatios(mode: LayoutMode): number[] {
  switch (mode) {
    case "single":
      return [1];
    case "cols-2":
    case "rows-2":
      return [0.5, 0.5];
    case "cols-3":
      return [1 / 3, 1 / 3, 1 / 3];
    case "grid-2x2":
      return [0.5, 0.5, 0.5];
  }
}

/** Downgrade target when closing a pane, keyed by the mode being closed
 * FROM. Chosen so that removing exactly one pane always lands on exactly
 * the remaining pane count (§8 decision #5): cols-2/rows-2 (2) -> single
 * (1); cols-3 (3) -> cols-2 (2, preserving the column orientation over
 * rows-2); grid-2x2 (4) -> cols-3 (3). `single` has no entry — there is
 * nothing to close below one pane. */
const CLOSE_PANE_DOWNGRADE: Partial<Record<LayoutMode, LayoutMode>> = {
  "cols-2": "single",
  "rows-2": "single",
  "cols-3": "cols-2",
  "grid-2x2": "cols-3",
};

export interface PaneState {
  /** Stable random id — NEVER the array index (panes reorder/resize). */
  id: string;
  sessionId: string | null;
}

export interface LayoutState {
  mode: LayoutMode;
  /** length === PANE_COUNT[mode], always. */
  panes: PaneState[];
  /** Always one of panes[].id. */
  focusedPaneId: string;
  ratios: number[];
}

function makePane(sessionId: string | null = null): PaneState {
  return { id: crypto.randomUUID(), sessionId };
}

/** `panes` is never empty in a valid LayoutState (PANE_COUNT's minimum is
 * 1), but `noUncheckedIndexedAccess` can't see that invariant — this keeps
 * `panes[0]` accesses honest without scattering non-null assertions. Throws
 * (rather than fabricating a dangling id belonging to no pane) if the
 * invariant is ever actually violated — a loud failure here is strictly
 * better than silently breaking `focusedPaneId ∈ panes[].id`. */
function firstPaneId(panes: PaneState[]): string {
  const first = panes[0];
  if (!first) {
    throw new Error("layout invariant violated: panes is empty");
  }
  return first.id;
}

export function defaultLayout(): LayoutState {
  const pane = makePane();
  return { mode: "single", panes: [pane], focusedPaneId: pane.id, ratios: [1] };
}

/** `activeSessionId`'s sync-on-write mirror source of truth: the focused
 * pane's session. Every layout-mutating action recomputes this alongside
 * `layout` so the ~10 existing `activeSessionId` call sites across the app
 * keep working unchanged (they read a plain field, not a selector). */
export function deriveActiveSessionId(layout: LayoutState): string | null {
  return (
    layout.panes.find((p) => p.id === layout.focusedPaneId)?.sessionId ?? null
  );
}

function normalizePaneSessionId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? normalizeSessionRef(value)
    : null;
}

/**
 * Normalize a possibly-malformed, possibly-legacy persisted layout into a
 * fully valid `LayoutState`: known mode (else "single"), `panes.length`
 * exactly `PANE_COUNT[mode]` (padded, not just truncated — a short array
 * would otherwise make the grid read `panes[n]` as `undefined`), pane
 * session ids normalized (bare `web-…` -> `local/web-…`) and deduped
 * per-mode (D4 — a session in at most one pane, first occurrence wins),
 * `focusedPaneId` clamped to an existing pane, and `ratios` reset to the
 * mode default when the wrong length or otherwise invalid.
 *
 * `legacyActiveSessionId` is the pre-multi-window `activeSessionId` field.
 * When the persisted blob predates the `layout` key entirely (so `raw`
 * normalizes to an all-empty layout) and a legacy id is present, it seeds
 * the (sole, focused) pane from it — otherwise an upgrading user's active
 * session would silently vanish from the grid on first load after this
 * ships, and the D7 vanish-fallback would then hand them `sessions[0]`
 * instead of their own session.
 */
export function normalizeLayout(
  raw: Partial<LayoutState> | null | undefined,
  legacyActiveSessionId?: string | null,
): LayoutState {
  const mode = isLayoutMode(raw?.mode) ? raw.mode : "single";
  const count = PANE_COUNT[mode];

  const rawPanes = Array.isArray(raw?.panes) ? raw.panes : [];
  const seen = new Set<string>();
  const panes: PaneState[] = [];
  for (const p of rawPanes) {
    if (panes.length >= count) break;
    if (!p || typeof p.id !== "string" || p.id.length === 0) continue;
    const sessionId = normalizePaneSessionId(p.sessionId);
    const deduped = sessionId && !seen.has(sessionId) ? sessionId : null;
    if (deduped) seen.add(deduped);
    panes.push({ id: p.id, sessionId: deduped });
  }
  while (panes.length < count) panes.push(makePane());

  const legacyId = normalizePaneSessionId(legacyActiveSessionId ?? null);
  const first = panes[0];
  if (
    first &&
    legacyId &&
    !seen.has(legacyId) &&
    panes.every((p) => !p.sessionId)
  ) {
    first.sessionId = legacyId;
  }

  const focusedPaneId =
    typeof raw?.focusedPaneId === "string" &&
    panes.some((p) => p.id === raw.focusedPaneId)
      ? raw.focusedPaneId
      : firstPaneId(panes);

  const ratios =
    Array.isArray(raw?.ratios) &&
    raw.ratios.length === RATIOS_LENGTH[mode] &&
    raw.ratios.every((r) => typeof r === "number" && Number.isFinite(r))
      ? raw.ratios
      : defaultRatios(mode);

  return { mode, panes, focusedPaneId, ratios };
}

interface TerminalState {
  /** Currently active session id, or null for empty state. A sync-on-write
   * mirror of the focused pane's session (see `deriveActiveSessionId`) —
   * kept as a real field, not a derived selector, so every existing reader
   * (`useTerminalStore((s) => s.activeSessionId)`) is unaffected. */
  activeSessionId: string | null;
  /** Writes into the focused pane (`setPaneSession`), which also enforces
   * D4 (clears the id from any other pane that held it). External call
   * sites are unchanged — same name, same signature. */
  setActiveSessionId: (id: string | null) => void;

  /** Most-recently focused sessions, newest first. This powers the terminal
   * switcher without changing the sidebar's structural ordering. Also used
   * to auto-fill newly added panes (§8 decision #3). */
  recentSessionIds: string[];
  markSessionActive: (id: string) => void;

  /** Multi-window terminal layout — see docs/MULTI-WINDOW-PLAN.md §2. */
  layout: LayoutState;
  /** Grows/shrinks `panes[]` to the target mode's count. Growing auto-fills
   * new panes from `recentSessionIds` minus already-shown sessions, else
   * leaves them empty (§8 decision #3). Shrinking drops panes from the end.
   * Preserves `focusedPaneId` if it survives, else focuses the first pane.
   * Resets `ratios` to the mode default. No-op if `mode` is unchanged. */
  setLayoutMode: (mode: LayoutMode) => void;
  /** Moves focus to `paneId` (no-op if unknown). Mirrors `activeSessionId`. */
  focusPane: (paneId: string) => void;
  /** Sets `paneId`'s session (no-op if `paneId` unknown). Enforces D4: if
   * `sessionId` is already shown in another pane, that pane is cleared.
   * Mirrors `activeSessionId`. */
  setPaneSession: (paneId: string, sessionId: string | null) => void;
  /** Closes `paneId` and drops to the next-smaller mode that exactly fits
   * the remaining pane count (§8 decision #5, `CLOSE_PANE_DOWNGRADE`). If
   * the closed pane was focused, focus moves to the first remaining pane;
   * otherwise focus is preserved. No-op in `single` mode or for an unknown
   * `paneId`. Resets `ratios` to the new mode's default. */
  closePane: (paneId: string) => void;
  /** Overwrites `layout.ratios` (drag-end / a11y resize commit). */
  setRatios: (ratios: number[]) => void;
  /** Writes a full `sessionId | null` array over `panes[]` by index — the
   * writer half of `resolvePaneSessions` (grid-aware vanish-fallback). A
   * no-op (returns the same state) when nothing would actually change. */
  reconcilePanes: (ids: (string | null)[]) => void;

  /** Whether the sidebar is collapsed (desktop-only). */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;

  /** Terminal font size preference. Persisted like sidebarCollapsed. */
  terminalFontSize: TerminalFontSize;
  setTerminalFontSize: (size: TerminalFontSize) => void;

  /** Whether the mobile sidebar drawer is open. NOT persisted — a persisted
   * open drawer would flash on reload. */
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleMobileSidebar: () => void;

  /** Whether the settings dialog is open. NOT persisted — like the mobile
   * drawer, a persisted-open modal would flash on reload. */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  /** Active settings section (tab). NOT persisted — deep-linked via
   * `?settings=<section>`, otherwise defaults to the first tab. */
  settingsSection: SettingsSection;
  setSettingsSection: (section: SettingsSection) => void;

  /** Whether the file explorer dialog is open. NOT persisted — like the
   * settings modal, a persisted-open dialog would flash on reload. */
  explorerOpen: boolean;
  setExplorerOpen: (open: boolean) => void;

  /** Whether the Kanban board dialog is open. NOT persisted — like the file
   * explorer/settings modals, a persisted-open dialog would flash on reload. */
  kanbanOpen: boolean;
  setKanbanOpen: (open: boolean) => void;

  /** Whether the Project management dialog is open. NOT persisted — like the
   * Kanban/file-explorer/settings modals, a persisted-open dialog would
   * flash on reload. */
  pmOpen: boolean;
  setPmOpen: (open: boolean) => void;

  /** Whether the Agentic AI Creator dialog is open. NOT persisted — like the
   * Kanban/PM/file-explorer/settings modals, a persisted-open dialog would
   * flash on reload. */
  agenticOpen: boolean;
  setAgenticOpen: (open: boolean) => void;

  /** Whether the Munder Difflin viewer dialog is open. NOT persisted — like
   * the Kanban/PM/Agentic/file-explorer/settings modals, a persisted-open
   * dialog would flash on reload. */
  munderDifflinOpen: boolean;
  setMunderDifflinOpen: (open: boolean) => void;

  /** Whether the Notes dialog is open. NOT persisted — like the
   * Kanban/PM/Agentic/Munder Difflin/file-explorer/settings modals, a
   * persisted-open dialog would flash on reload. */
  notesOpen: boolean;
  setNotesOpen: (open: boolean) => void;

  /** Whether the Task Master Hub dialog is open. NOT persisted — like the
   * Kanban/PM/Agentic/Munder Difflin/Notes/file-explorer/settings modals, a
   * persisted-open dialog would flash on reload. */
  taskmasterHubOpen: boolean;
  setTaskmasterHubOpen: (open: boolean) => void;

  /** Set of collapsed group keys ("org" or "org/project"). Keys present =
   *  collapsed. Default (absent) = expanded. Persisted. */
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapsed: (key: string) => void;
  /** Expand the ancestors of a session (its org key and org/project key, and
   *  in multi-server mode its server key) so it is never hidden when it becomes
   *  active. Pass `serverId` in multi-server mode (namespaced keys); omit it in
   *  single-server mode (bare keys — unchanged legacy behavior). */
  expandAncestors: (
    org: string | null,
    project: string | null,
    serverId?: string | null,
  ) => void;
}

export const useTerminalStore = create<TerminalState>()(
  persist(
    (set, get) => ({
      activeSessionId: null,
      setActiveSessionId: (id) =>
        get().setPaneSession(get().layout.focusedPaneId, id),
      recentSessionIds: [],
      markSessionActive: (id) =>
        set((state) => ({
          recentSessionIds: [
            id,
            ...state.recentSessionIds.filter((sessionId) => sessionId !== id),
          ].slice(0, 100),
        })),

      layout: defaultLayout(),

      setLayoutMode: (mode) =>
        set((state) => {
          if (mode === state.layout.mode) return state;
          const targetCount = PANE_COUNT[mode];
          const current = state.layout.panes;

          let panes: PaneState[];
          if (targetCount <= current.length) {
            panes = current.slice(0, targetCount);
          } else {
            const shown = new Set(
              current
                .map((p) => p.sessionId)
                .filter((id): id is string => id !== null),
            );
            const extra: PaneState[] = [];
            const need = targetCount - current.length;
            for (const id of state.recentSessionIds) {
              if (extra.length >= need) break;
              if (shown.has(id)) continue;
              shown.add(id);
              extra.push(makePane(id));
            }
            while (extra.length < need) extra.push(makePane());
            panes = [...current, ...extra];
          }

          const focusedPaneId = panes.some(
            (p) => p.id === state.layout.focusedPaneId,
          )
            ? state.layout.focusedPaneId
            : firstPaneId(panes);

          const layout: LayoutState = {
            mode,
            panes,
            focusedPaneId,
            ratios: defaultRatios(mode),
          };
          return { layout, activeSessionId: deriveActiveSessionId(layout) };
        }),

      focusPane: (paneId) =>
        set((state) => {
          if (paneId === state.layout.focusedPaneId) return state;
          if (!state.layout.panes.some((p) => p.id === paneId)) return state;
          const layout: LayoutState = {
            ...state.layout,
            focusedPaneId: paneId,
          };
          return { layout, activeSessionId: deriveActiveSessionId(layout) };
        }),

      setPaneSession: (paneId, sessionId) =>
        set((state) => {
          if (!state.layout.panes.some((p) => p.id === paneId)) return state;
          const panes = state.layout.panes.map((p) => {
            if (p.id === paneId) return { ...p, sessionId };
            // D4: a session may appear in at most one pane.
            if (sessionId !== null && p.sessionId === sessionId) {
              return { ...p, sessionId: null };
            }
            return p;
          });
          const layout: LayoutState = { ...state.layout, panes };
          return { layout, activeSessionId: deriveActiveSessionId(layout) };
        }),

      closePane: (paneId) =>
        set((state) => {
          const { mode, panes, focusedPaneId } = state.layout;
          const downgrade = CLOSE_PANE_DOWNGRADE[mode];
          if (!downgrade) return state; // single mode: nothing to close
          if (!panes.some((p) => p.id === paneId)) return state;

          const remaining = panes.filter((p) => p.id !== paneId);
          // The downgrade table assumes panes.length === PANE_COUNT[mode]
          // (true after every action, and enforced on rehydrate by
          // normalizeLayout). Guard the invariant locally too rather than
          // inheriting it blindly — an off-count layout must never produce
          // another off-count one.
          if (remaining.length !== PANE_COUNT[downgrade]) return state;

          const first = remaining[0];
          if (!first) {
            throw new Error("closePane invariant violated: no panes remain");
          }
          const nextFocusedPaneId =
            focusedPaneId === paneId ? first.id : focusedPaneId;

          const layout: LayoutState = {
            mode: downgrade,
            panes: remaining,
            focusedPaneId: nextFocusedPaneId,
            ratios: defaultRatios(downgrade),
          };
          return { layout, activeSessionId: deriveActiveSessionId(layout) };
        }),

      setRatios: (ratios) =>
        set((state) => ({ layout: { ...state.layout, ratios } })),

      reconcilePanes: (ids) =>
        set((state) => {
          const changed = state.layout.panes.some(
            (p, i) => p.sessionId !== (ids[i] ?? null),
          );
          if (!changed) return state;
          const panes = state.layout.panes.map((p, i) => ({
            ...p,
            sessionId: ids[i] ?? null,
          }));
          const layout: LayoutState = { ...state.layout, panes };
          return { layout, activeSessionId: deriveActiveSessionId(layout) };
        }),

      sidebarCollapsed: false,
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

      terminalFontSize: "auto",
      setTerminalFontSize: (size) => set({ terminalFontSize: size }),

      mobileSidebarOpen: false,
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      toggleMobileSidebar: () =>
        set((state) => ({ mobileSidebarOpen: !state.mobileSidebarOpen })),

      settingsOpen: false,
      setSettingsOpen: (open) => set({ settingsOpen: open }),

      settingsSection: "appearance",
      setSettingsSection: (section) => set({ settingsSection: section }),

      explorerOpen: false,
      setExplorerOpen: (open) => set({ explorerOpen: open }),

      kanbanOpen: false,
      setKanbanOpen: (open) => set({ kanbanOpen: open }),

      pmOpen: false,
      setPmOpen: (open) => set({ pmOpen: open }),

      agenticOpen: false,
      setAgenticOpen: (open) => set({ agenticOpen: open }),

      munderDifflinOpen: false,
      setMunderDifflinOpen: (open) => set({ munderDifflinOpen: open }),

      notesOpen: false,
      setNotesOpen: (open) => set({ notesOpen: open }),

      taskmasterHubOpen: false,
      setTaskmasterHubOpen: (open) => set({ taskmasterHubOpen: open }),

      collapsedGroups: {},
      toggleGroupCollapsed: (key) =>
        set((state) => {
          const next = { ...state.collapsedGroups };
          if (next[key]) {
            delete next[key];
          } else {
            next[key] = true;
          }
          return { collapsedGroups: next };
        }),
      expandAncestors: (org, project, serverId) =>
        set((state) => {
          const next = { ...state.collapsedGroups };
          let changed = false;
          // In multi-server mode (serverId provided) keys are namespaced by
          // server; the server ancestor is also expanded. In single-server
          // mode (serverId == null) keys stay bare — unchanged legacy behavior.
          const ns = serverId ?? null;
          const expand = (key: string) => {
            if (next[key]) {
              delete next[key];
              changed = true;
            }
          };
          if (ns != null) expand(serverCollapseKey(ns));
          expand(orgCollapseKey(ns, org));
          // Expand the project level (only meaningful when org is set).
          if (org != null && project != null) {
            expand(projectCollapseKey(ns, org, project));
          }
          return changed ? { collapsedGroups: next } : state;
        }),
    }),
    {
      name: "terminal-store",
      // Persist only durable UI prefs; ephemeral drawer/modal state stays out.
      partialize: (state) => ({
        // Kept alongside `layout` as a denormalized mirror (not dropped):
        // it's always in sync at write time (every layout action recomputes
        // it), costs nothing extra to persist, and keeps the persisted blob
        // inspectable/greppable without decoding `layout`. `layout` is the
        // actual source of truth on rehydrate — see normalizeLayout's
        // legacy-migration path below.
        activeSessionId: state.activeSessionId,
        recentSessionIds: state.recentSessionIds,
        layout: state.layout,
        sidebarCollapsed: state.sidebarCollapsed,
        terminalFontSize: state.terminalFontSize,
        collapsedGroups: state.collapsedGroups,
      }),
      // Normalize whatever came out of storage (possibly pre-multi-window,
      // possibly hand-edited/corrupted) into a fully valid layout, then
      // resync the activeSessionId mirror from it. See normalizeLayout.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.layout = normalizeLayout(state.layout, state.activeSessionId);
        state.activeSessionId = deriveActiveSessionId(state.layout);
      },
    },
  ),
);
