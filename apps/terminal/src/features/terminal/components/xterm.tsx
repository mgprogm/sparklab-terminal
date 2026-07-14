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
  /** Populated with the imperative TerminalHandle (stable ref from useRef). */
  handleRef?: RefObject<TerminalHandle | null>;
  /** Sticky-modifier state owned by the extra-keys bar (stable ref). */
  modifiersRef?: RefObject<ModifierSnapshot | null>;
}

// Stable encoder reused across all keystroke sends.
const encoder = new TextEncoder();

// Mobile font sizing (mobile UX spec §4.3): 13px below 430px, else 14px.
const SMALL_SCREEN_QUERY = "(max-width: 429px)";
const fontSizeFor = (small: boolean) => (small ? 13 : 14);

export function XTermComponent({
  sessionId,
  onStatusChange,
  onSessionError,
  handleRef,
  modifiersRef,
}: XTermProps) {
  // ---- Refs for the one-shot lifecycle ----
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<Connection | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  // Store callbacks in refs so the Connection always sees the latest without
  // needing to rebuild it on every render.
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const onSessionErrorRef = useRef(onSessionError);
  onSessionErrorRef.current = onSessionError;

  // ---- One-shot effect: create Terminal + addons, wire up I/O ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const smallScreen = window.matchMedia(SMALL_SCREEN_QUERY);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
      fontSize: fontSizeFor(smallScreen.matches),
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

    // Resize: notify the gateway so tmux can adjust.
    const resizeDisposable = term.onResize(() => {
      connectionRef.current?.sendResize();
    });

    // ResizeObserver: refit terminal when container size changes. If the
    // viewport was scrolled to the bottom before the fit, keep it pinned
    // there so the prompt row stays visible above the mobile keyboard /
    // extra-keys bar (spec §2.4).
    const ro = new ResizeObserver(() => {
      try {
        const buffer = term.buffer.active;
        const atBottom = buffer.viewportY === buffer.baseY;
        fitAddon.fit();
        if (atBottom) term.scrollToBottom();
      } catch {
        /* container might be detached */
      }
    });
    ro.observe(container);
    roRef.current = ro;

    // Breakpoint-aware font size (spec §4.3): update + refit on crossing.
    const onFontBreakpointChange = (e: MediaQueryListEvent) => {
      term.options.fontSize = fontSizeFor(e.matches);
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
      fitRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, []); // one-shot: created once, cleaned up on unmount

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

  // Expose focus for parent components.
  // Store on a data attribute so parent can access without forwardRef overhead.
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      (container as HTMLDivElement & { __termFocus?: () => void }).__termFocus =
        focus;
    }
  }, [focus]);

  // Imperative handle for the shell / extra-keys bar (spec §3.4). sendInput
  // uses the exact same binary-frame path as keystrokes.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus,
      sendInput: (data: string) => {
        connectionRef.current?.send(encoder.encode(data));
      },
      getApplicationCursorKeysMode: () =>
        termRef.current?.modes.applicationCursorKeysMode ?? false,
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, focus]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 p-[10px_8px]"
      // Tap-highlight reset (spec §4.2) — no flash on touch-to-focus.
      style={{ background: "#2b2622", WebkitTapHighlightColor: "transparent" }}
    />
  );
}
