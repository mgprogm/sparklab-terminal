import type { HandoffInput } from "./protocol";
import type { HandoffConnectionState } from "./store";

const MAX_FRAME_BYTES = 5 * 1024 * 1024;

interface HandoffCredentials {
  handoffId: string;
  token: string;
}

interface HandoffCallbacks {
  onConnectionState: (state: HandoffConnectionState) => void;
  onAuthenticated?: () => void;
  onExpiry?: (expiresAt: number, hardExpiresAt?: number) => void;
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

  constructor(
    private readonly credentials: HandoffCredentials,
    private readonly callbacks: HandoffCallbacks,
  ) {
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
      const firstAuthentication = this.resumeToken === null;
      this.resumeToken = frame.resumeToken;
      this.reconnectUntil = 0;
      if (firstAuthentication) {
        this.credentials.token = "";
        this.callbacks.onAuthenticated?.();
      }
      this.callbacks.onConnectionState("connected");
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
  }
}
