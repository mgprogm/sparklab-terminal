// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserHandoffConnection } from "../connection";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
}

const originalWebSocket = globalThis.WebSocket;

describe("BrowserHandoffConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("keeps credentials out of the URL and authenticates in the first frame", () => {
    const onAuthenticated = vi.fn();
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      {
        onConnectionState: vi.fn(),
        onAuthenticated,
      },
    );
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toBe("ws://localhost:3009/browser-handoff");
    expect(socket.url).not.toContain("secret-token");
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "auth",
      handoffId: "handoff-1",
      token: "secret-token",
    });
    expect(onAuthenticated).not.toHaveBeenCalled();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "authenticated",
        resumeToken: "r".repeat(43),
        expiresAt: Date.now() + 1_000,
      }),
    });
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("accepts bounded JPEG/WebP frames and drops arbitrary binary", () => {
    const onFrame = vi.fn();
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      { onConnectionState: vi.fn() },
    );
    connection.setFrameHandler(onFrame);
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({ data: Uint8Array.from([1, 2, 3]).buffer });
    socket.onmessage?.({ data: Uint8Array.from([0xff, 0xd8, 0xff, 0]).buffer });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });

  it("reconnects with a memory-only resume token after disconnect", () => {
    vi.useFakeTimers();
    const onConnectionState = vi.fn();
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      { onConnectionState },
    );
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "authenticated",
        resumeToken: "r".repeat(43),
        expiresAt: Date.now() + 1_000,
      }),
    });
    socket.onclose?.();
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const resumed = FakeWebSocket.instances[1]!;
    resumed.open();
    expect(JSON.parse(resumed.sent[0]!)).toEqual({
      type: "resume",
      handoffId: "handoff-1",
      resumeToken: "r".repeat(43),
    });
    expect(onConnectionState).toHaveBeenLastCalledWith("reconnecting");
    vi.useRealTimers();
  });

  it("buffers only the latest frame until a renderer attaches", () => {
    const onFrame = vi.fn();
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      { onConnectionState: vi.fn() },
    );
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({ data: Uint8Array.from([0xff, 0xd8, 0xff, 1]).buffer });
    socket.onmessage?.({ data: Uint8Array.from([0xff, 0xd8, 0xff, 2]).buffer });
    connection.setFrameHandler(onFrame);
    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
  });

  it("reports a bounded input acknowledgement without echoing input data", () => {
    const acknowledged = vi.fn();
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      { onConnectionState: vi.fn() },
    );
    connection.setInputAckHandler(acknowledged);
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "activity",
        inputType: "pointer",
        expiresAt: Date.now() + 1_000,
      }),
    });
    expect(acknowledged).toHaveBeenCalledWith("pointer");
  });
});
