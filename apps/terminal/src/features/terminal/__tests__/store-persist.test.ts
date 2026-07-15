/**
 * Persistence tests for the terminal Zustand store. Runs in the default
 * jsdom environment so localStorage exists and the persist API is attached.
 *
 * mobileSidebarOpen must NOT be persisted (mobile UX spec §1.2) — a
 * persisted open drawer would flash on reload — while the existing
 * persisted fields keep working.
 */
import { describe, expect, it } from "vitest";

import { useTerminalStore } from "../store";

describe("useTerminalStore persistence", () => {
  it("partialize keeps activeSessionId + sidebarCollapsed and drops mobileSidebarOpen", () => {
    const options = useTerminalStore.persist.getOptions();
    const persisted = options.partialize!({
      ...useTerminalStore.getState(),
      activeSessionId: "web-abc",
      sidebarCollapsed: true,
      terminalFontSize: 16,
      mobileSidebarOpen: true,
    });
    expect(persisted).toEqual({
      activeSessionId: "web-abc",
      sidebarCollapsed: true,
      terminalFontSize: 16,
      collapsedGroups: {},
    });
    expect(persisted).not.toHaveProperty("mobileSidebarOpen");
  });

  it("writes only the partialized fields to localStorage", () => {
    useTerminalStore.getState().setActiveSessionId("web-xyz");
    useTerminalStore.getState().setMobileSidebarOpen(true);

    const raw = localStorage.getItem("terminal-store");
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(stored.state.activeSessionId).toBe("web-xyz");
    expect(stored.state).not.toHaveProperty("mobileSidebarOpen");
  });
});
