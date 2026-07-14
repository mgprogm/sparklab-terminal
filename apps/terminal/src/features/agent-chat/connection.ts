/**
 * AgentConnection — the chat WebSocket to the agent service, modelled on the
 * terminal's Connection class (heartbeat, exponential backoff, noReconnect on
 * 4001, StrictMode-safe disposal). JSON text frames only; every inbound frame
 * is validated against AgentWsServerMessageSchema and dropped if invalid.
 */
import {
  AgentWsServerMessageSchema,
  WS_CLOSE_UNAUTHORIZED,
  type AgentApprovalBehavior,
  type AgentWsClientMessage,
  type AgentWsServerMessage,
} from "@sparklab/shared-types";

const HEARTBEAT_MS = 25_000;
const BACKOFF = [1000, 2000, 4000, 8000, 15_000] as const;

export interface AgentConnectionCallbacks {
  onFrame: (frame: AgentWsServerMessage) => void;
  onConnected: (connected: boolean) => void;
  onAuthError?: () => void;
}

export class AgentConnection {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private gotActivity = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private noReconnect = false;
  private readonly agentUrl: string;

  constructor(
    private readonly callbacks: AgentConnectionCallbacks,
    private resumeChatId: string | null = null,
  ) {
    this.agentUrl =
      process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:3009";
  }

  connect(): void {
    if (this.noReconnect) return;
    const proto = this.agentUrl.startsWith("https") ? "wss" : "ws";
    const host = this.agentUrl.replace(/^https?:\/\//, "");
    const q = this.resumeChatId
      ? `?resumeChatId=${encodeURIComponent(this.resumeChatId)}`
      : "";
    const ws = new WebSocket(`${proto}://${host}/agent${q}`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.gotActivity = true;
      this.callbacks.onConnected(true);
      this.startHeartbeat();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.gotActivity = true;
      if (typeof ev.data !== "string") return; // chat is JSON-only
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      const result = AgentWsServerMessageSchema.safeParse(parsed);
      if (!result.success) return;
      const frame = result.data;
      if (frame.type === "chat_started") this.resumeChatId = frame.chatId;
      if (frame.type === "error" && frame.message === "unauthorized") {
        this.noReconnect = true;
        this.callbacks.onConnected(false);
        this.callbacks.onAuthError?.();
        return;
      }
      this.callbacks.onFrame(frame);
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.callbacks.onConnected(false);
      if (ev.code === WS_CLOSE_UNAUTHORIZED) {
        this.noReconnect = true;
        this.callbacks.onAuthError?.();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.noReconnect) return;
    const delay =
      BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)] ?? BACKOFF[0]!;
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!this.gotActivity) {
        ws.close();
        return;
      }
      this.gotActivity = false;
      this.sendRaw({ type: "ping" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendRaw(msg: AgentWsClientMessage): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  sendUserMessage(text: string, activeSessionId?: string): void {
    this.sendRaw({ type: "user_message", text, activeSessionId });
  }

  sendApproval(requestId: string, behavior: AgentApprovalBehavior): void {
    this.sendRaw({ type: "approval_response", requestId, behavior });
  }

  interrupt(): void {
    this.sendRaw({ type: "interrupt" });
  }

  listChats(): void {
    this.sendRaw({ type: "list_chats" });
  }

  deleteChat(chatId: string): void {
    this.sendRaw({ type: "delete_chat", chatId });
  }

  dispose(): void {
    this.noReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
  }
}
