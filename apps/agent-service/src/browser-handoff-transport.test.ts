import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.BROWSER_HANDOFF_STUN_URLS ??= "stun:stun.example.test:3478";
process.env.BROWSER_HANDOFF_TURN_URLS ??= "turns:turn.example.test:5349";
process.env.BROWSER_HANDOFF_TURN_SECRET ??= "test-turn-shared-secret";
const { BrowserHandoffTransportMachine, createHandoffIceServers } =
  await import("./browser-handoff-transport.js");

test("transport state machine defaults to the backward-compatible JPEG path", () => {
  const machine = new BrowserHandoffTransportMachine();
  assert.deepEqual(
    machine.select({
      preferWebRtc: false,
      clientSupportsWebRtc: true,
      providerAvailable: false,
      peerCapacity: true,
    }),
    { transport: "jpeg_ws" },
  );
  assert.equal(machine.state, "jpeg_active");
});

test("preferred WebRTC falls back when the media provider is unavailable", () => {
  const machine = new BrowserHandoffTransportMachine();
  assert.deepEqual(
    machine.select({
      preferWebRtc: true,
      clientSupportsWebRtc: true,
      providerAvailable: false,
      peerCapacity: true,
    }),
    { transport: "jpeg_ws", reason: "media_provider_unavailable" },
  );
  assert.equal(machine.state, "fallback");
});

test("WebRTC transition is explicit and rejects invalid ordering", () => {
  const machine = new BrowserHandoffTransportMachine();
  assert.deepEqual(
    machine.select({
      preferWebRtc: true,
      clientSupportsWebRtc: true,
      providerAvailable: true,
      peerCapacity: true,
    }),
    { transport: "webrtc" },
  );
  assert.equal(machine.state, "webrtc_negotiating");
  machine.connected();
  assert.equal(machine.state, "webrtc_active");
  machine.fallback("ice_failed");
  assert.equal(machine.state, "fallback");
  machine.close();
  assert.throws(() => machine.fallback("peer_failed"));
});

test("a resumed socket starts a fresh capability exchange", () => {
  const machine = new BrowserHandoffTransportMachine();
  machine.select({
    preferWebRtc: true,
    clientSupportsWebRtc: true,
    providerAvailable: true,
    peerCapacity: true,
  });
  machine.resetForReconnect();
  assert.equal(machine.state, "awaiting_capabilities");
  assert.deepEqual(
    machine.select({
      preferWebRtc: false,
      clientSupportsWebRtc: true,
      providerAvailable: true,
      peerCapacity: true,
    }),
    { transport: "jpeg_ws" },
  );
});

test("TURN REST credentials are short-lived and hide handoff identity", () => {
  const servers = createHandoffIceServers(
    "123e4567-e89b-12d3-a456-426614174000",
    1_700_000_000_000,
  );
  assert.deepEqual(servers[0], { urls: "stun:stun.example.test:3478" });
  const turn = servers[1];
  assert.ok(turn && Array.isArray(turn.urls));
  assert.match(turn.username ?? "", /^1700000600:[0-9a-f]{16}$/);
  assert.ok((turn.credential?.length ?? 0) >= 20);
  assert.doesNotMatch(
    turn.username ?? "",
    /123e4567-e89b-12d3-a456-426614174000/,
  );
});
