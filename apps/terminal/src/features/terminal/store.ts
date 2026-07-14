import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TerminalState {
  /** Currently active session id, or null for empty state. */
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  /** Whether the sidebar is collapsed (desktop-only). */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;

  /** Whether the mobile sidebar drawer is open. NOT persisted — a persisted
   * open drawer would flash on reload. */
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleMobileSidebar: () => void;
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

      mobileSidebarOpen: false,
      setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
      toggleMobileSidebar: () =>
        set((state) => ({ mobileSidebarOpen: !state.mobileSidebarOpen })),
    }),
    {
      name: "terminal-store",
      // Persist only durable UI prefs; ephemeral drawer state stays out.
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    },
  ),
);
