/** Owns agent work independently from browser WebSocket connections. */
import type {
  AgentApprovalBehavior,
  AgentModel,
  AgentReasoningEffort,
  AgentStatusState,
  AgentWsServerMessage,
} from "@sparklab/shared-types";
import { AgentLoop } from "./agent-loop.js";
import type { BrowserHandoffBroker } from "./browser-handoff-broker.js";
import {
  appendRunEvent,
  latestRunForChat,
  unfinishedAssistantText,
  newRunState,
  recoverInterruptedRuns,
  type AgentRunState,
  type RunLifecycle,
  writeRunState,
} from "./agent-run-store.js";

type Send = (frame: AgentWsServerMessage) => void;

interface Subscriber {
  send: Send;
  replaying: boolean;
  queued: Array<{ seq: number; frame: AgentWsServerMessage }>;
}

function isDurableFrame(frame: AgentWsServerMessage): boolean {
  // Browser pixels, URLs, and handoff credentials remain explicitly ephemeral.
  return ![
    "browser_view",
    "browser_closed",
    "browser_handoff_ready",
    "browser_handoff_state",
  ].includes(frame.type);
}

export class AgentRun {
  private readonly subscribers = new Set<Subscriber>();
  private status: AgentStatusState = "idle";
  private streamedText = "";
  private pendingApproval: Extract<
    AgentWsServerMessage,
    { type: "approval_request" }
  > | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private started = false;
  private readonly loop: AgentLoop;
  private state: AgentRunState;
  private recoveryNotice: string | null;
  private readonly recoveredAssistantText: string;

  constructor(
    readonly chatId: string,
    readonly terminalSessionId: string,
    readonly user: string,
    handoffs: BrowserHandoffBroker,
    recoveryNotice: string | null = null,
    recoveredAssistantText = "",
  ) {
    this.state = newRunState(chatId, terminalSessionId, user);
    this.recoveryNotice = recoveryNotice;
    this.recoveredAssistantText = recoveredAssistantText;
    this.loop = new AgentLoop(
      (frame) => this.publish(frame),
      chatId,
      terminalSessionId,
      handoffs,
      user,
    );
  }

  get lifecycle(): RunLifecycle {
    return this.state.lifecycle;
  }

  async init(): Promise<void> {
    await writeRunState(this.state);
    await this.loop.init();
    await this.flush();
  }

  async attach(send: Send): Promise<() => void> {
    await this.flush();
    const snapshotSeq = this.state.lastSeq;
    const subscriber: Subscriber = { send, replaying: true, queued: [] };
    this.subscribers.add(subscriber);
    // The broker keeps browser state independently of the page. Re-publish it
    // through this run so a refreshed chat receives the current lease state.
    this.loop.refreshBrowserHandoff();
    await this.loop.replay(send);
    send({ type: "agent_snapshot", seq: snapshotSeq });
    send({ type: "status", state: this.status });
    if (this.streamedText)
      send({ type: "assistant_delta", text: this.streamedText });
    if (this.pendingApproval) send(this.pendingApproval);
    if (this.recoveredAssistantText)
      send({ type: "assistant_message", text: this.recoveredAssistantText });
    if (this.recoveryNotice)
      send({ type: "recovery_required", message: this.recoveryNotice });
    subscriber.replaying = false;
    for (const event of subscriber.queued) this.sendEvent(subscriber, event);
    subscriber.queued.length = 0;
    return () => this.subscribers.delete(subscriber);
  }

  async handleUserMessage(
    text: string,
    activeSessionId?: string,
    model?: AgentModel,
    reasoningEffort?: AgentReasoningEffort,
  ): Promise<void> {
    await this.loop.handleUserMessage(
      text,
      activeSessionId,
      model,
      reasoningEffort,
    );
    await this.flush();
  }

  onApprovalResponse(requestId: string, behavior: AgentApprovalBehavior): void {
    this.loop.onApprovalResponse(requestId, behavior);
  }

  interrupt(): void {
    this.record("interrupt_requested");
    this.loop.interrupt();
  }

  acknowledgeRecovery(behavior: "verified" | "cancelled"): void {
    if (!this.recoveryNotice) return;
    this.recoveryNotice = null;
    this.record(
      "recovery_acknowledged",
      { behavior },
      {
        type: "recovery_resolved",
        behavior,
      },
    );
  }

  requestBrowserHandoff(browserId: string): void {
    this.loop.requestBrowserHandoff(browserId);
  }

