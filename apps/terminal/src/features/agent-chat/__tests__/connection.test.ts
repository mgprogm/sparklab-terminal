// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentConnection } from "../connection";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
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
  receive(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const originalWebSocket = globalThis.WebSocket;

describe("AgentConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  // Regression test for the "Take control" button doing nothing: every
  // outbound frame from the agent service — including browser-handoff
  // control frames — is broadcast wrapped in a seq-tracked `agent_event`
  // envelope (see AgentRunManager.publish). The dedicated top-level
  // BrowserHandoffControlFrameSchema check in onmessage never sees those
  // frames unwrapped in practice, so the agent_event branch must route them
  // to onHandoffFrame itself or they silently fall into the generic onFrame
  // path and get dropped by the chat store's switch (no matching case).
  it("routes a browser_handoff_state frame wrapped in agent_event to onHandoffFrame, not onFrame", () => {
    const onFrame = vi.fn();
    const onHandoffFrame = vi.fn();
    const conn = new AgentConnection(
      { onFrame, onHandoffFrame, onConnected: vi.fn() },
      "session-1",
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    ws.receive({
      type: "agent_event",
      seq: 1,
      frame: {
        type: "browser_handoff_state",
        browserId: "b1",
        handoffId: "11111111-1111-4111-8111-111111111111",
        state: "pending",
        expiresAt: Date.now() + 60_000,
      },
    });

    expect(onHandoffFrame).toHaveBeenCalledTimes(1);
    expect(onHandoffFrame.mock.calls[0]![0]).toMatchObject({
      type: "browser_handoff_state",
      state: "pending",
    });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("still routes an unwrapped browser_handoff_ready frame to onHandoffFrame", () => {
    const onFrame = vi.fn();
    const onHandoffFrame = vi.fn();
    const conn = new AgentConnection(
      { onFrame, onHandoffFrame, onConnected: vi.fn() },
      "session-1",
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    ws.receive({
      type: "browser_handoff_ready",
      browserId: "b1",
      handoffId: "11111111-1111-4111-8111-111111111111",
      token: "t".repeat(43),
      expiresAt: Date.now() + 60_000,
    });

    expect(onHandoffFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("still routes an ordinary agent_event-wrapped frame to onFrame", () => {
    const onFrame = vi.fn();
    const onHandoffFrame = vi.fn();
    const conn = new AgentConnection(
      { onFrame, onHandoffFrame, onConnected: vi.fn() },
      "session-1",
    );
    conn.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    ws.receive({
      type: "agent_event",
      seq: 1,
      frame: { type: "pong" },
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toMatchObject({ type: "pong" });
    expect(onHandoffFrame).not.toHaveBeenCalled();
  });
});
