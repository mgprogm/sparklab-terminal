import {
  BrowserHandoffServerControlSchema,
  type BrowserHandoffServerControl,
  type BrowserHandoffFallbackReason,
  type BrowserHandoffTransport,
  type HandoffInput,
} from "./protocol";

import type { HandoffConnectionState } from "./store";

const MAX_FRAME_BYTES = 5 * 1024 * 1024;

interface HandoffCredentials {
  handoffId: string;
  token: string;
  resume?: boolean;
}

interface HandoffCallbacks {
  onConnectionState: (state: HandoffConnectionState) => void;
  onAuthenticated?: () => void;
  onExpiry?: (expiresAt: number, hardExpiresAt?: number) => void;
  onTransportState?: (state: HandoffMediaState) => void;
  onMediaStream?: (stream: MediaStream | null) => void;
}

export interface HandoffMediaState {
  transport: BrowserHandoffTransport;
  state: "idle" | "negotiating" | "connected" | "fallback" | "failed";
  reason?: BrowserHandoffFallbackReason;
}

type InputType = HandoffInput["type"];
const INPUT_TYPES: InputType[] = [
  "pointer",
  "wheel",
  "key",
  "text",
  "resize",
  "ping",
];

function imageType(bytes: Uint8Array): "image/jpeg" | "image/webp" | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Dedicated, memory-only interactive channel. Message bodies are never logged. */
export class BrowserHandoffConnection {
  private ws: WebSocket | null = null;
  private disposed = false;
  private readonly url: string;
  private resumeToken: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectUntil = 0;
  private frameHandler: ((frame: Blob) => void) | null = null;
  private inputAckHandler: ((inputType: InputType) => void) | null = null;
  private latestFrame: Blob | null = null;
  private peer: RTCPeerConnection | null = null;
  private negotiationId: string | null = null;
  private negotiationTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatSequence = 0;
  private iceServers: RTCIceServer[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private earlyCandidates = new Map<string, RTCIceCandidateInit[]>();
  private negotiationTimeoutMs = 8_000;

  constructor(
    private readonly credentials: HandoffCredentials,
    private readonly callbacks: HandoffCallbacks,
  ) {
    this.resumeToken = credentials.resume ? credentials.token : null;
    const base = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:3009";
    const proto = base.startsWith("https") ? "wss" : "ws";
    this.url = `${proto}://${base.replace(/^https?:\/\//, "")}/browser-handoff`;
  }

  connect(): void {
    if (this.disposed) return;
    this.callbacks.onConnectionState(
      this.resumeToken ? "reconnecting" : "connecting",
    );
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || this.disposed) return;
      // Authentication is deliberately the first frame; credentials never enter URLs.
      ws.send(
        JSON.stringify(
          this.resumeToken
            ? {
                type: "resume",
                handoffId: this.credentials.handoffId,
                resumeToken: this.resumeToken,
              }
            : {
                type: "auth",
                handoffId: this.credentials.handoffId,
                token: this.credentials.token,
              },
        ),
      );
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === "string") {
        this.handleControl(event.data);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) return;
      const type = imageType(bytes);
      if (!type) return;
      const frame = new Blob([bytes], { type });
      if (this.frameHandler) this.frameHandler(frame);
      else this.latestFrame = frame;
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.disposed) return;
      this.ws = null;
      this.stopHeartbeat();
      this.closePeer();
      if (this.resumeToken && this.reconnectUntil === 0)
        this.reconnectUntil = Date.now() + 30_000;
      if (this.resumeToken && Date.now() < this.reconnectUntil) {
        this.callbacks.onConnectionState("reconnecting");
        this.reconnectTimer = setTimeout(() => this.connect(), 500);
      } else this.callbacks.onConnectionState("closed");
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      try {
        ws.close();
      } catch {
        // Closing an already-failed socket is harmless.
      }
    };
  }

  send(input: HandoffInput): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(input));
  }

  private sendControl(value: object): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(value));
  }

  /** Keeps binary frames outside React/Zustand and buffers at most one frame. */
  setFrameHandler(handler: ((frame: Blob) => void) | null): void {
    this.frameHandler = handler;
    if (handler && this.latestFrame) {
      const frame = this.latestFrame;
      this.latestFrame = null;
      handler(frame);
    }
  }

  /** Acknowledges only the input kind; typed content and coordinates never return. */
  setInputAckHandler(handler: ((inputType: InputType) => void) | null): void {
    this.inputAckHandler = handler;
  }

  dispose(): void {
    this.disposed = true;
    const ws = this.ws;
    this.ws = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.resumeToken = null;
    this.stopHeartbeat();
    this.closePeer();
    this.frameHandler = null;
    this.inputAckHandler = null;
    this.latestFrame = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Best effort only.
      }
    }
  }

  private handleControl(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    const frame = value as Record<string, unknown>;
    if (
      frame.type === "authenticated" &&
      typeof frame.resumeToken === "string" &&
      frame.resumeToken.length >= 43
    ) {
      const firstAuthentication = !this.credentials.resume;
      this.resumeToken = frame.resumeToken;
      this.reconnectUntil = 0;
      if (firstAuthentication) {
        this.credentials.token = "";
        this.callbacks.onAuthenticated?.();
      }
      this.callbacks.onConnectionState("connected");
      this.startHeartbeat();
    }
    if (
      (frame.type === "authenticated" || frame.type === "activity") &&
      typeof frame.expiresAt === "number"
    ) {
      this.callbacks.onExpiry?.(
        frame.expiresAt,
        typeof frame.hardExpiresAt === "number"
          ? frame.hardExpiresAt
          : undefined,
      );
    }
    if (
      frame.type === "activity" &&
      typeof frame.inputType === "string" &&
      INPUT_TYPES.includes(frame.inputType as InputType)
    )
      this.inputAckHandler?.(frame.inputType as InputType);

    const control = BrowserHandoffServerControlSchema.safeParse(value);
    if (control.success)
      void this.handleTransportControl(control.data).catch(() =>
        this.fallback("peer_failed"),
      );
  }

  private async handleTransportControl(
    frame: BrowserHandoffServerControl,
  ): Promise<void> {
    if (frame.type === "transport_capabilities") {
      this.iceServers = frame.iceServers as RTCIceServer[];
      this.negotiationTimeoutMs = frame.negotiationTimeoutMs;
      const codecs = browserVideoCodecs().filter((codec) =>
        frame.videoCodecs.includes(codec),
      );
      const supportsWebRtc = typeof RTCPeerConnection !== "undefined";
      this.sendControl({
        type: "capabilities",
        protocolVersion: 1,
        transports: supportsWebRtc ? ["webrtc", "jpeg_ws"] : ["jpeg_ws"],
        videoCodecs: codecs,
        trickleIce: supportsWebRtc,
      });
      return;
    }
    if (frame.type === "webrtc_offer") {
      await this.acceptOffer(frame.negotiationId, frame.description);
      return;
    }
    if (frame.type === "webrtc_ice_candidate") {
      const candidate: RTCIceCandidateInit = {
        candidate: frame.candidate,
        sdpMid: frame.sdpMid,
        sdpMLineIndex: frame.sdpMLineIndex,
        usernameFragment: frame.usernameFragment,
      };
      if (!this.negotiationId) {
        const queued = this.earlyCandidates.get(frame.negotiationId) ?? [];
        if (queued.length < 64 && this.earlyCandidates.size < 4) {
          queued.push(candidate);
          this.earlyCandidates.set(frame.negotiationId, queued);
        }
        return;
      }
      if (frame.negotiationId !== this.negotiationId) return;
      if (this.peer?.remoteDescription)
        await this.peer.addIceCandidate(candidate);
      else if (this.pendingCandidates.length < 64)
        this.pendingCandidates.push(candidate);
      return;
    }
    if (frame.type === "transport_state") {
      this.callbacks.onTransportState?.({
        transport: frame.transport,
        state:
          frame.state === "fallback"
            ? "fallback"
            : frame.state === "failed" || frame.state === "closed"
              ? "failed"
              : frame.state === "negotiating"
                ? "negotiating"
                : "connected",
        reason: frame.reason,
      });
      if (frame.transport === "jpeg_ws") this.closePeer();
    }
  }

  private async acceptOffer(
    negotiationId: string,
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    if (typeof RTCPeerConnection === "undefined") {
      this.fallback("client_unsupported", negotiationId);
      return;
    }
    const earlyCandidates = this.earlyCandidates.get(negotiationId) ?? [];
    this.closePeer();
    this.negotiationId = negotiationId;
    this.pendingCandidates = earlyCandidates;
    const peer = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peer = peer;
    this.callbacks.onTransportState?.({
      transport: "webrtc",
      state: "negotiating",
    });
    peer.onicecandidate = (event) => {
      if (!event.candidate || this.peer !== peer) return;
      const candidate = event.candidate.toJSON();
      this.sendControl({
        type: "webrtc_ice_candidate",
        negotiationId,
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      });
    };
    peer.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.callbacks.onMediaStream?.(stream);
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === "connected") {
        if (this.negotiationTimer) clearTimeout(this.negotiationTimer);
        this.negotiationTimer = null;
        this.callbacks.onTransportState?.({
          transport: "webrtc",
          state: "connected",
        });
      } else if (peer.connectionState === "failed") {
        this.fallback("ice_failed", negotiationId);
      }
    };
    await peer.setRemoteDescription(description);
    for (const candidate of this.pendingCandidates.splice(0))
      await peer.addIceCandidate(candidate);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (!peer.localDescription) throw new Error("webrtc_answer_unavailable");
    this.sendControl({
      type: "webrtc_answer",
      negotiationId,
      description: {
        type: "answer",
        sdp: peer.localDescription.sdp,
      },
    });
    this.negotiationTimer = setTimeout(
      () => this.fallback("negotiation_timeout", negotiationId),
      this.negotiationTimeoutMs,
    );
  }

  private fallback(
    reason: BrowserHandoffFallbackReason,
    negotiationId = this.negotiationId ?? undefined,
  ): void {
    this.sendControl({ type: "transport_fallback", negotiationId, reason });
    this.closePeer();
    this.callbacks.onTransportState?.({
      transport: "jpeg_ws",
      state: "fallback",
      reason,
    });
  }

  private closePeer(): void {
    if (this.negotiationTimer) clearTimeout(this.negotiationTimer);
    this.negotiationTimer = null;
    this.pendingCandidates = [];
    this.earlyCandidates.clear();
    this.negotiationId = null;
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    this.callbacks.onMediaStream?.(null);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendControl({
        type: "handoff_heartbeat",
        sequence: ++this.heartbeatSequence,
      });
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

function browserVideoCodecs(): ("VP8" | "H264")[] {
  if (typeof RTCRtpReceiver === "undefined") return [];
  const names = new Set(
    (RTCRtpReceiver.getCapabilities("video")?.codecs ?? []).map((codec) =>
      codec.mimeType.toUpperCase(),
    ),
  );
  return ["VP8", "H264"].filter((codec) => names.has(`VIDEO/${codec}`)) as (
    "VP8" | "H264"
  )[];
}
