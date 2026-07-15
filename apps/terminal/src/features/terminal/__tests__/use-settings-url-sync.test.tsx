/**
 * Hook tests for useSettingsUrlSync — the value-carrying `?settings=<section>`
 * bridge (open + active tab in one param). jsdom provides window.location /
 * window.history.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useSettingsUrlSync } from "../hooks/use-settings-url-sync";

import type { SettingsSection } from "../store";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("useSettingsUrlSync", () => {
  it("opens and selects the section from ?settings=<section>", () => {
    window.history.replaceState(null, "", "/?settings=account");
    const setOpen = vi.fn();
    const setSection = vi.fn();
    renderHook(() =>
      useSettingsUrlSync(false, "appearance", setOpen, setSection),
    );
    expect(setOpen).toHaveBeenCalledWith(true);
    expect(setSection).toHaveBeenCalledWith("account");
  });

  it("opens but leaves the section for a bare ?settings", () => {
    window.history.replaceState(null, "", "/?settings");
    const setOpen = vi.fn();
    const setSection = vi.fn();
    renderHook(() =>
      useSettingsUrlSync(false, "appearance", setOpen, setSection),
    );
    expect(setOpen).toHaveBeenCalledWith(true);
    expect(setSection).not.toHaveBeenCalled();
  });

  it("ignores an unknown section value but still opens", () => {
    window.history.replaceState(null, "", "/?settings=bogus");
    const setOpen = vi.fn();
    const setSection = vi.fn();
    renderHook(() =>
      useSettingsUrlSync(false, "appearance", setOpen, setSection),
    );
    expect(setOpen).toHaveBeenCalledWith(true);
    expect(setSection).not.toHaveBeenCalled();
  });

  it("does nothing when the param is absent", () => {
    const setOpen = vi.fn();
    const setSection = vi.fn();
    renderHook(() => useSettingsUrlSync(true, "agent", setOpen, setSection));
    expect(setOpen).not.toHaveBeenCalled();
    expect(setSection).not.toHaveBeenCalled();
  });

  it("writes ?settings=<section> when open and removes it when closed", () => {
    const setOpen = vi.fn();
    const setSection = vi.fn();
    const { rerender } = renderHook(
      ({ open, section }: { open: boolean; section: SettingsSection }) =>
        useSettingsUrlSync(open, section, setOpen, setSection),
      {
        initialProps: {
          open: true,
          section: "connection" as SettingsSection,
        },
      },
    );
    expect(window.location.search).toBe("?settings=connection");
    rerender({ open: false, section: "connection" });
    expect(window.location.search).toBe("");
  });

  it("updates the param when the section changes while open", () => {
    const setOpen = vi.fn();
    const setSection = vi.fn();
    const { rerender } = renderHook(
      ({ section }: { section: SettingsSection }) =>
        useSettingsUrlSync(true, section, setOpen, setSection),
      { initialProps: { section: "appearance" as SettingsSection } },
    );
    expect(window.location.search).toBe("?settings=appearance");
    rerender({ section: "agent" });
    expect(window.location.search).toBe("?settings=agent");
  });
});