  finishBrowserHandoff(handoffId: string): Promise<void> {
    return this.loop.finishBrowserHandoff(handoffId);
  }

  cancelBrowserHandoff(handoffId: string): Promise<void> {
    return this.loop.cancelBrowserHandoff(handoffId);
  }

  async dispose(): Promise<void> {
    await this.loop.dispose();
    await this.flush();
  }

  private publish(frame: AgentWsServerMessage): void {
    if (frame.type === "status") {
      this.status = frame.state;
      if (frame.state === "thinking" || frame.state === "acting") {
        this.started = true;
        this.state.lifecycle = "running";
      } else if (frame.state === "awaiting_approval") {
        this.started = true;
        this.state.lifecycle = "awaiting_approval";
      } else if (this.started) {
        this.state.lifecycle = "completed";
      }
    }
    if (frame.type === "assistant_delta") this.streamedText += frame.text;
    if (frame.type === "assistant_message" || frame.type === "error")
      this.streamedText = "";
    if (frame.type === "approval_request") this.pendingApproval = frame;
    if (frame.type === "approval_resolved") this.pendingApproval = null;
    if (frame.type === "tool_result") this.pendingApproval = null;
    this.record("frame", isDurableFrame(frame) ? frame : undefined, frame);
  }

  private record(
    kind: string,
    payload?: unknown,
    broadcast?: AgentWsServerMessage,
  ): void {
    this.persistence = this.persistence
      .then(async () => {
        this.state = {
          ...this.state,
          lastSeq: this.state.lastSeq + 1,
          updatedAt: Date.now(),
        };
        await appendRunEvent(this.state.id, {
          seq: this.state.lastSeq,
          at: this.state.updatedAt,
          kind,
          payload,
        });
        await writeRunState(this.state);
        if (!broadcast) return;
        for (const subscriber of this.subscribers) {
          const event = { seq: this.state.lastSeq, frame: broadcast };
          if (subscriber.replaying) subscriber.queued.push(event);
          else this.sendEvent(subscriber, event);
        }
      })
      .catch((error: unknown) => {
        console.error("[agent-run] persistence failed", error);
      });
  }

  private async flush(): Promise<void> {
    await this.persistence;
  }

  private sendEvent(
    subscriber: Subscriber,
    event: { seq: number; frame: AgentWsServerMessage },
  ): void {
    subscriber.send({ type: "agent_event", ...event });
  }
}

export class AgentRunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly opening = new Map<string, Promise<AgentRun>>();

  constructor(private readonly handoffs: BrowserHandoffBroker) {}

  async recover(): Promise<void> {
    const recovered = await recoverInterruptedRuns();
    if (recovered.length > 0)
      console.warn(
        `[agent-run] marked ${recovered.length} interrupted run(s) after restart`,
      );
  }

  async open(
    chatId: string,
    terminalSessionId: string,
    user: string,
  ): Promise<AgentRun> {
    const existing = this.runs.get(chatId);
    if (existing) return this.assertOwner(existing, terminalSessionId, user);
    const pending = this.opening.get(chatId);
    if (pending)
      return this.assertOwner(await pending, terminalSessionId, user);
    const opening = (async () => {
      const previous = await latestRunForChat(chatId);
      const recoveryNotice =
        previous?.lifecycle === "interrupted"
          ? "The previous agent run was interrupted by a service restart. Review the transcript, then send a new message to continue."
          : previous?.lifecycle === "recovery_required"
            ? "A tool was in progress when the service restarted. Its result is unknown, so it was not repeated. Verify the external state before continuing."
            : null;
      const recoveredAssistantText =
        previous?.lifecycle === "interrupted" ||
        previous?.lifecycle === "recovery_required"
          ? await unfinishedAssistantText(previous.id)
          : "";
      const run = new AgentRun(
        chatId,
        terminalSessionId,
        user,
        this.handoffs,
        recoveryNotice,
        recoveredAssistantText,
      );
      await run.init();
      this.runs.set(chatId, run);
      return run;
    })();
    this.opening.set(chatId, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(chatId);
    }
  }

  hasActiveRun(chatId: string): boolean {
    const run = this.runs.get(chatId);
    return (
      run?.lifecycle === "running" || run?.lifecycle === "awaiting_approval"
    );
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.dispose()));
    this.runs.clear();
  }

  private assertOwner(
    run: AgentRun,
    terminalSessionId: string,
    user: string,
  ): AgentRun {
    if (run.terminalSessionId !== terminalSessionId || run.user !== user)
      throw new Error("Chat is already active for another user or terminal");
    return run;
  }
}
