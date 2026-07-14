"use client";

import { useEffect } from "react";

/**
 * iOS keyboard fallback (mobile UX spec §2.3, §2.6).
 *
 * iOS Safari ignores `interactive-widget=resizes-content` and never resizes
 * the layout viewport when the on-screen keyboard opens. This hook mirrors
 * `window.visualViewport.height` into the `--app-height` CSS custom property
 * on `<html>`; the shell root uses `h-[var(--app-height,100dvh)]`, so the
 * shrunken root shrinks the terminal container → ResizeObserver →
 * `fitAddon.fit()` → `term.onResize` → the existing `sendResize()` JSON
 * control message. Zero protocol change.
 *
 * Also pins the layout viewport back to the top (`scrollTo(0, 0)`) — iOS
 * scrolls it when focusing xterm's offscreen helper textarea — and re-syncs
 * 300 ms after orientation changes, where iOS reports viewport dimensions
 * late. The re-sync updates `--app-height` with the settled value, which
 * retriggers the ResizeObserver → fit path (the extra resize is idempotent
 * for tmux).
 *
 * No-op when `visualViewport` is unavailable (older browsers, SSR-safe by
 * running only in an effect).
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let orientationTimer: ReturnType<typeof setTimeout> | null = null;

    const sync = () => {
      document.documentElement.style.setProperty(
        "--app-height",
        `${vv.height}px`,
      );
      window.scrollTo(0, 0);
    };

    // The keyboard animation fires many resize events; debounce 100 ms.
    const scheduleSync = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sync, 100);
    };

    // Belt-and-braces for iOS rotation timing bugs: dimensions settle late,
    // so re-run the height sync after 300 ms.
    const onOrientationChange = () => {
      if (orientationTimer) clearTimeout(orientationTimer);
      orientationTimer = setTimeout(sync, 300);
    };

    vv.addEventListener("resize", scheduleSync);
    vv.addEventListener("scroll", scheduleSync);

    const orientation = window.screen?.orientation;
    if (orientation) {
      orientation.addEventListener("change", onOrientationChange);
    } else {
      window.addEventListener("orientationchange", onOrientationChange);
    }

    sync();

    return () => {
      vv.removeEventListener("resize", scheduleSync);
      vv.removeEventListener("scroll", scheduleSync);
      if (orientation) {
        orientation.removeEventListener("change", onOrientationChange);
      } else {
        window.removeEventListener("orientationchange", onOrientationChange);
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      if (orientationTimer) clearTimeout(orientationTimer);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);
}
