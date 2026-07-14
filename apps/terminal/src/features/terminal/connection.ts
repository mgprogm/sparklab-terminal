/**
 * Connection — port of the vanilla-JS Connection class from
 * apps/terminal-gateway/public/app.js, now in TypeScript.
 *
 * LIFECYCLE (the load-bearing part): all per-connection state lives on a
 * Connection instance — its WebSocket, reconnect timer, heartbeat interval, and
 * its attempt/freshConnect/gotActivity flags. Exactly ONE connection is live at
 * a time. Switching sessions fully disposes the current connection before
 * opening the next, so a backgrounded connection can never fire a stray
 * reconnect that stomps the active one.
 *
 * Two paths can resurrect a dead connection, and dispose() must block BOTH:
 *   1. dispose -> ws.close() -> onclose (fires async) -> scheduleReconnect
 *   2. server {"type":"error"} on a deleted session -> close -> onclose -> loop
 * A single `noReconnect` flag guards scheduleReconnect() and is set by both
 * dispose() and receipt of an error frame.
 *
 * Changes from the original beyond types:
 * - WS URL is derived from NEXT_PUBLIC_GATEWAY_URL (env), not location.host,
 *   because the Next dev server is a different origin and Next rewrites don't
 *   reliably proxy WebSockets.
 * - The `term` reference is passed in via constructor instead of being a global.
 * - Callbacks (`onStatus`, `onSessionError`) replace direct DOM / module-level
 *   function calls (`setStatus`, `refreshSessions`).
 */
import {
  ScrollbackResponseSchema,
  WS_CLOSE_UNAUTHORIZED,
  type WsServerMessage,
} from "@sparklab/shared-types";

import type { Terminal } from "@xterm/xterm";

// ---- Constants (same values as the original) ----
const HEARTBEAT_MS = 25_000;
const BACKOFF = [1000, 2000, 4000, 8000, 15_000] as const;

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface ConnectionCallbacks {
  onStatus: (state: ConnectionStatus, text: string) => void;
  /** Called when the server sends an error frame (deleted session, etc.). */
  onSessionError: () => void;
  /** Called when the server rejects the WebSocket due to authentication. */
  onAuthError?: () => void;
}

/**
 * A single Connection owns one WebSocket's whole lifetime.
 */
export class Connection {
  readonly sessionId: string;
  private readonly term: Terminal;
  private readonly onStatus: ConnectionCallbacks["onStatus"];
  private readonly onSessionError: ConnectionCallbacks["onSessionError"];
  private readonly onAuthError: (() => void) | undefined;

  private ws: WebSocket | null = null;
  private attempt = 0;
  private freshConnect = false;
  private gotActivity = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private noReconnect = false;
  private pendingScrollback: string | null = null;
  private scrollbackFetched = false;

  /** The gateway origin used for WebSocket connections. */
  private readonly gatewayUrl: string;

  constructor(
    sessionId: string,
    term: Terminal,
    callbacks: ConnectionCallbacks,
  ) {
    this.sessionId = sessionId;
    this.term = term;
    this.onStatus = callbacks.onStatus;
    this.onSessionError = callbacks.onSessionError;
    this.onAuthError = callbacks.onAuthError;

    // Derive gateway URL from environment. In production behind a reverse
    // proxy this would be the same origin; in dev it points at the gateway's
    // port directly since Next rewrites can't proxy WS.
    this.gatewayUrl =
      process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3007";
  }

