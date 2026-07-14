/**
 * @vitest-environment node
 *
 * Store tests for the terminal Zustand store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useTerminalStore } from "../store";

describe("useTerminalStore", () => {
  beforeEach(() => {
    // Reset store to initial state between tests
    useTerminalStore.setState({
      activeSessionId: null,
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
    });
  });

  afterEach(() => {
    useTerminalStore.setState({
      activeSessionId: null,
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
    });
  });

  describe("activeSessionId", () => {
    it("defaults to null", () => {
      expect(useTerminalStore.getState().activeSessionId).toBeNull();
    });

    it("setActiveSessionId updates the id", () => {
      useTerminalStore.getState().setActiveSessionId("web-abc");
      expect(useTerminalStore.getState().activeSessionId).toBe("web-abc");
    });

    it("setActiveSessionId(null) clears it", () => {
      useTerminalStore.getState().setActiveSessionId("web-abc");
      useTerminalStore.getState().setActiveSessionId(null);
      expect(useTerminalStore.getState().activeSessionId).toBeNull();
    });
  });

  describe("sidebarCollapsed", () => {
    it("defaults to false", () => {
      expect(useTerminalStore.getState().sidebarCollapsed).toBe(false);
    });

    it("setSidebarCollapsed(true) collapses", () => {
      useTerminalStore.getState().setSidebarCollapsed(true);
      expect(useTerminalStore.getState().sidebarCollapsed).toBe(true);
    });

    it("toggleSidebar flips the state", () => {
      useTerminalStore.getState().toggleSidebar();
      expect(useTerminalStore.getState().sidebarCollapsed).toBe(true);
      useTerminalStore.getState().toggleSidebar();
      expect(useTerminalStore.getState().sidebarCollapsed).toBe(false);
    });
  });

  describe("mobileSidebarOpen", () => {
    it("defaults to false", () => {
      expect(useTerminalStore.getState().mobileSidebarOpen).toBe(false);
    });

    it("setMobileSidebarOpen(true) opens the drawer", () => {
      useTerminalStore.getState().setMobileSidebarOpen(true);
      expect(useTerminalStore.getState().mobileSidebarOpen).toBe(true);
    });

    it("toggleMobileSidebar flips the state", () => {
      useTerminalStore.getState().toggleMobileSidebar();
      expect(useTerminalStore.getState().mobileSidebarOpen).toBe(true);
      useTerminalStore.getState().toggleMobileSidebar();
      expect(useTerminalStore.getState().mobileSidebarOpen).toBe(false);
    });

    // Persistence exclusion is covered in store-persist.test.ts (jsdom —
    // the persist API needs localStorage, which node env lacks).
  });

  describe("fallback behavior when active session vanishes", () => {
    it("active session can be set to null when the session list is empty", () => {
      useTerminalStore.getState().setActiveSessionId("web-gone");
      // Simulate what terminal-shell.tsx does: set to null when list is empty
      useTerminalStore.getState().setActiveSessionId(null);
      expect(useTerminalStore.getState().activeSessionId).toBeNull();
    });

    it("can switch to a fallback session id", () => {
      useTerminalStore.getState().setActiveSessionId("web-gone");
      // Simulate fallback: set to first available session
      useTerminalStore.getState().setActiveSessionId("web-survivor");
      expect(useTerminalStore.getState().activeSessionId).toBe("web-survivor");
    });
  });
});
