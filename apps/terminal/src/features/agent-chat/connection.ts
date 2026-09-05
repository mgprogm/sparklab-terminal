/**
 * AgentConnection — the chat WebSocket to the agent service, modelled on the
 * terminal's Connection class (heartbeat, exponential backoff, noReconnect on
 * 4001, StrictMode-safe disposal). Each instance is bound to one terminal and
 * reconnects with that terminal plus its resolved chat id. JSON text frames
 * only; every inbound frame is schema-validated and invalid frames are dropped.
 */
import {
  AgentWsServerMessageSchema,
  WS_CLOSE_UNAUTHORIZED,
  type AgentApprovalBehavior,
  type AgentModel,
  type AgentReasoningEffort,
  type AgentWsClientMessage,
  type AgentWsServerMessage,
} from "@sparklab/shared-types";

import {
  BrowserHandoffControlFrameSchema,
  type BrowserHandoffControlFrame,
} from "@/features/browser-handoff";

const HEARTBEAT_MS = 25_000;
const BACKOFF = [1000, 2000, 4000, 8000, 15_000] as const;

export interface AgentConnectionCallbacks {
  onFrame: (frame: AgentWsServerMessage) => void;
  onHandoffFrame?: (frame: BrowserHandoffControlFrame) => void;
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
  private snapshotSeq = 0;
  private deliveredSeq = 0;
  private readonly agentUrl: string;

  constructor(
    private readonly callbacks: AgentConnectionCallbacks,
    private readonly terminalSessionId: string,
    private resumeChatId: string | null = null,
    private readonly forceNewChat = false,
  ) {
    this.agentUrl =
      process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:3009";
  }

  connect(): void {
    if (this.noReconnect) return;
    const proto = this.agentUrl.startsWith("https") ? "wss" : "ws";
    const host = this.agentUrl.replace(/^https?:\/\//, "");
    const params = new URLSearchParams({
      terminalSessionId: this.terminalSessionId,
    });
    if (this.resumeChatId) params.set("resumeChatId", this.resumeChatId);
    if (this.forceNewChat) params.set("newChat", "1");
    const ws = new WebSocket(`${proto}://${host}/agent?${params.toString()}`);
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
      const handoff = BrowserHandoffControlFrameSchema.safeParse(parsed);
      if (handoff.success) {
        this.callbacks.onHandoffFrame?.(handoff.data);
        return;
      }
      const result = AgentWsServerMessageSchema.safeParse(parsed);
      if (!result.success) return;
      const frame = result.data;
      if (frame.type === "agent_snapshot") {
        this.snapshotSeq = frame.seq;
        this.deliveredSeq = Math.max(this.deliveredSeq, frame.seq);
        return;
      }
      if (frame.type === "agent_event") {
        if (frame.seq <= this.snapshotSeq || frame.seq <= this.deliveredSeq)
          return;
        const event = AgentWsServerMessageSchema.safeParse(frame.frame);
        if (
          !event.success ||
          event.data.type === "agent_event" ||
          event.data.type === "agent_snapshot"
        )
          return;
        this.deliveredSeq = frame.seq;
        // Browser-handoff control frames (ready/state) are broadcast through
        // the same seq-tracked agent_event envelope as every other frame, so
        // they must be re-checked here too — not just at the top level below,
        // which only ever sees an already-unwrapped frame in practice.
        const innerHandoff = BrowserHandoffControlFrameSchema.safeParse(
          event.data,
        );
        if (innerHandoff.success) {
          this.callbacks.onHandoffFrame?.(innerHandoff.data);
          return;
        }
        this.callbacks.onFrame(event.data);
        return;
      }
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

  sendUserMessage(
    text: string,
    activeSessionId?: string,
    model?: AgentModel,
    reasoningEffort?: AgentReasoningEffort,
    openrouterModelId?: string,
  ): void {
    this.sendRaw({
      type: "user_message",
      text,
      activeSessionId,
      model,
      reasoningEffort,
      openrouterModelId,
    });
  }

  sendApproval(requestId: string, behavior: AgentApprovalBehavior): void {
    this.sendRaw({ type: "approval_response", requestId, behavior });
  }

  interrupt(): void {
    this.sendRaw({ type: "interrupt" });
  }

  acknowledgeRecovery(behavior: "verified" | "cancelled"): void {
    this.sendRaw({ type: "recovery_ack", behavior });
  }

  listChats(): void {
    this.sendRaw({ type: "list_chats" });
  }

  requestOpenRouterModels(): void {
    this.sendRaw({ type: "openrouter_models_request" });
  }

  deleteChat(chatId: string): void {
    this.sendRaw({ type: "delete_chat", chatId });
  }

  requestBrowserHandoff(browserId: string): void {
    this.sendRaw({ type: "browser_handoff_request", browserId });
  }

  finishBrowserHandoff(handoffId: string): void {
    this.sendRaw({ type: "browser_handoff_finish", handoffId });
  }

  cancelBrowserHandoff(handoffId: string): void {
    this.sendRaw({ type: "browser_handoff_cancel", handoffId });
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
