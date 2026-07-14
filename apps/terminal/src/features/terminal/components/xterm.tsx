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
import { useCallback, useEffect, useRef } from "react";

import "@xterm/xterm/css/xterm.css";

import {
  Connection,
  type ConnectionCallbacks,
  type ConnectionStatus,
} from "../connection";

export interface XTermProps {
  /** The session id to connect to, or null for "no session". */
  sessionId: string | null;
  /** Called when connection status changes. */
  onStatusChange?: (status: ConnectionStatus, text: string) => void;
  /** Called when a server error frame fires (deleted/invalid session). */
  onSessionError?: () => void;
}

// Stable encoder reused across all keystroke sends.
const encoder = new TextEncoder();

export function XTermComponent({
  sessionId,
  onStatusChange,
  onSessionError,
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

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
      fontSize: 14,
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
    const dataDisposable = term.onData((data) => {
      connectionRef.current?.send(encoder.encode(data));
    });

    // Resize: notify the gateway so tmux can adjust.
    const resizeDisposable = term.onResize(() => {
      connectionRef.current?.sendResize();
    });

    // ResizeObserver: refit terminal when container size changes.
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        /* container might be detached */
      }
    });
    ro.observe(container);
    roRef.current = ro;

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

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 p-[10px_8px]"
      style={{ background: "#2b2622" }}
    />
  );
}