  connect(): void {
    if (this.noReconnect) return;
    this.fetchScrollback();
    const proto = this.gatewayUrl.startsWith("https") ? "wss" : "ws";
    const host = this.gatewayUrl.replace(/^https?:\/\//, "");
    const url = `${proto}://${host}/attach?session=${encodeURIComponent(this.sessionId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer"; // else binary frames arrive as Blob
    this.ws = ws;
    this.freshConnect = true;

    this.onStatus(
      "reconnecting",
      this.attempt === 0 ? "connecting..." : "reconnecting...",
    );

    ws.onopen = () => {
      if (this.ws !== ws) return; // superseded
      this.attempt = 0;
      this.gotActivity = true;
      this.onStatus("connected", "connected");
      this.sendResize();
      this.startHeartbeat();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.gotActivity = true;
      if (typeof ev.data === "string") {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(ev.data) as WsServerMessage;
        } catch {
          return;
        }
        if (msg.type === "error") {
          // Server refused this session (bad prefix / deleted). Do NOT
          // reconnect in a loop — this session is gone.
          this.noReconnect = true;
          this.onStatus("disconnected", msg.message || "session unavailable");
          this.term.write(`\r\n[${msg.message || "session unavailable"}]\r\n`);
          this.dispose();
          // Notify the UI so a deleted/invalid session drops out of the list.
          this.onSessionError();
          return;
        }
        if (msg.type === "exit") {
          this.term.write(
            `\r\n[process exited with code ${String(msg.code)}]\r\n`,
          );
        }
        // pong: nothing to do, activity already recorded.
        return;
      }
      // Binary: raw pty output.
      if (this.freshConnect) {
        // First bytes after (re)connect: reset, inject scrollback, then write frame.
        // tmux's attach redraw (absolute cursor addressing) repaints the live screen
        // on top, pushing the injected history into xterm's scrollback buffer.
        this.term.reset();
        this.freshConnect = false;
        if (this.scrollbackFetched && this.pendingScrollback) {
          // Trim the last term.rows lines to reduce duplication with tmux's redraw.
          const lines = this.pendingScrollback.split("\n");
          const keepCount = Math.max(0, lines.length - this.term.rows);
          if (keepCount > 0) {
            this.term.write(lines.slice(0, keepCount).join("\r\n") + "\r\n");
          }
        }
        this.pendingScrollback = null;
        this.scrollbackFetched = false;
      }
      this.term.write(new Uint8Array(ev.data as ArrayBuffer));
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return; // a superseded socket closing: ignore
      this.stopHeartbeat();
      if (ev.code === WS_CLOSE_UNAUTHORIZED) {
        this.noReconnect = true;
        this.onStatus("disconnected", "unauthorized");
        this.onAuthError?.();
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      // onclose will follow; avoid double-scheduling.
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.noReconnect) return; // disposed or fatal error: never resurrect
    const delay =
      BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] ?? BACKOFF[0]!;
    this.attempt += 1;
    this.onStatus(
      "reconnecting",
      `reconnecting in ${Math.round(delay / 1000)}s...`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private fetchScrollback(): void {
    this.scrollbackFetched = false;
    this.pendingScrollback = null;
    void (async () => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(this.sessionId)}/scrollback?lines=2000`,
        );
        if (this.noReconnect) return;
        if (!res.ok) {
          this.scrollbackFetched = true;
          return;
        }
        const data: unknown = await res.json();
        const parsed = ScrollbackResponseSchema.safeParse(data);
        this.pendingScrollback = parsed.success ? parsed.data.lines : null;
        this.scrollbackFetched = true;
      } catch {
        this.scrollbackFetched = true;
      }
    })();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // If nothing arrived since the last tick, the link is likely dead:
      // force a close to trigger reconnect. Otherwise ping to keep idle
      // proxies alive.
      if (!this.gotActivity) {
        ws.close();
        return;
      }
      this.gotActivity = false;
      ws.send(JSON.stringify({ type: "ping" }));
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  sendResize(): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "resize",
          cols: this.term.cols,
          rows: this.term.rows,
        }),
      );
    }
  }

  send(payload: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  /**
   * Cancel EVERYTHING: block future reconnects, clear the reconnect timer,
   * clear the heartbeat interval, detach handlers, and close the ws. After
   * this no path can call connect() again.
   */
  dispose(): void {
    this.noReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null; // guards in the async onclose/onopen see the supersession
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }
}
