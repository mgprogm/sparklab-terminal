import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Terminal font-size preference: "auto" tracks the responsive default
 * (13/14 by breakpoint); a number overrides it with a fixed size. */
export type TerminalFontSize = number | "auto";

/** The selectable sections of the settings dialog. Order = tab order. */
export const SETTINGS_SECTIONS = [
  "appearance",
  "agent",
  "account",
  "connection",
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
    }),
    {
      name: "terminal-store",
      // Persist only durable UI prefs; ephemeral drawer/modal state stays out.
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        sidebarCollapsed: state.sidebarCollapsed,
        terminalFontSize: state.terminalFontSize,
      }),
    },
  ),
);
