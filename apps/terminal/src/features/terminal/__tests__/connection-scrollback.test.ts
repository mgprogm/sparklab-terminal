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

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
}

let wsInstances: FakeWebSocket[];
const originalWebSocket = globalThis.WebSocket;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  wsInstances = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
    FakeWebSocket as unknown as typeof WebSocket;
  process.env.NEXT_PUBLIC_GATEWAY_URL = "http://localhost:3007";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  delete process.env.NEXT_PUBLIC_GATEWAY_URL;
});

function makeConn(rows = 24) {
  const term = { cols: 80, rows, write: vi.fn(), reset: vi.fn() };
  const callbacks: ConnectionCallbacks = {
    onStatus: vi.fn(),
    onSessionError: vi.fn(),
  };
  return { conn: new Connection("web-test", term as never, callbacks), term };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Connection scrollback restore", () => {
  it("injects scrollback before frame when fetch completes before first binary message", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lines: "a\nb\nc\nd\ne" }),
    });
    const { conn, term } = makeConn(2);

    conn.connect();
    wsInstances[0]?.simulateOpen();
    await flushPromises();
    wsInstances[0]?.onmessage?.({ data: new ArrayBuffer(3) } as MessageEvent);

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(2);
    expect(term.write.mock.calls[0]?.[0]).toEqual(expect.any(String));
    expect(term.write.mock.calls[0]?.[0]).toContain("a");
    expect(term.write.mock.calls[1]?.[0]).toBeInstanceOf(Uint8Array);
  });

  it("proceeds without scrollback when fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const { conn, term } = makeConn();

    conn.connect();
    wsInstances[0]?.simulateOpen();
    await flushPromises();
    wsInstances[0]?.onmessage?.({ data: new ArrayBuffer(3) } as MessageEvent);

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
  });

  it("does not inject scrollback when fetch not yet done at first frame time", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { conn, term } = makeConn();

    conn.connect();
    wsInstances[0]?.simulateOpen();
    wsInstances[0]?.onmessage?.({ data: new ArrayBuffer(3) } as MessageEvent);

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledTimes(1);
    expect(term.write.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
  });

  it("does not fetch scrollback when noReconnect is set", () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lines: "" }),
    });
    const { conn } = makeConn();

    conn.connect();
    conn.dispose();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
