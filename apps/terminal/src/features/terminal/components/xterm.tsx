"use client";

/**
 * XTerm — the terminal viewport component.
 *
 * Safety rules (from the plan + CLAUDE.md):
 * - 'use client' + next/dynamic(..., { ssr: false }) — xterm must never SSR.
 * - Terminal + Connection in refs; created once in one effect with [] deps.
 * - StrictMode-safe: cleanup fully disposes Connection + Terminal (no
 *   double-attach). On re-mount the effect recreates everything.
 * - The component NEVER re-renders on terminal output; stable callbacks;
 *   session switch via imperative connection swap, NOT remount.
 * - FitAddon + ResizeObserver in the same effect; WebGL in try/catch.
 * - Invariants: ws.binaryType = 'arraybuffer'; freshConnect → term.reset()
 *   on first binary frame; keystrokes TextEncoder → binary frames; JSON text
 *   frames only for control (resize, ping/pong, exit).
 */

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, type RefObject } from "react";

import "@xterm/xterm/css/xterm.css";

import {
  Connection,
  type ConnectionCallbacks,
  type ConnectionStatus,
} from "../connection";
import { applyModifiers, type ModifierSnapshot } from "../keys";
import { useTerminalStore, type TerminalFontSize } from "../store";

/**
 * Imperative handle exposed to the shell (mobile UX spec §3.4): focus
 * restoration, raw input injection for the extra-keys bar (binary WS frame
 * path, same as keystrokes), and DECCKM state for arrow-key sequences.
 */
export interface TerminalHandle {
  focus: () => void;
  sendInput: (data: string) => void;
  getApplicationCursorKeysMode: () => boolean;
}

export interface XTermProps {
  /** The session id to connect to, or null for "no session". */
  sessionId: string | null;
  /** Called when connection status changes. */
  onStatusChange?: (status: ConnectionStatus, text: string) => void;
  /** Called when a server error frame fires (deleted/invalid session). */
  onSessionError?: () => void;
  /** Called when the WebSocket closes because authentication expired. */
  onAuthError?: () => void;
  /** Stable pane id for the handle registry (D6). Required alongside
   * `onRegisterHandle` — omit both in contexts that don't need imperative
   * focus/sendInput access. */
  paneId?: string;
  /** Registers/unregisters this instance's imperative handle in the parent's
   * per-pane handle map: called with `(paneId, handle)` on mount/update and
   * `(paneId, null)` on unmount. Replaces the old single-slot `handleRef`
   * prop (D6) — a single shared ref could not survive more than one pane. */
  onRegisterHandle?: (paneId: string, handle: TerminalHandle | null) => void;
  /** Sticky-modifier state owned by the extra-keys bar (stable ref). */
  modifiersRef?: RefObject<ModifierSnapshot | null>;
  /** True while an ancestor <ResizableSplit> divider is being dragged (D5).
   * While true: ResizeObserver-triggered `fitAddon.fit()` calls are
   * rAF-throttled (collapsing N firings within one frame into one) and
   * `connection.sendResize()` is deferred until this prop transitions back
   * to false, at which point one final fit+sendResize flushes. This is what
   * keeps a divider drag from flooding the gateway/tmux/ssh with resize
   * frames. Default/omitted behaves exactly as before (immediate fit +
   * sendResize on every ResizeObserver firing) — single-pane mode is
   * unaffected. */
  resizeCoalesced?: boolean;
}

// Stable encoder reused across all keystroke sends.
const encoder = new TextEncoder();

// Mobile font sizing (mobile UX spec §4.3): 13px below 430px, else 14px.
const SMALL_SCREEN_QUERY = "(max-width: 429px)";
const fontSizeFor = (small: boolean) => (small ? 13 : 14);

// The user's font-size preference wins when it's a fixed number; "auto" defers
// to the responsive breakpoint default (Settings dialog → Appearance).
const effectiveFontSize = (pref: TerminalFontSize, small: boolean) =>
  pref === "auto" ? fontSizeFor(small) : pref;

