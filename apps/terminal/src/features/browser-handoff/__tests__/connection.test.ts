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
const originalPeerConnection = globalThis.RTCPeerConnection;
const originalRtpReceiver = globalThis.RTCRtpReceiver;

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  candidates: RTCIceCandidateInit[] = [];

  constructor(readonly configuration: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\nanswer" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  close() {
    this.connectionState = "closed";
  }
}

describe("BrowserHandoffConnection", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });
  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.RTCPeerConnection = originalPeerConnection;
    globalThis.RTCRtpReceiver = originalRtpReceiver;
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

  it("advertises browser capabilities without changing the authenticated URL", () => {
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      { onConnectionState: vi.fn() },
    );
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "transport_capabilities",
        protocolVersion: 1,
        preferred: "webrtc",
        available: ["jpeg_ws"],
        videoCodecs: [],
        iceServers: [],
        negotiationTimeoutMs: 8000,
      }),
    });
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: "capabilities",
      protocolVersion: 1,
      transports: ["jpeg_ws"],
      videoCodecs: [],
      trickleIce: false,
    });
    expect(socket.url).not.toContain("secret-token");
  });

  it("orders early ICE before answering a bounded WebRTC offer", async () => {
    globalThis.RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection;
    globalThis.RTCRtpReceiver = {
      getCapabilities: () => ({
        codecs: [
          {
            mimeType: "video/VP8",
            clockRate: 90000,
            channels: 1,
            sdpFmtpLine: "",
          },
        ],
        headerExtensions: [],
      }),
    } as unknown as typeof RTCRtpReceiver;
    const onTransportState = vi.fn();
    const connection = new BrowserHandoffConnection(
      { handoffId: "handoff-1", token: "secret-token" },
      { onConnectionState: vi.fn(), onTransportState },
    );
    connection.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const negotiationId = "123e4567-e89b-12d3-a456-426614174000";
    socket.onmessage?.({
      data: JSON.stringify({
        type: "transport_capabilities",
        protocolVersion: 1,
        preferred: "webrtc",
        available: ["webrtc", "jpeg_ws"],
        videoCodecs: ["VP8"],
        iceServers: [],
        negotiationTimeoutMs: 8000,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "webrtc_ice_candidate",
        negotiationId,
        candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "webrtc_offer",
        negotiationId,
        description: { type: "offer", sdp: "v=0\r\noffer" },
      }),
    });
    await vi.waitFor(() =>
      expect(
        socket.sent.some((value) => value.includes('"type":"webrtc_answer"')),
      ).toBe(true),
    );
    expect(FakePeerConnection.instances[0]?.candidates).toHaveLength(1);
    expect(onTransportState).toHaveBeenCalledWith({
      transport: "webrtc",
      state: "negotiating",
    });
    connection.dispose();
  });
});
