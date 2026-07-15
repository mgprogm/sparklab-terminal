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

interface TerminalState {
  /** Currently active session id, or null for empty state. */
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

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
    (set) => ({
      activeSessionId: null,
      setActiveSessionId: (id) => set({ activeSessionId: id }),

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
        activeSessionId: state.activeSessionId,
        sidebarCollapsed: state.sidebarCollapsed,
        terminalFontSize: state.terminalFontSize,
        collapsedGroups: state.collapsedGroups,
      }),
      // A pre-multi-server persisted id is bare (`web-…`); normalize it to the
      // qualified form (`local/web-…`) on load so it matches the now-qualified
      // list ids and doesn't trigger a one-render vanish-fallback.
      onRehydrateStorage: () => (state) => {
        if (state?.activeSessionId) {
          state.activeSessionId = normalizeSessionRef(state.activeSessionId);
        }
      },
    },
  ),
);
