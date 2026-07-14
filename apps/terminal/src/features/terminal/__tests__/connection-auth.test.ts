// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Connection, type ConnectionCallbacks } from "../connection";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  url: string;
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    if (this.onclose) queueMicrotask(() => this.onclose?.({} as CloseEvent));
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
}

let wsInstances: FakeWebSocket[];
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.useFakeTimers();
  wsInstances = [];
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  process.env.NEXT_PUBLIC_GATEWAY_URL = "http://localhost:3007";
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  delete process.env.NEXT_PUBLIC_GATEWAY_URL;
});

function makeConn(onAuthError?: () => void) {
  const term = { cols: 80, rows: 24, write: vi.fn(), reset: vi.fn() };
  const callbacks: ConnectionCallbacks = {
    onStatus: vi.fn(),
    onSessionError: vi.fn(),
    onAuthError,
  };
  return {
    conn: new Connection("web-test", term as never, callbacks),
    callbacks,
    term,
  };
}

describe("Connection 4001 auth error", () => {
  it("sets noReconnect on close code 4001", () => {
    const { conn } = makeConn();
    conn.connect();
    wsInstances[0]?.simulateOpen();
    wsInstances[0]?.simulateClose(4001);
    vi.advanceTimersByTime(60_000);
    expect(wsInstances).toHaveLength(1);
  });

  it("calls onAuthError on close code 4001", () => {
    const onAuthError = vi.fn();
    const { conn } = makeConn(onAuthError);
    conn.connect();
    wsInstances[0]?.simulateOpen();
    wsInstances[0]?.simulateClose(4001);
    expect(onAuthError).toHaveBeenCalledTimes(1);
  });

  it("normal close code still reconnects", () => {
    const { conn } = makeConn();
    conn.connect();
    wsInstances[0]?.simulateOpen();
    wsInstances[0]?.simulateClose(1000);
    vi.advanceTimersByTime(1000);
    expect(wsInstances).toHaveLength(2);
  });
});
