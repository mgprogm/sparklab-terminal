import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocket } from "ws";
import type { BrowserRuntime } from "./browser-runtime.js";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.BROWSER_HANDOFF_TRANSPORT ??= "webrtc-preferred";
const { BrowserHandoffBroker } = await import("./browser-handoff-broker.js");
const {
  ignoreScreencastAckFailure,
  interactiveViewportOverrideParams,
  mouseEventParams,
  screencastAckDelay,
} = await import("./browser-session-host.js");

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
  const reopened = frames.at(-1) as {
    expiresAt: number;
    hardExpiresAt: number;
  };
  assert.deepEqual(reopened, {
    type: "browser_handoff_state",
    browserId: "browser-1",
    handoffId: issued.handoffId,
    state: "human_active",
    expiresAt: reopened.expiresAt,
    hardExpiresAt: reopened.hardExpiresAt,
  });
  assert.ok(reopened.hardExpiresAt >= reopened.expiresAt);
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

test("post-auth transport negotiation remains on JPEG and heartbeat is bounded", async () => {
  const { broker, issued } = fixture();
  const socket = new FakeSocket();
  await broker.accept(socket as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  assert.match(String(socket.sent[1] ?? ""), /transport_capabilities/);
  await broker.input(issued.handoffId, {
    type: "capabilities",
    protocolVersion: 1,
    transports: ["webrtc", "jpeg_ws"],
    videoCodecs: ["VP8"],
    trickleIce: true,
  });
  assert.match(String(socket.sent.at(-1)), /"transport":"jpeg_ws"/);
  await broker.input(issued.handoffId, {
    type: "handoff_heartbeat",
    sequence: 7,
  });
  assert.deepEqual(JSON.parse(String(socket.sent.at(-1))), {
    type: "handoff_heartbeat_ack",
    sequence: 7,
  });
  await assert.rejects(
    broker.input(issued.handoffId, {
      type: "webrtc_answer",
      negotiationId: "123e4567-e89b-12d3-a456-426614174000",
      description: { type: "answer", sdp: "v=0\r\n" },
    }),
    /browser_webrtc_not_negotiating/,
  );
  await broker.cancel(issued.handoffId, "alice", "chat-1");
});

test("post-auth messages are rate limited per handoff", async () => {
  const { broker, issued } = fixture();
  const socket = new FakeSocket();
  await broker.accept(socket as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  for (let sequence = 0; sequence < 120; sequence++)
    await broker.input(issued.handoffId, {
      type: "handoff_heartbeat",
      sequence,
    });
  await assert.rejects(
    broker.input(issued.handoffId, {
      type: "handoff_heartbeat",
      sequence: 120,
    }),
    /browser_input_rate_limited/,
  );
  await broker.cancel(issued.handoffId, "alice", "chat-1");
});

test("provider seam orders offer, answer, ICE and connected state", async () => {
  const peer = {
    offer: { type: "offer" as const, sdp: "v=0\r\noffer" },
    answers: [] as unknown[],
    candidates: [] as unknown[],
    closed: false,
    async acceptAnswer(value: unknown) {
      this.answers.push(value);
    },
    async addRemoteCandidate(value: unknown) {
      this.candidates.push(value);
    },
    close() {
      this.closed = true;
    },
  };
  let notifyState:
    ((state: "connected" | "failed" | "closed") => void) | undefined;
  const broker = new BrowserHandoffBroker({
    available: true,
    async createPeer(args) {
      notifyState = args.onState;
      args.onCandidate({ candidate: "candidate:server" });
      return peer;
    },
  });
  const browser = new FakeBrowser();
  const issued = broker.begin({
    user: "alice",
    chatId: "chat-1",
    browser: browser as unknown as BrowserRuntime,
    sendAgent: () => undefined,
    destroyed: () => undefined,
  });
  const socket = new FakeSocket();
  await broker.accept(socket as unknown as WebSocket, "alice", {
    type: "auth",
    handoffId: issued.handoffId,
    token: issued.token,
  });
  await broker.input(issued.handoffId, {
    type: "capabilities",
    protocolVersion: 1,
    transports: ["webrtc", "jpeg_ws"],
    videoCodecs: ["VP8"],
    trickleIce: true,
  });
  const offer = socket.sent
    .map((value) => (typeof value === "string" ? JSON.parse(value) : null))
    .find((value) => value?.type === "webrtc_offer") as {
    negotiationId: string;
  };
  assert.ok(offer.negotiationId);
  await broker.input(issued.handoffId, {
    type: "webrtc_ice_candidate",
    negotiationId: offer.negotiationId,
    candidate: "candidate:client",
  });
  await broker.input(issued.handoffId, {
    type: "webrtc_answer",
    negotiationId: offer.negotiationId,
    description: { type: "answer", sdp: "v=0\r\nanswer" },
  });
  assert.equal(peer.candidates.length, 1);
  assert.equal(peer.answers.length, 1);
  notifyState?.("connected");
  assert.match(String(socket.sent.at(-1)), /"transport":"webrtc"/);
  assert.match(String(socket.sent.at(-1)), /"state":"connected"/);
  notifyState?.("failed");
  assert.match(String(socket.sent.at(-1)), /"transport":"jpeg_ws"/);
  assert.match(String(socket.sent.at(-1)), /"state":"fallback"/);
  assert.equal(peer.closed, true);
  await broker.finish(issued.handoffId, "alice", "chat-1");
  assert.equal(peer.closed, true);
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

test("interactive capture viewport keeps JPEG pixels aligned with CDP input", () => {
  assert.deepEqual(interactiveViewportOverrideParams(), {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.deepEqual(
    interactiveViewportOverrideParams({ width: 1920, height: 1080 }),
    {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    },
  );
});

test("screencast acknowledgements pace capture at the transport frame rate", () => {
  assert.equal(screencastAckDelay(1_000, 0), 0);
  assert.equal(screencastAckDelay(1_050, 1_000), 50);
  assert.equal(screencastAckDelay(1_100, 1_000), 0);
  assert.equal(screencastAckDelay(1_150, 1_000), 0);
});
