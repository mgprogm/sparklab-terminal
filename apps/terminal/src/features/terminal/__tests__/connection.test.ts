/**
 * @vitest-environment node
 *
 * Connection class unit tests — the crown jewel.
 *
 * Runs in Node environment (no jsdom). We stub global.WebSocket with a
 * minimal fake that exposes the static constants the code reads.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { Connection, type ConnectionCallbacks } from "../connection";

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  sent: unknown[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    // Simulate async onclose
    if (this.onclose) {
      queueMicrotask(() => this.onclose?.({} as CloseEvent));
    }
  }

  // Test helpers
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  simulateBinaryMessage(data: ArrayBuffer) {
    this.onmessage?.({ data } as MessageEvent);
  }

  simulateTextMessage(json: object) {
    this.onmessage?.({ data: JSON.stringify(json) } as MessageEvent);
  }

  simulateClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  }

  simulateError() {
    this.onerror?.({} as Event);
  }
}

// ---------------------------------------------------------------------------
// Fake Terminal
// ---------------------------------------------------------------------------

function createFakeTerminal() {
  return {
    cols: 80,
    rows: 24,
    write: vi.fn(),
    reset: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let wsInstances: FakeWebSocket[];
let originalWebSocket: typeof globalThis.WebSocket;
let originalEnv: string | undefined;

function setupGlobalWebSocket() {
  wsInstances = [];
  originalWebSocket = globalThis.WebSocket;
  originalEnv = process.env.NEXT_PUBLIC_GATEWAY_URL;
  process.env.NEXT_PUBLIC_GATEWAY_URL = "http://localhost:3007";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      wsInstances.push(this);
    }
  };
}

function teardownGlobalWebSocket() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = originalWebSocket;
  if (originalEnv === undefined) {
    delete process.env.NEXT_PUBLIC_GATEWAY_URL;
  } else {
    process.env.NEXT_PUBLIC_GATEWAY_URL = originalEnv;
  }
}

function createConnection(
  sessionId = "web-test-session",
  term?: ReturnType<typeof createFakeTerminal>,
) {
  const t = term ?? createFakeTerminal();
  const callbacks: ConnectionCallbacks = {
    onStatus: vi.fn(),
    onSessionError: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conn = new Connection(sessionId, t as any, callbacks);
  return { conn, term: t, callbacks };
}

function latestWs(): FakeWebSocket {
  return wsInstances[wsInstances.length - 1]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Connection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setupGlobalWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    teardownGlobalWebSocket();
  });

  // --- Basic lifecycle ---

  describe("connect()", () => {
    it("creates a WebSocket with correct URL", () => {
      const { conn } = createConnection("web-my-session");
      conn.connect();
      expect(wsInstances).toHaveLength(1);
      expect(latestWs().url).toBe(
        "ws://localhost:3007/attach?session=web-my-session",
      );
    });

    it("sets binaryType to arraybuffer", () => {
      const { conn } = createConnection();
      conn.connect();
      expect(latestWs().binaryType).toBe("arraybuffer");
    });

    it("reports connecting status", () => {
      const { conn, callbacks } = createConnection();
      conn.connect();
      expect(callbacks.onStatus).toHaveBeenCalledWith(
        "reconnecting",
        "connecting...",
      );
    });

    it("reports connected on open", () => {
      const { conn, callbacks } = createConnection();
      conn.connect();
      latestWs().simulateOpen();
      expect(callbacks.onStatus).toHaveBeenCalledWith("connected", "connected");
    });

    it("sends resize on open", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();
      const sent = latestWs().sent;
      const resizeMsg = sent.find((s) => {
        try {
          const parsed = JSON.parse(s as string) as { type: string };
          return parsed.type === "resize";
        } catch {
          return false;
        }
      });
      expect(resizeMsg).toBeDefined();
    });

    it("uses wss for https gateway URL", () => {
      process.env.NEXT_PUBLIC_GATEWAY_URL = "https://secure.example.com";
      const { conn } = createConnection();
      conn.connect();
      expect(latestWs().url).toMatch(/^wss:\/\//);
    });
  });

  // --- Binary frame handling ---

  describe("binary frames → term.write(Uint8Array)", () => {
    it("writes binary data as Uint8Array to terminal", () => {
      const { conn, term } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      const data = new TextEncoder().encode("hello").buffer;
      latestWs().simulateBinaryMessage(data);

      // First binary frame triggers reset + write
      expect(term.reset).toHaveBeenCalledTimes(1);
      expect(term.write).toHaveBeenCalledTimes(1);
      const arg = term.write.mock.calls[0]![0] as Uint8Array;
      expect(arg).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(arg)).toBe("hello");
    });
  });

  // --- freshConnect: term.reset() exactly once ---

  describe("freshConnect → term.reset()", () => {
    it("calls term.reset() on the first binary frame after connect", () => {
      const { conn, term } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      const data = new Uint8Array([65]).buffer; // 'A'
      latestWs().simulateBinaryMessage(data);

      expect(term.reset).toHaveBeenCalledTimes(1);
    });

    it("does NOT call term.reset() on subsequent binary frames", () => {
      const { conn, term } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      const data = new Uint8Array([65]).buffer;
      latestWs().simulateBinaryMessage(data);
      latestWs().simulateBinaryMessage(data);
      latestWs().simulateBinaryMessage(data);

      expect(term.reset).toHaveBeenCalledTimes(1);
    });

    it("calls term.reset() again on reconnect", () => {
      const { conn, term } = createConnection();
      conn.connect();
      const ws1 = latestWs();
      ws1.simulateOpen();
      ws1.simulateBinaryMessage(new Uint8Array([65]).buffer);
      expect(term.reset).toHaveBeenCalledTimes(1);

      // Simulate disconnect + reconnect
      ws1.simulateClose();
      vi.advanceTimersByTime(1000); // first backoff
      const ws2 = latestWs();
      expect(ws2).not.toBe(ws1);
      ws2.simulateOpen();
      ws2.simulateBinaryMessage(new Uint8Array([66]).buffer);

      expect(term.reset).toHaveBeenCalledTimes(2);
    });
  });

  // --- Text frame handling ---

  describe("text frames (JSON control messages)", () => {
    it("handles exit message", () => {
      const { conn, term } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      latestWs().simulateTextMessage({ type: "exit", code: 0 });

      expect(term.write).toHaveBeenCalledWith(
        expect.stringContaining("process exited with code 0"),
      );
    });

    it("handles pong (no crash, activity recorded)", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      // Should not throw
      latestWs().simulateTextMessage({ type: "pong" });
    });

    it("handles error frame → noReconnect + onSessionError", () => {
      const { conn, term, callbacks } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      latestWs().simulateTextMessage({
        type: "error",
        message: "session deleted",
      });

      expect(term.write).toHaveBeenCalledWith(
        expect.stringContaining("session deleted"),
      );
      expect(callbacks.onSessionError).toHaveBeenCalledTimes(1);
      expect(callbacks.onStatus).toHaveBeenCalledWith(
        "disconnected",
        "session deleted",
      );
    });

    it("ignores invalid JSON", () => {
      const { conn, term } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      // Send a string that isn't valid JSON
      latestWs().onmessage?.({ data: "not json" } as MessageEvent);

      // Should not crash; nothing written to term for invalid JSON
    });
  });

  // --- sendResize ---

  describe("sendResize()", () => {
    it("sends JSON text frame with cols/rows", () => {
      const { conn, term } = createConnection();
      term.cols = 120;
      term.rows = 40;
      conn.connect();
      latestWs().simulateOpen();

      // Clear the resize from onopen
      latestWs().sent.length = 0;
      conn.sendResize();

      expect(latestWs().sent).toHaveLength(1);
      const parsed = JSON.parse(latestWs().sent[0] as string) as {
        type: string;
        cols: number;
        rows: number;
      };
      expect(parsed).toEqual({ type: "resize", cols: 120, rows: 40 });
    });

    it("does nothing when ws is not open", () => {
      const { conn } = createConnection();
      conn.connect();
      // ws is still CONNECTING, not OPEN
      conn.sendResize();
      // Only the WebSocket constructor was called, no sends
      expect(latestWs().sent).toHaveLength(0);
    });
  });

  // --- send (passthrough) ---

  describe("send()", () => {
    it("passes data directly to ws.send", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();
      latestWs().sent.length = 0;

      const encoded = new TextEncoder().encode("hello");
      conn.send(encoded);

      expect(latestWs().sent).toHaveLength(1);
      expect(latestWs().sent[0]).toBe(encoded);
    });

    it("does nothing when ws is not open", () => {
      const { conn } = createConnection();
      conn.connect();
      // ws still CONNECTING
      conn.send(new TextEncoder().encode("test"));
      expect(latestWs().sent).toHaveLength(0);
    });
  });

  // --- noReconnect blocks BOTH paths ---

  describe("noReconnect blocks reconnection", () => {
    it("dispose() prevents onclose from triggering reconnect", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();
      const initialCount = wsInstances.length;

      conn.dispose();

      // Advance past all backoff timers
      vi.advanceTimersByTime(60_000);

      expect(wsInstances.length).toBe(initialCount);
    });

    it("error frame prevents onclose from triggering reconnect", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();
      const initialCount = wsInstances.length;

      ws.simulateTextMessage({
        type: "error",
        message: "session gone",
      });

      vi.advanceTimersByTime(60_000);
      expect(wsInstances.length).toBe(initialCount);
    });

    it("dispose() after connect() is a no-op for future connect()", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();
      const initialCount = wsInstances.length;

      conn.dispose();
      // Attempt to reconnect manually
      conn.connect();

      // connect() early-returns because noReconnect is true
      expect(wsInstances.length).toBe(initialCount);
    });
  });

  // --- Exponential backoff ---

  describe("exponential backoff schedule", () => {
    const BACKOFF = [1000, 2000, 4000, 8000, 15_000];

    it("reconnects after each backoff delay", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      for (let i = 0; i < BACKOFF.length; i++) {
        const beforeCount = wsInstances.length;
        latestWs().simulateClose();

        // Advance just short of the delay — no new WS yet
        vi.advanceTimersByTime(BACKOFF[i]! - 1);
        expect(wsInstances.length).toBe(beforeCount);

        // Advance the remaining 1ms — new WS created
        vi.advanceTimersByTime(1);
        expect(wsInstances.length).toBe(beforeCount + 1);
      }
    });

    it("caps at the last backoff value", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();

      // Exhaust all attempts + 2 more
      for (let i = 0; i < BACKOFF.length + 2; i++) {
        latestWs().simulateClose();
        const delay =
          i < BACKOFF.length ? BACKOFF[i]! : BACKOFF[BACKOFF.length - 1]!;
        vi.advanceTimersByTime(delay);
      }

      // Still reconnecting at the cap delay
      const beforeCount = wsInstances.length;
      latestWs().simulateClose();
      vi.advanceTimersByTime(15_000);
      expect(wsInstances.length).toBe(beforeCount + 1);
    });

    it("resets attempt counter on successful open", () => {
      const { conn, callbacks } = createConnection();
      conn.connect();
      latestWs().simulateOpen();
      latestWs().simulateClose();
      vi.advanceTimersByTime(1000); // first backoff
      latestWs().simulateOpen(); // success resets attempt

      // Next disconnect should use first backoff again
      latestWs().simulateClose();
      const beforeCount = wsInstances.length;
      vi.advanceTimersByTime(999);
      expect(wsInstances.length).toBe(beforeCount);
      vi.advanceTimersByTime(1);
      expect(wsInstances.length).toBe(beforeCount + 1);
    });
  });

  // --- Heartbeat ---

  describe("heartbeat", () => {
    const HEARTBEAT_MS = 25_000;

    it("sends ping after heartbeat interval when connection has activity", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();
      ws.sent.length = 0;

      // First tick: gotActivity was set true by onopen
      vi.advanceTimersByTime(HEARTBEAT_MS);

      const pings = ws.sent.filter((s) => {
        try {
          return (JSON.parse(s as string) as { type: string }).type === "ping";
        } catch {
          return false;
        }
      });
      expect(pings.length).toBe(1);
    });

    it("force-closes ws on second idle tick (no activity)", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();

      // First tick: has activity from onopen → sends ping + resets gotActivity
      vi.advanceTimersByTime(HEARTBEAT_MS);
      // gotActivity is now false. No messages arrive...

      // Second tick: no activity → force close
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it("does not force-close if activity arrives between ticks", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();

      // First tick
      vi.advanceTimersByTime(HEARTBEAT_MS);

      // Simulate incoming data (sets gotActivity)
      ws.simulateBinaryMessage(new Uint8Array([65]).buffer);

      // Second tick: activity was recorded → should ping, not close
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    });
  });

  // --- dispose() ---

  describe("dispose()", () => {
    it("clears reconnect timer", () => {
      const { conn } = createConnection();
      conn.connect();
      latestWs().simulateOpen();
      latestWs().simulateClose(); // schedules reconnect
      const beforeCount = wsInstances.length;

      conn.dispose();
      vi.advanceTimersByTime(60_000);

      expect(wsInstances.length).toBe(beforeCount);
    });

    it("clears heartbeat timer", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();

      conn.dispose();
      ws.sent.length = 0;

      vi.advanceTimersByTime(25_000);
      expect(ws.sent).toHaveLength(0);
    });

    it("nullifies ws reference (supersession guard)", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();

      conn.dispose();

      // Late events on the old ws should be ignored
      ws.simulateBinaryMessage(new Uint8Array([65]).buffer);
      // No crash, no term.write (ws !== this.ws because this.ws is null)
    });

    it("detaches event handlers on the old ws", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();

      conn.dispose();

      expect(ws.onopen).toBeNull();
      expect(ws.onmessage).toBeNull();
      expect(ws.onclose).toBeNull();
      expect(ws.onerror).toBeNull();
    });
  });

  // --- Supersession ---

  describe("supersession (old ws events ignored)", () => {
    it("ignores onmessage from old ws after new connect()", () => {
      const { conn, term } = createConnection();
      conn.connect();
      const ws1 = latestWs();
      ws1.simulateOpen();

      // Binary frame to clear freshConnect on ws1
      ws1.simulateBinaryMessage(new Uint8Array([65]).buffer);
      term.reset.mockClear();
      term.write.mockClear();

      // Simulate disconnect without triggering onclose guard (direct ws replacement)
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);

      const ws2 = latestWs();
      expect(ws2).not.toBe(ws1);
      ws2.simulateOpen();

      // Now fire an old message on ws1's handler — should be ignored
      // The guard `if (this.ws !== ws) return` should skip it
      ws1.onmessage?.({
        data: new Uint8Array([99]).buffer,
      } as MessageEvent);

      // term.write should only have the ws2's first frame reset, not ws1's stale data
      // ws1's onmessage was already called above, but the guard returns early
      // because this.ws is now ws2
    });

    it("ignores onclose from old ws after new connect()", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws1 = latestWs();
      ws1.simulateOpen();

      ws1.simulateClose();
      vi.advanceTimersByTime(1000);
      const ws2 = latestWs();
      ws2.simulateOpen();

      const countBefore = wsInstances.length;

      // Fire a stale onclose for ws1 — should not schedule reconnect
      ws1.onclose?.({} as CloseEvent);

      vi.advanceTimersByTime(60_000);
      // No new ws created from the stale close
      expect(wsInstances.length).toBe(countBefore);
    });

    it("ignores onopen from old ws after new connect()", () => {
      const { conn, callbacks } = createConnection();
      conn.connect();
      const ws1 = latestWs();

      // Before ws1 opens, trigger a close + reconnect somehow
      // Actually, let's do: connect, open, close, reconnect, then fire late open on ws1
      ws1.simulateOpen();
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);
      const ws2 = latestWs();

      (callbacks.onStatus as Mock).mockClear();

      // Late open on ws1
      ws1.onopen?.({} as Event);

      // Should not report "connected" for the stale ws
      const connectedCalls = (callbacks.onStatus as Mock).mock.calls.filter(
        (c: unknown[]) => c[0] === "connected",
      );
      expect(connectedCalls).toHaveLength(0);
    });
  });

  // --- WS error handling ---

  describe("ws error", () => {
    it("closes the ws on error (onclose follows)", () => {
      const { conn } = createConnection();
      conn.connect();
      const ws = latestWs();
      ws.simulateOpen();

      ws.simulateError();
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    });
  });
});
