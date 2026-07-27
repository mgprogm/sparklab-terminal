import type { WebSocket } from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  BrowserHandoffAuthSchema,
  BrowserHandoffInputSchema,
  type AgentWsServerMessage,
} from "@sparklab/shared-types";
import { BrowserRuntime } from "./browser-runtime.js";
import { HandoffTokenManager } from "./browser-handoff-tokens.js";

const TOKEN_TTL_MS = 60_000;
const IDLE_TIMEOUT_MS = 120_000;
const HARD_TIMEOUT_MS = 600_000;
const DISCONNECT_GRACE_MS = 30_000;
const MAX_INPUTS_PER_SECOND = 120;
const FRAME_INTERVAL_MS = 100;

interface HandoffRecord {
  handoffId: string;
  user: string;
  chatId: string;
  browser: BrowserRuntime;
  sendAgent: (frame: AgentWsServerMessage) => void;
  destroyed: (browser: BrowserRuntime, revision: number) => void;
  socket: WebSocket | null;
  expiresAt: number;
  hardExpiresAt?: number;
  tokenTimer: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  disconnectTimer?: NodeJS.Timeout;
  rateSecond: number;
  rateCount: number;
  resumeToken?: string;
  pendingFrame?: Buffer;
  sendingFrameSocket?: WebSocket;
  frameDrainTimer?: NodeJS.Timeout;
  lastFrameSentAt?: number;
}

export class BrowserHandoffBroker {
  private tokens = new HandoffTokenManager();
  private records = new Map<string, HandoffRecord>();

  begin(args: {
    user: string;
    chatId: string;
    browser: BrowserRuntime;
    sendAgent: (frame: AgentWsServerMessage) => void;
    destroyed: (browser: BrowserRuntime, revision: number) => void;
  }): { handoffId: string; token: string; expiresAt: number } {
    args.browser.requestHandoff();
    const issued = this.tokens.issue(
      {
        user: args.user,
        chatId: args.chatId,
        browserId: args.browser.browserId,
      },
      TOKEN_TTL_MS,
    );
    const record: HandoffRecord = {
      ...args,
      handoffId: issued.handoffId,
      socket: null,
      expiresAt: issued.expiresAt,
      tokenTimer: setTimeout(
        () => void this.destroy(issued.handoffId),
        TOKEN_TTL_MS,
      ),
      rateSecond: 0,
      rateCount: 0,
    };
    record.tokenTimer.unref();
    this.records.set(issued.handoffId, record);
    return issued;
  }

  /**
   * Re-publish an existing handoff so the authenticated chat can bring its
   * hidden Browser View back to the foreground. This deliberately preserves
   * the browser lease, socket, one-time credential, cookies, and deadlines.
   */
  reopen(user: string, chatId: string, browserId: string): boolean {
    for (const record of this.records.values()) {
      if (
        record.user !== user ||
        record.chatId !== chatId ||
        record.browser.browserId !== browserId
      )
        continue;
      if (
        record.browser.leaseState !== "pending" &&
        record.browser.leaseState !== "human_active"
      )
        return false;
      record.sendAgent({
        type: "browser_handoff_state",
        browserId,
        handoffId: record.handoffId,
        state:
          record.browser.leaseState === "human_active"
            ? "human_active"
            : "pending",
        expiresAt: record.expiresAt,
      });
      return true;
    }
    return false;
  }

  async accept(
    ws: WebSocket,
    user: string,
    firstFrame: unknown,
  ): Promise<string> {
    if (ws.readyState !== ws.OPEN) throw new Error("handoff_auth_failed");
    const resume = parseResume(firstFrame);
    if (resume) {
      const record = this.records.get(resume.handoffId);
      if (
        !record ||
        record.user !== user ||
        record.socket ||
        record.browser.leaseState !== "human_active" ||
        !record.resumeToken ||
        !secretEqual(record.resumeToken, resume.resumeToken)
      )
        throw new Error("handoff_auth_failed");
      clearTimeout(record.disconnectTimer);
      record.socket = ws;
      this.sendAuthenticated(record);
      return record.handoffId;
    }
    const auth = BrowserHandoffAuthSchema.safeParse(firstFrame);
    if (!auth.success) throw new Error("handoff_auth_failed");
    const record = this.records.get(auth.data.handoffId);
    if (!record || record.socket) throw new Error("handoff_auth_failed");
    if (
      !this.tokens.consume(auth.data.handoffId, auth.data.token, {
        user,
        chatId: record.chatId,
        browserId: record.browser.browserId,
      })
    )
      throw new Error("handoff_auth_failed");
    record.socket = ws;
    try {
      await record.browser.activateHandoff((frame) =>
        this.enqueueFrame(record, frame),
      );
    } catch (error) {
      await this.destroy(record.handoffId);
      throw error;
    }
    if (ws.readyState !== ws.OPEN) {
      record.socket = null;
      record.disconnectTimer = this.timer(
        record.handoffId,
        DISCONNECT_GRACE_MS,
      );
    }
    clearTimeout(record.tokenTimer);
    const now = Date.now();
    record.resumeToken = randomBytes(32).toString("base64url");
    record.hardExpiresAt = now + HARD_TIMEOUT_MS;
    record.expiresAt = Math.min(now + IDLE_TIMEOUT_MS, record.hardExpiresAt);
    record.idleTimer = this.timer(record.handoffId, IDLE_TIMEOUT_MS);
    record.hardTimer = this.timer(record.handoffId, HARD_TIMEOUT_MS);
    if (record.socket) this.sendAuthenticated(record);
    record.sendAgent({
      type: "browser_handoff_state",
      browserId: record.browser.browserId,
      handoffId: record.handoffId,
      state: "human_active",
      expiresAt: record.expiresAt,
    });
    return record.handoffId;
  }