export function XTermComponent({
  sessionId,
  onStatusChange,
  onSessionError,
  onAuthError,
  paneId,
  onRegisterHandle,
  modifiersRef,
  resizeCoalesced,
}: XTermProps) {
  // ---- Refs for the one-shot lifecycle ----
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  // rAF handle for the ResizeObserver's coalesced-mode fit() throttle (D5).
  const roRafIdRef = useRef<number | null>(null);

  // Persisted font-size preference. Kept in a ref so the once-created
  // breakpoint listener reads the latest value without rebuilding the terminal;
  // a separate effect below reactively applies changes to the live terminal.
  const fontSize = useTerminalStore((s) => s.terminalFontSize);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;

  // Read through a ref inside the one-shot effect's closures (D5) — mirrors
  // the fontSizeRef idiom so the one-shot effect's `[]` deps stay untouched.
  const coalescedRef = useRef(resizeCoalesced ?? false);
  coalescedRef.current = resizeCoalesced ?? false;

  // Store callbacks in refs so the Connection always sees the latest without
  // needing to rebuild it on every render.
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const onSessionErrorRef = useRef(onSessionError);
  onSessionErrorRef.current = onSessionError;
  const onAuthErrorRef = useRef(onAuthError);
  onAuthErrorRef.current = onAuthError;

  // ---- One-shot effect: create Terminal + addons, wire up I/O ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const smallScreen = window.matchMedia(SMALL_SCREEN_QUERY);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
      fontSize: effectiveFontSize(fontSizeRef.current, smallScreen.matches),
      scrollback: 10_000,
      // Warp-inspired warm-dark theme matching the gateway's public/index.html.
      theme: {
        background: "#2b2622",
        foreground: "#f7f5f0",
        cursor: "#f7f5f0",
        cursorAccent: "#2b2622",
        selectionBackground: "#4a443f",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(container);

    // WebGL can throw in headless / no-GPU contexts.
    import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        try {
          term.loadAddon(new WebglAddon());
        } catch (e) {
          console.warn(
            "WebGL addon unavailable, falling back to canvas/DOM renderer",
            e,
          );
        }
      })
      .catch(() => {
        // Module unavailable — canvas renderer is fine.
      });

    termRef.current = term;
    fitRef.current = fitAddon;

    // Keystrokes: xterm gives a string → encode to raw UTF-8 bytes → binary.
    // Sticky Ctrl/Alt from the extra-keys bar are applied (and consumed)
    // first — a plain string transform, still one binary frame (spec §3.5).
    const dataDisposable = term.onData((data) => {
      const payload = applyModifiers(data, modifiersRef?.current);
      connectionRef.current?.send(encoder.encode(payload));
    });

    // Resize: notify the gateway so tmux can adjust. During a coalesced
    // drag (D5) this is deferred to the resizeCoalesced true->false
    // transition (see the dedicated effect below) instead of firing here.
    const resizeDisposable = term.onResize(() => {
      if (coalescedRef.current) return;
      connectionRef.current?.sendResize();
    });

    // If the viewport was scrolled to the bottom before the fit, keep it
    // pinned there so the prompt row stays visible above the mobile
    // keyboard / extra-keys bar (spec §2.4).
    const runFit = () => {
      try {
        const buffer = term.buffer.active;
        const atBottom = buffer.viewportY === buffer.baseY;
        fitAddon.fit();
        if (atBottom) term.scrollToBottom();
      } catch {
        /* container might be detached */
      }
    };

    // ResizeObserver: refit terminal when container size changes. Default
    // (resizeCoalesced falsy — includes single-pane mode) behaves exactly
    // as before: fit() synchronously on every firing. While
    // resizeCoalesced is true (an ancestor <ResizableSplit> divider is
    // being dragged), N firings within one animation frame collapse into
    // one rAF-scheduled fit() (D5) — sendResize() above stays deferred.
    const ro = new ResizeObserver(() => {
      if (coalescedRef.current) {
        if (roRafIdRef.current === null) {
          roRafIdRef.current = requestAnimationFrame(() => {
            roRafIdRef.current = null;
            runFit();
          });
        }
        return;
      }
      runFit();
    });
    ro.observe(container);
    roRef.current = ro;

    // Breakpoint-aware font size (spec §4.3): update + refit on crossing.
    // A fixed user preference overrides the breakpoint; "auto" follows it.
    const onFontBreakpointChange = (e: MediaQueryListEvent) => {
      term.options.fontSize = effectiveFontSize(fontSizeRef.current, e.matches);
      try {
        fitAddon.fit();
      } catch {
        /* noop */
      }
    };
    smallScreen.addEventListener("change", onFontBreakpointChange);

    // Initial fit.
    try {
      fitAddon.fit();
    } catch {
      /* noop */
    }

    // ---- StrictMode-safe cleanup ----
    return () => {
      // Dispose the connection first (closes WS, clears timers).
      if (connectionRef.current) {
        connectionRef.current.dispose();
        connectionRef.current = null;
      }
      dataDisposable.dispose();
      resizeDisposable.dispose();
      smallScreen.removeEventListener("change", onFontBreakpointChange);
      ro.disconnect();
      roRef.current = null;
      if (roRafIdRef.current !== null) {
        cancelAnimationFrame(roRafIdRef.current);
        roRafIdRef.current = null;
      }
      fitRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, []); // one-shot: created once, cleaned up on unmount

  // ---- Coalesced-resize drag-end flush (D5) ----
  // On the resizeCoalesced true->false transition (a divider drag just
  // ended), flush one final fit()+sendResize() via rAF even if no further
  // ResizeObserver firing arrives — the RO may have already settled on the
  // pre-drag-end size while sendResize() was still being withheld above.
  const wasCoalescedRef = useRef(resizeCoalesced ?? false);
  useEffect(() => {
    const dragging = resizeCoalesced ?? false;
    const wasDragging = wasCoalescedRef.current;
    wasCoalescedRef.current = dragging;
    if (!wasDragging || dragging) return;

    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* container might be detached */
      }
      connectionRef.current?.sendResize();
    });
    return () => cancelAnimationFrame(id);
  }, [resizeCoalesced]);

  // ---- Font-size preference effect ----
  // Apply the persisted preference to the live terminal and refit so the grid
  // reflows. Mirrors the breakpoint handler's update+fit (no scroll-pin needed
  // here). Runs after mount because termRef is set in the one-shot effect.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const small = window.matchMedia(SMALL_SCREEN_QUERY).matches;
    term.options.fontSize = effectiveFontSize(fontSize, small);
    try {
      fitRef.current?.fit();
    } catch {
      /* noop */
    }
  }, [fontSize]);

  // ---- Session switching effect ----
  // When sessionId changes, dispose the old connection and (if non-null)
  // create a new one — all on the same Terminal instance.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // Dispose previous connection.
    if (connectionRef.current) {
      connectionRef.current.dispose();
      connectionRef.current = null;
    }

    if (!sessionId) {
      onStatusRef.current?.("disconnected", "idle");
      return;
    }

    // Clear stale content before the new attach redraw.
    term.reset();
    try {
      fitRef.current?.fit();
    } catch {
      /* noop */
    }

    const callbacks: ConnectionCallbacks = {
      onStatus: (state, text) => onStatusRef.current?.(state, text),
      onSessionError: () => onSessionErrorRef.current?.(),
      onAuthError: () => onAuthErrorRef.current?.(),
    };

    const conn = new Connection(sessionId, term, callbacks);
    connectionRef.current = conn;
    conn.connect();

    return () => {
      // If this effect re-runs (sessionId changed), dispose.
      conn.dispose();
      if (connectionRef.current === conn) {
        connectionRef.current = null;
      }
    };
  }, [sessionId]);

  // ---- Focus method (called after dialogs close) ----
  const focus = useCallback(() => {
    termRef.current?.focus();
  }, []);

  // Imperative handle for the shell / extra-keys bar (spec §3.4), registered
  // into the parent's per-pane handle map (D6) instead of a single shared
  // ref — see XTermProps.onRegisterHandle. sendInput uses the exact same
  // binary-frame path as keystrokes.
  useEffect(() => {
    if (!onRegisterHandle || !paneId) return;
    onRegisterHandle(paneId, {
      focus,
      sendInput: (data: string) => {
        connectionRef.current?.send(encoder.encode(data));
      },
      getApplicationCursorKeysMode: () =>
        termRef.current?.modes.applicationCursorKeysMode ?? false,
    });
    return () => {
      onRegisterHandle(paneId, null);
    };
  }, [onRegisterHandle, paneId, focus]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 p-[10px_8px]"
      // Tap-highlight reset (spec §4.2) — no flash on touch-to-focus.
      style={{ background: "#2b2622", WebkitTapHighlightColor: "transparent" }}
    />
  );
}
