import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import type { BrowserRuntime } from "./browser-runtime.js";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
const { BrowserHandoffBroker } = await import("./browser-handoff-broker.js");
const { ignoreScreencastAckFailure, mouseEventParams } =
  await import("./browser-session-host.js");

class FakeBrowser {
  browserId = "browser-1";
  leaseState = "agent_active";
  disposed = false;

  requestHandoff() {
    this.leaseState = "pending";
  }
  onFrame?: (frame: Buffer) => void;

  async activateHandoff(onFrame: (frame: Buffer) => void) {
    this.onFrame = onFrame;
    this.leaseState = "human_active";
  }
  async handoffInput() {}
  async finishHandoff() {
    this.leaseState = "agent_active";
  }
  async dispose() {
    this.disposed = true;
    this.leaseState = "closed";
    return 1;
  }
}

class FakeSocket {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  send(
    value: string | Buffer,
    _options?: unknown,
    callback?: (error?: Error) => void,
  ) {
    this.sent.push(value);
    callback?.();
  }
  close() {
    this.readyState = 3;
  }
}

function fixture() {
  const broker = new BrowserHandoffBroker();
  const browser = new FakeBrowser();
  const frames: unknown[] = [];
  const issued = broker.begin({
    user: "alice",
    chatId: "chat-1",
    browser: browser as unknown as BrowserRuntime,
    sendAgent: (frame) => frames.push(frame),
    destroyed: () => undefined,
  });
  return { broker, browser, frames, issued };
}

test("handoff authenticates once and resumes only with its memory token", async () => {
  const { broker, browser, issued } = fixture();
  const first = new FakeSocket();
  await broker.accept(first as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  assert.equal(browser.leaseState, "human_active");
  const ack = JSON.parse(String(first.sent[0] ?? "null")) as {
    resumeToken?: string;
  };
  assert.equal(ack.resumeToken?.length, 43);

  broker.disconnected(issued.handoffId, first as unknown as WebSocket);
  const resumed = new FakeSocket();
  await broker.accept(resumed as unknown as WebSocket, "alice", {
    type: "resume",
    handoffId: issued.handoffId,
    resumeToken: ack.resumeToken,
  });
  assert.match(String(resumed.sent[0] ?? ""), /authenticated/);

  await broker.finish(issued.handoffId, "alice", "chat-1");
  assert.equal(browser.leaseState, "agent_active");
});

test("reopen republishes an active handoff without replacing its session", async () => {
  const { broker, browser, frames, issued } = fixture();
  const socket = new FakeSocket();
  await broker.accept(socket as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  const frameCount = frames.length;

  assert.equal(broker.reopen("alice", "chat-1", "browser-1"), true);
  assert.equal(browser.leaseState, "human_active");
  assert.equal(socket.readyState, socket.OPEN);
  assert.equal(frames.length, frameCount + 1);
  assert.deepEqual(frames.at(-1), {
    type: "browser_handoff_state",
    browserId: "browser-1",
    handoffId: issued.handoffId,
    state: "human_active",
    expiresAt: (frames.at(-1) as { expiresAt: number }).expiresAt,
  });
  assert.equal(broker.reopen("mallory", "chat-1", "browser-1"), false);

  await broker.finish(issued.handoffId, "alice", "chat-1");
});

test("finish cannot consume a pending handoff and cancel destroys it", async () => {
  const { broker, browser, issued } = fixture();
  await assert.rejects(
    broker.finish(issued.handoffId, "alice", "chat-1"),
    /browser_handoff_inactive/,
  );
  await broker.cancel(issued.handoffId, "alice", "chat-1");
  assert.equal(browser.disposed, true);
});

test("activation failure closes and disposes the session transactionally", async () => {
  const { broker, browser, issued } = fixture();
  browser.activateHandoff = async () => {
    throw new Error("cdp failed");
  };
  await assert.rejects(
    broker.accept(new FakeSocket() as unknown as WebSocket, "alice", {
      type: "auth",
      handoffId: issued.handoffId,
      token: issued.token,
    }),
    /cdp failed/,
  );
  assert.equal(browser.disposed, true);
});

test("a stale socket disconnect cannot detach its resumed replacement", async () => {
  const { broker, browser, issued } = fixture();
  const first = new FakeSocket();
  await broker.accept(first as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  const ack = JSON.parse(String(first.sent[0])) as { resumeToken: string };
  broker.disconnected(issued.handoffId, first as unknown as WebSocket);

  const resumed = new FakeSocket();
  await broker.accept(resumed as unknown as WebSocket, "alice", {
    type: "resume",
    handoffId: issued.handoffId,
    resumeToken: ack.resumeToken,
  });
  broker.disconnected(issued.handoffId, first as unknown as WebSocket);
  await broker.input(issued.handoffId, { type: "ping" });
  assert.equal(browser.leaseState, "human_active");

  await broker.finish(issued.handoffId, "alice", "chat-1");
});

test("binary backpressure keeps and drains only the latest pending frame", async () => {
  const { broker, browser, issued } = fixture();
  const socket = new FakeSocket();
  socket.bufferedAmount = 1;
  await broker.accept(socket as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  browser.onFrame?.(Buffer.from("old"));
  browser.onFrame?.(Buffer.from("latest"));
  assert.equal(socket.sent.some(Buffer.isBuffer), false);

  socket.bufferedAmount = 0;
  await new Promise((resolve) => setTimeout(resolve, 25));
  const binary = socket.sent.filter(Buffer.isBuffer);
  assert.equal(binary.length, 1);
  assert.equal(binary[0]?.toString(), "latest");

  await broker.finish(issued.handoffId, "alice", "chat-1");
});

test("frame pacing sends at most ten frames per second and keeps the latest", async () => {
  const { broker, browser, issued } = fixture();
  const socket = new FakeSocket();
  await broker.accept(socket as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  browser.onFrame?.(Buffer.from("first"));
  browser.onFrame?.(Buffer.from("stale"));
  browser.onFrame?.(Buffer.from("latest"));

  assert.deepEqual(
    socket.sent.filter(Buffer.isBuffer).map((frame) => frame.toString()),
    ["first"],
  );
  await new Promise((resolve) => setTimeout(resolve, 115));
  assert.deepEqual(
    socket.sent.filter(Buffer.isBuffer).map((frame) => frame.toString()),
    ["first", "latest"],
  );

  await broker.finish(issued.handoffId, "alice", "chat-1");
});

test("malformed resume frames are rejected before a socket is bound", async () => {
  const { broker, issued } = fixture();
  await assert.rejects(
    broker.accept(new FakeSocket() as unknown as WebSocket, "alice", {
      type: "resume",
      handoffId: issued.handoffId,
      resumeToken: "x".repeat(43),
      extra: true,
    }),
    /handoff_auth_failed/,
  );
  await broker.cancel(issued.handoffId, "alice", "chat-1");
});

test("a failed screencast acknowledgement is consumed", async () => {
  await assert.doesNotReject(
    ignoreScreencastAckFailure(Promise.reject(new Error("target closed"))),
  );
});

test("mouse parameters preserve drag buttons and multi-click count", () => {
  assert.deepEqual(
    mouseEventParams({
      type: "pointer",
      action: "down",
      x: 120,
      y: 80,
      button: "right",
      buttons: ["left", "right"],
      clickCount: 2,
    }),
    {
      type: "mousePressed",
      x: 120,
      y: 80,
      button: "right",
      buttons: 3,
      clickCount: 2,
    },
  );
});
