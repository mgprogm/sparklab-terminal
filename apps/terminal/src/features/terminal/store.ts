import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TerminalState {
  /** Currently active session id, or null for empty state. */
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;

  /** Whether the sidebar is collapsed. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
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
    }),
    { name: "terminal-store" },
  ),
);