  async input(handoffId: string, raw: unknown): Promise<void> {
    const record = this.records.get(handoffId);
    if (!record || !record.socket) throw new Error("browser_handoff_inactive");
    const event = BrowserHandoffInputSchema.safeParse(raw);
    if (!event.success) throw new Error("browser_input_invalid");
    if (isClipboardShortcut(event.data))
      throw new Error("browser_input_invalid");
    const second = Math.floor(Date.now() / 1_000);
    if (record.rateSecond !== second) {
      record.rateSecond = second;
      record.rateCount = 0;
    }
    if (++record.rateCount > MAX_INPUTS_PER_SECOND)
      throw new Error("browser_input_rate_limited");
    clearTimeout(record.idleTimer);
    record.expiresAt = Math.min(
      Date.now() + IDLE_TIMEOUT_MS,
      record.hardExpiresAt ?? Date.now(),
    );
    record.idleTimer = this.timer(record.handoffId, IDLE_TIMEOUT_MS);
    await record.browser.handoffInput(event.data);
    this.sendStatus(record, event.data.type);
  }

  async finish(handoffId: string, user: string, chatId: string): Promise<void> {
    const record = this.owned(handoffId, user, chatId);
    if (record.browser.leaseState !== "human_active")
      throw new Error("browser_handoff_inactive");
    this.clear(record);
    try {
      await record.browser.finishHandoff();
    } catch (error) {
      await this.destroy(handoffId);
      throw error;
    }
    this.records.delete(handoffId);
    this.tokens.revoke(handoffId);
    record.socket?.close(1000, "handoff complete");
    record.sendAgent({
      type: "browser_handoff_state",
      browserId: record.browser.browserId,
      handoffId,
      state: "agent_active",
    });
  }

  async cancel(handoffId: string, user: string, chatId: string): Promise<void> {
    this.owned(handoffId, user, chatId);
    await this.destroy(handoffId);
  }

  disconnected(handoffId: string, socket: WebSocket): void {
    const record = this.records.get(handoffId);
    if (!record || record.socket !== socket) return;
    record.socket = null;
    record.pendingFrame = undefined;
    if (record.sendingFrameSocket === socket)
      record.sendingFrameSocket = undefined;
    clearTimeout(record.frameDrainTimer);
    record.frameDrainTimer = undefined;
    record.disconnectTimer = this.timer(handoffId, DISCONNECT_GRACE_MS);
  }

