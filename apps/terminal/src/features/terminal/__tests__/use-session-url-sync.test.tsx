/**
 * Hook tests for useSessionUrlSync — the `?session=<id>` ↔ activeSessionId
 * bridge (jsdom: window.location / window.history are provided).
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionUrlSync } from "../hooks/use-session-url-sync";

beforeEach(() => {
  // Reset the URL to a clean path between tests.
  window.history.replaceState(null, "", "/");
});

describe("useSessionUrlSync", () => {
  it("reads ?session on mount and overrides the current id", () => {
    window.history.replaceState(null, "", "/?session=web-B");
    const setActive = vi.fn();
    // Store starts on a different (persisted) id — the URL should win.
    renderHook(() => useSessionUrlSync("web-A", setActive));
    expect(setActive).toHaveBeenCalledWith("web-B");
  });

  it("does not call the setter when there is no ?session param", () => {
    const setActive = vi.fn();
    renderHook(() => useSessionUrlSync(null, setActive));
    expect(setActive).not.toHaveBeenCalled();
  });

  it("writes the active id into the URL (reflects a persisted restore)", () => {
    const setActive = vi.fn();
    renderHook(() => useSessionUrlSync("web-A", setActive));
    expect(new URLSearchParams(window.location.search).get("session")).toBe(
      "web-A",
    );
  });

  it("updates the URL when the active id changes", () => {
    const setActive = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useSessionUrlSync(id, setActive),
      { initialProps: { id: "web-A" as string | null } },
    );
    expect(new URLSearchParams(window.location.search).get("session")).toBe(
      "web-A",
    );
    rerender({ id: "web-C" });
    expect(new URLSearchParams(window.location.search).get("session")).toBe(
      "web-C",
    );
  });

  it("removes ?session when the active id becomes null", () => {
    const setActive = vi.fn();
    const { rerender } = renderHook(
      ({ id }: { id: string | null }) => useSessionUrlSync(id, setActive),
      { initialProps: { id: "web-A" as string | null } },
    );
    rerender({ id: null });
    expect(window.location.search).toBe("");
  });
});
