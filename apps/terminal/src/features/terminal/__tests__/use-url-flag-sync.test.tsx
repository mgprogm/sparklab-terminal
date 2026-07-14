/**
 * Hook tests for useUrlFlagSync — presence-style `?<param>` ↔ boolean open
 * flag (jsdom provides window.location / window.history).
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useUrlFlagSync } from "../hooks/use-url-flag-sync";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("useUrlFlagSync", () => {
  it("opens on mount when the param is present", () => {
    window.history.replaceState(null, "", "/?settings=1");
    const setOpen = vi.fn();
    renderHook(() => useUrlFlagSync("settings", false, setOpen));
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("does not force-close when the param is absent", () => {
    const setOpen = vi.fn();
    // Flag is already open (e.g. persisted); absence must not close it.
    renderHook(() => useUrlFlagSync("agent", true, setOpen));
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("writes the param when open and removes it when closed", () => {
    const setOpen = vi.fn();
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useUrlFlagSync("agent", open, setOpen),
      { initialProps: { open: true } },
    );
    expect(window.location.search).toBe("?agent=1");
    rerender({ open: false });
    expect(window.location.search).toBe("");
  });

  it("composes: each flag preserves the other's param", () => {
    const noop = vi.fn();
    renderHook(() => {
      useUrlFlagSync("settings", true, noop);
      useUrlFlagSync("agent", true, noop);
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("settings")).toBe("1");
    expect(params.get("agent")).toBe("1");
  });
});