  async revokeForChat(chatId: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (record.chatId === chatId)
        pending.push(this.destroy(record.handoffId));
    }
    await Promise.all(pending);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.records.keys()].map((id) => this.destroy(id)));
  }

  async revokeBrowser(browserId: string): Promise<boolean> {
    const record = [...this.records.values()].find(
      (candidate) => candidate.browser.browserId === browserId,
    );
    if (!record) return false;
    await this.destroy(record.handoffId);
    return true;
  }

  attachChat(
    chatId: string,
    user: string,
    sendAgent: (frame: AgentWsServerMessage) => void,
    destroyed: (browser: BrowserRuntime, revision: number) => void,
  ): BrowserRuntime | null {
    for (const record of this.records.values()) {
      if (record.chatId !== chatId || record.user !== user) continue;
      record.sendAgent = sendAgent;
      record.destroyed = destroyed;
      record.sendAgent({
        type: "browser_handoff_state",
        browserId: record.browser.browserId,
        handoffId: record.handoffId,
        state:
          record.browser.leaseState === "human_active"
            ? "human_active"
            : "pending",
        expiresAt: record.expiresAt,
      });
      return record.browser;
    }
    return null;
  }

  private owned(
    handoffId: string,
    user: string,
    chatId: string,
  ): HandoffRecord {
    const record = this.records.get(handoffId);
    if (!record || record.user !== user || record.chatId !== chatId)
      throw new Error("browser_handoff_not_found");
    return record;
  }

  private timer(handoffId: string, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => void this.destroy(handoffId), ms);
    timer.unref();
    return timer;
  }

  private async destroy(handoffId: string): Promise<void> {
    const record = this.records.get(handoffId);
    if (!record) return;
    this.records.delete(handoffId);
    this.tokens.revoke(handoffId);
    this.clear(record);
    record.socket?.close(4000, "browser session closed");
    const revision = await record.browser.dispose();
    record.sendAgent({
      type: "browser_handoff_state",
      browserId: record.browser.browserId,
      handoffId,
      state: "closed",
    });
    record.destroyed(record.browser, revision);
  }

  private clear(record: HandoffRecord): void {
    clearTimeout(record.tokenTimer);
    clearTimeout(record.idleTimer);
    clearTimeout(record.hardTimer);
    clearTimeout(record.disconnectTimer);
    clearTimeout(record.frameDrainTimer);
    record.pendingFrame = undefined;
    record.sendingFrameSocket = undefined;
    record.frameDrainTimer = undefined;
  }

  private sendAuthenticated(record: HandoffRecord): void {
    if (!record.resumeToken) return;
    this.sendControl(record, {
      type: "authenticated",
      resumeToken: record.resumeToken,
      expiresAt: record.expiresAt,
      hardExpiresAt: record.hardExpiresAt,
    });
  }

  private sendStatus(
    record: HandoffRecord,
    inputType: import("@sparklab/shared-types").BrowserHandoffInput["type"],
  ): void {
    // This is a bounded transport/adapter ACK, not a DOM-effect assertion.
    // Never echo pointer coordinates, actions, keys, or typed values here.
    this.sendControl(record, {
      type: "activity",
      inputType,
      expiresAt: record.expiresAt,
      hardExpiresAt: record.hardExpiresAt,
    });
  }

  private sendControl(record: HandoffRecord, value: unknown): void {
    const socket = record.socket;
    if (socket && socket.readyState === socket.OPEN)
      socket.send(JSON.stringify(value));
  }

  private enqueueFrame(record: HandoffRecord, frame: Buffer): void {
    // CDP can outpace a slow client. Retain only the newest unsent frame so
    // latency and memory stay bounded while preserving the latest view.
    record.pendingFrame = frame;
    this.flushFrame(record);
  }

  private flushFrame(record: HandoffRecord): void {
    const socket = record.socket;
    if (
      !socket ||
      socket.readyState !== socket.OPEN ||
      !record.pendingFrame ||
      record.sendingFrameSocket
    )
      return;
    if (socket.bufferedAmount > 0) {
      if (!record.frameDrainTimer) {
        record.frameDrainTimer = setTimeout(() => {
          record.frameDrainTimer = undefined;
          this.flushFrame(record);
        }, 10);
        record.frameDrainTimer.unref();
      }
      return;
    }
    const frameDelay = Math.max(
      0,
      FRAME_INTERVAL_MS - (Date.now() - (record.lastFrameSentAt ?? 0)),
    );
    if (frameDelay > 0) {
      if (!record.frameDrainTimer) {
        record.frameDrainTimer = setTimeout(() => {
          record.frameDrainTimer = undefined;
          this.flushFrame(record);
        }, frameDelay);
        record.frameDrainTimer.unref();
      }
      return;
    }
    const frame = record.pendingFrame;
    record.pendingFrame = undefined;
    record.sendingFrameSocket = socket;
    record.lastFrameSentAt = Date.now();
    socket.send(frame, { binary: true }, () => {
      if (record.sendingFrameSocket !== socket) return;
      record.sendingFrameSocket = undefined;
      this.flushFrame(record);
    });
  }
}

function parseResume(
  value: unknown,
): { handoffId: string; resumeToken: string } | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  if (
    frame.type !== "resume" ||
    typeof frame.handoffId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      frame.handoffId,
    ) ||
    typeof frame.resumeToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(frame.resumeToken) ||
    Object.keys(frame).length !== 3
  )
    return null;
  return { handoffId: frame.handoffId, resumeToken: frame.resumeToken };
}

function secretEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isClipboardShortcut(
  event: import("@sparklab/shared-types").BrowserHandoffInput,
): boolean {
  if (event.type !== "key" || event.action !== "down") return false;
  const command =
    event.modifiers.includes("Control") || event.modifiers.includes("Meta");
  if (command && ["c", "v", "x"].includes(event.key.toLowerCase())) return true;
  return event.code === "Insert" && event.modifiers.includes("Shift");
}
