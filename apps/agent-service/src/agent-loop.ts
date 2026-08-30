/**
 * The custom tool-calling loop — one instance per WebSocket connection.
 *
 * Per user turn: send [system, ...history] + tool defs to gpt-5.6-sol with
 * streaming; relay text deltas; when the model calls tools, run the approval
 * gate on writes, execute against the gateway, feed results back, and repeat
 * until the model stops calling tools. An AbortController wired to the Stop
 * button cancels the in-flight request; per-turn caps bound runaways.
 */
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type {
  AgentApprovalBehavior,
  AgentModel,
  AgentReasoningEffort,
  AgentWsServerMessage,
} from "@sparklab/shared-types";
import { DEFAULT_MODEL, resolveModel, type ResolvedModel } from "./azure.js";
import { CAPS, config } from "./config.js";
import { ApprovalManager } from "./approvals.js";
import { appendMessages, loadChat, reconstructTranscript } from "./history.js";
import { systemPrompt } from "./system-prompt.js";
import {
  TOOLS,
  WRITE_TOOLS,
  ONE_TIME_TOOLS,
  describeCall,
  executeTool,
  targetSession,
  type ToolArgs,
} from "./tools.js";
import { BrowserRuntime, type BrowserAction } from "./browser-runtime.js";
import {
  ComputerRuntime,
  type ComputerAction,
  type ComputerTarget,
} from "./computer-runtime.js";
import { BrowserHandoffBroker } from "./browser-handoff-broker.js";
import { gateway } from "./gateway-client.js";

type Send = (frame: AgentWsServerMessage) => void;

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class AgentLoop {
  readonly chatId: string;
  private history: ChatCompletionMessageParam[] = [];
  private approvals = new ApprovalManager();
  private abort: AbortController | null = null;
  private running = false;
  private ready: Promise<void>;
  private browser: BrowserRuntime;
  // Virtual Computer (CUA) — spike. Independent per-loop lifetime, same as the
  // browser: lazily started on the first computer_* call, torn down on
  // interrupt / dispose, replaced on unexpected close. No handoff/broker/lease
  // (that is docs/VIRTUAL-COMPUTER.md D4, a later phase).
  private computer: ComputerRuntime;

  constructor(
    private send: Send,
    chatId: string,
    private readonly terminalSessionId: string,
    private readonly handoffs: BrowserHandoffBroker,
    private readonly user: string,
  ) {
    this.chatId = chatId;
    this.browser = this.newBrowserRuntime();
    this.computer = this.newComputerRuntime();
    this.ready = loadChat(chatId).then((history) => {
      this.history = history;
    });
  }

  async init(): Promise<void> {
    await this.ready;
    const attached = this.handoffs.attachChat(
      this.chatId,
      this.user,
      this.send,
      (browser, revision) => this.browserDestroyed(browser, revision),
    );
    if (attached) this.browser = attached;
    await this.replay(this.send);
  }

  /**
   * Send the durable portion of this chat to one newly attached browser.
   * The run itself deliberately survives when that browser later disconnects.
   */
  async replay(send: Send): Promise<void> {
    await this.ready;
    send({
      type: "chat_started",
      chatId: this.chatId,
      terminalSessionId: this.terminalSessionId,
    });
    // Replay the transcript so a resumed chat (explicit load, page reload, or
    // transient reconnect) renders. The client REPLACES its entries with this.
    if (this.history.length > 0) {
      send({
        type: "chat_history",
        chatId: this.chatId,
        entries: reconstructTranscript(this.history),
      });
    }
  }

  /** Re-publish a live handoff through the run broadcaster after chat reconnect. */
  refreshBrowserHandoff(): void {
    const attached = this.handoffs.attachChat(
      this.chatId,
      this.user,
      this.send,
      (browser, revision) => this.browserDestroyed(browser, revision),
    );
    if (attached) this.browser = attached;
  }

  onApprovalResponse(requestId: string, behavior: AgentApprovalBehavior): void {
    this.approvals.resolve(requestId, behavior);
  }

  interrupt(): void {
    this.abort?.abort();
    this.approvals.denyAll();
    if (this.browser.leaseState === "agent_active") void this.closeBrowser();
    else void this.handoffs.revokeForChat(this.chatId);
    void this.closeComputer();
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    this.approvals.denyAll();
    if (this.browser.leaseState === "agent_active") await this.closeBrowser();
    // A pending or human-controlled browser is owned by the broker and may be
    // adopted by the same authenticated chat after a transient /agent reconnect.
    await this.closeComputer();
  }

  requestBrowserHandoff(browserId: string): void {
    if (this.running) throw new Error("browser_handoff_agent_busy");
    this.beginBrowserHandoff(browserId);
  }

  private beginBrowserHandoff(browserId: string): "started" | "reopened" {
    if (this.browser.browserId !== browserId || !this.browser.isActive)
      throw new Error("browser_handoff_unavailable");
    if (this.handoffs.reopen(this.user, this.chatId, browserId))
      return "reopened";
    const issued = this.handoffs.begin({
      user: this.user,
      chatId: this.chatId,
      browser: this.browser,
      sendAgent: this.send,
      destroyed: (browser, revision) => {
        this.browserDestroyed(browser, revision);
      },
    });
    this.send({
      type: "browser_handoff_ready",
      browserId,
      ...issued,
    });
    this.send({
      type: "browser_handoff_state",
      browserId,
      handoffId: issued.handoffId,
      state: "pending",
      expiresAt: issued.expiresAt,
    });
    return "started";
  }

  private browserDestroyed(browser: BrowserRuntime, revision: number): void {
    if (this.browser === browser) this.browser = this.newBrowserRuntime();
    this.send({
      type: "browser_closed",
      browserId: browser.browserId,
      revision,
    });
  }

  finishBrowserHandoff(handoffId: string): Promise<void> {
    return this.handoffs.finish(handoffId, this.user, this.chatId);
  }

  cancelBrowserHandoff(handoffId: string): Promise<void> {
    return this.handoffs.cancel(handoffId, this.user, this.chatId);
  }

  async handleUserMessage(
    text: string,
    activeSessionId?: string,
    model: AgentModel = DEFAULT_MODEL,
    reasoningEffort: AgentReasoningEffort = "medium",
  ): Promise<void> {
    await this.ready;
    if (this.running) {
      this.send({
        type: "error",
        message: "The agent is still working on the previous message.",
      });
      return;
    }
    const resolved = resolveModel(model);
    if (!resolved) {
      this.send({
        type: "error",
        message: "The selected agent model is not configured on this service.",
      });
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;

    try {
      const userMsg: ChatCompletionMessageParam = {
        role: "user",
        content: text,
      };
      this.history.push(userMsg);
      await appendMessages(this.chatId, [userMsg]);

      let modelCalls = 0;
      let writeExecs = 0;

      while (true) {
        if (signal.aborted) break;
        if (modelCalls >= CAPS.maxModelCalls) {
          this.finishWithNotice(
            "I hit the per-message step limit and stopped. Ask me to continue if you'd like.",
          );
          break;
        }
        modelCalls++;
        this.send({ type: "status", state: "thinking" });

        const system: ChatCompletionMessageParam = {
          role: "system",
          content: systemPrompt(
            activeSessionId,
            this.browser.leaseState,
            config.cua.enabled,
          ),
        };

        const { text: segmentText, toolCalls } = await this.streamOnce(
          [system, ...this.history],
          signal,
          resolved,
          reasoningEffort,
        );

        // An empty first turn — no text, no tool calls — means the model gave
        // us nothing to act on and the loop would otherwise exit silently.
        // DeepSeek/Ark is the likely culprit (it can leak raw DSML tool markup
        // instead of a real reply); we don't port a DSML workaround, just make
        // the dead turn visible. Harmless for the Azure models too.
        if (
          !signal.aborted &&
          !segmentText.trim() &&
          toolCalls.length === 0 &&
          modelCalls === 1
        ) {
          this.send({
            type: "error",
            message:
              "The model returned an empty response. Try resending, or switch models.",
          });
          break;
        }

        // Persist the assistant turn (content + any tool calls together).
        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          content: segmentText || null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map(
                  (tc): ChatCompletionMessageToolCall => ({
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(
                        sanitizePersistedToolArgs(
                          tc.name,
                          parseArgs(tc.arguments),
                        ),
                      ),
                    },
                  }),
                ),
              }
            : {}),
        };
        this.history.push(assistantMsg);
        await appendMessages(this.chatId, [assistantMsg]);

        // Finalize any streamed assistant text as a message boundary.
        if (segmentText.trim()) {
          this.send({ type: "assistant_message", text: segmentText });
        }

        if (toolCalls.length === 0) break; // model is done

        for (const tc of toolCalls) {
          if (signal.aborted) break;
          const args = parseArgs(tc.arguments);
          const publicArgs = redactToolArgs(tc.name, args);
          const sessionId = targetSession(args);
          const summary = describeCall(tc.name, args);
          const isWrite = WRITE_TOOLS.has(tc.name);

          this.send({
            type: "tool_use",
            callId: tc.id,
            tool: tc.name,
            sessionId,
            summary,
            input: publicArgs,
          });

          let resultContent: string;
          let ok = true;

          if (isWrite && !this.approvals.isAutoAllowed(tc.name, sessionId)) {
            this.send({ type: "status", state: "awaiting_approval" });
            const behavior = await this.approvals.request(
              tc.name,
              sessionId,
              (requestId) =>
                this.send({
                  type: "approval_request",
                  requestId,
                  tool: tc.name,
                  sessionId,
                  summary,
                  input: publicArgs,
                }),
              // ONE_TIME_TOOLS (browser_act, browser_request_handoff,
              // run_codex, kanban_delete) are consequential enough that each
              // invocation is approved individually (no persistent
              // allow-always); pass allowAlways: false for them.
              !ONE_TIME_TOOLS.has(tc.name),
              (requestId, behavior) =>
                this.send({
                  type: "approval_resolved",
                  requestId,
                  behavior,
                }),
            );
            if (behavior === "deny") {
              resultContent =
                "The user denied this action. Do not retry it; explain or offer an alternative.";
              ok = false;
              this.send({
                type: "tool_result",
                callId: tc.id,
                tool: tc.name,
                ok: false,
                summary: "denied by user",
              });
              await this.appendToolResult(tc.id, resultContent, tc.name);
              continue;
            }
          }

          if (isWrite) {
            if (writeExecs >= CAPS.maxWriteExecs) {
              resultContent =
                "Write limit for this message reached; stopping to stay safe.";
              ok = false;
            } else {
              writeExecs++;
              this.send({ type: "status", state: "acting" });
              resultContent = await this.execute(tc.name, args, signal);
              ok = !resultContent.startsWith("error");
            }
          } else {
            this.send({ type: "status", state: "acting" });
            resultContent = await this.execute(tc.name, args, signal);
            ok = !resultContent.startsWith("error");
          }

          this.send({
            type: "tool_result",
            callId: tc.id,
            tool: tc.name,
            ok,
            summary: ok ? undefined : resultContent.slice(0, 200),
          });
          await this.appendToolResult(tc.id, resultContent, tc.name);
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        this.send({
          type: "error",
          message:
            err instanceof Error ? err.message : "unexpected agent error",
        });
      }
    } finally {
      this.running = false;
      this.abort = null;
      this.send({ type: "status", state: "idle" });
    }
  }

  private async appendToolResult(
    toolCallId: string,
    content: string,
    tool: string,
  ): Promise<void> {
    const msg: ChatCompletionMessageParam = {
      role: "tool",
      tool_call_id: toolCallId,
      content,
    };
    this.history.push(msg);
    const persistedMsg: ChatCompletionMessageParam = {
      ...msg,
      content: sanitizePersistedToolResult(tool, content),
    };
    await appendMessages(this.chatId, [persistedMsg]);
  }

  private finishWithNotice(text: string): void {
    this.send({ type: "assistant_message", text });
  }

  private async execute(
    tool: string,
    args: ToolArgs,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      if (tool === "browser_observe") {
        const result = await this.browser.observe(signal);
        if (result.snapshot)
          this.send({ type: "browser_view", ...result.snapshot });
        return result.content;
      }
      if (tool === "browser_list_tabs")
        return (await this.browser.listTabs(signal)).content;
      if (tool === "browser_capture") {
        if (!args.session_id) return "error: session_id is required";
        if (
          typeof args.path !== "string" ||
          !args.path.startsWith("/") ||
          args.path.length > 4096
        ) {
          return "error: path must be an absolute path of at most 4096 characters";
        }
        const result = await this.browser.observe(signal);
        if (!result.snapshot)
          return "error: browser did not return a screenshot";
        this.send({ type: "browser_view", ...result.snapshot });
        const bytes = Buffer.from(result.snapshot.screenshot.data, "base64");
        const saved = await gateway.uploadSessionFile(
          args.session_id,
          args.path,
          bytes,
          result.snapshot.screenshot.mediaType,
        );
        return JSON.stringify({
          saved: true,
          path: saved.path,
          size: saved.size,
          mediaType: result.snapshot.screenshot.mediaType,
          viewport: result.snapshot.viewport,
        });
      }
      if (tool === "browser_request_handoff") {
        const result = this.beginBrowserHandoff(this.browser.browserId);
        if (result === "reopened")
          return "The existing human browser handoff view was reopened. The browser session, cookies, control channel, and timeouts are unchanged. Do not use browser tools again in this turn. Tell the user to continue in the reopened browser view and select Done or Cancel when finished.";
        return "Human browser handoff started. Do not use browser tools again in this turn. Tell the user to complete authentication and select Done, or cancel the browser session.";
      }
      if (tool === "browser_act") {
        const action = parseBrowserAction(args);
        if (typeof action === "string") return `error: ${action}`;
        const result = await this.browser.act(action, signal);
        if (result.snapshot)
          this.send({ type: "browser_view", ...result.snapshot });
        return result.content;
      }
      if (tool === "computer_observe") {
        const result = await this.computer.observe(signal);
        if (result.snapshot)
          this.send({ type: "computer_view", ...result.snapshot });
        return result.content;
      }
      if (tool === "computer_act") {
        const action = parseComputerAction(args);
        if (typeof action === "string") return `error: ${action}`;
        const result = await this.computer.act(action, signal);
        if (result.snapshot)
          this.send({ type: "computer_view", ...result.snapshot });
        return result.content;
      }
      return executeTool(tool, args, signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (tool.startsWith("browser_") && this.browser.isClosed) {
        this.browser = this.newBrowserRuntime();
      }
      if (tool.startsWith("computer_") && this.computer.isClosed) {
        this.computer = this.newComputerRuntime();
      }
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async closeBrowser(): Promise<void> {
    // A concurrent abort may already have disposed the runtime and cleared its
    // child. Still replace that closed instance so the next turn starts cleanly.
    if (!this.browser.isActive && !this.browser.isClosed) return;
    const closing = this.browser;
    this.browser = this.newBrowserRuntime();
    const browserId = closing.browserId;
    const revision = await closing.dispose();
    this.send({ type: "browser_closed", browserId, revision });
  }

  private newBrowserRuntime(): BrowserRuntime {
    return new BrowserRuntime((browserId, revision) => {
      void this.handoffs.revokeBrowser(browserId).then((revoked) => {
        if (revoked) return;
        this.send({ type: "browser_closed", browserId, revision });
        if (this.browser.browserId === browserId)
          this.browser = this.newBrowserRuntime();
      });
    });
  }

  private async closeComputer(): Promise<void> {
    if (!this.computer.isActive && !this.computer.isClosed) return;
    const closing = this.computer;
    this.computer = this.newComputerRuntime();
    const computerId = closing.computerId;
    const revision = await closing.stop();
    this.send({ type: "computer_closed", computerId, revision });
  }

  private newComputerRuntime(): ComputerRuntime {
    return new ComputerRuntime(
      (computerId, revision) => {
        this.send({ type: "computer_closed", computerId, revision });
        if (this.computer.computerId === computerId)
          this.computer = this.newComputerRuntime();
      },
      { label: this.chatId },
    );
  }

  /** One streaming model call: relay text deltas, accumulate tool calls. */
  private async streamOnce(
    messages: ChatCompletionMessageParam[],
    signal: AbortSignal,
    resolved: ResolvedModel,
    reasoningEffort: AgentReasoningEffort,
  ): Promise<{ text: string; toolCalls: AccumulatedToolCall[] }> {
    const params: Record<string, unknown> = {
      model: resolved.deployment,
      messages,
      tools: TOOLS,
      stream: true,
      // GPT-5.6 takes `reasoning_effort`; DeepSeek / Ark rejects it, and Ark
      // instead takes a `thinking` flag (via `resolved.extraBody`).
      ...(resolved.supportsReasoningEffort
        ? // openai@4's declaration predates GPT-5.6's `none`, `xhigh`, and
          // `max` values; the Azure Chat Completions API receives this field
          // unchanged and validates support for the selected deployment.
          { reasoning_effort: reasoningEffort }
        : {}),
      ...(resolved.extraBody ?? {}),
    };
    const stream = await resolved.client.chat.completions.create(
      // `params` carries non-typed passthrough fields (reasoning_effort's
      // GPT-5.6 values, Ark's `thinking`); the request body is sent unchanged.
      params as unknown as Parameters<
        typeof resolved.client.chat.completions.create
      >[0],
      { signal },
    );

    let text = "";
    const byIndex = new Map<number, AccumulatedToolCall>();

    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        this.send({ type: "assistant_delta", text: delta.content });
      }
      if (delta?.tool_calls) {
        for (const tcd of delta.tool_calls) {
          const idx = tcd.index;
          let acc = byIndex.get(idx);
          if (!acc) {
            acc = { id: tcd.id ?? "", name: "", arguments: "" };
            byIndex.set(idx, acc);
          }
          if (tcd.id) acc.id = tcd.id;
          if (tcd.function?.name) acc.name += tcd.function.name;
          if (tcd.function?.arguments) acc.arguments += tcd.function.arguments;
        }
      }
    }

    const toolCalls = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((tc) => tc.name && tc.id);
    return { text, toolCalls };
  }
}

function parseArgs(raw: string): ToolArgs {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as ToolArgs) : {};
  } catch {
    return {};
  }
}

function redactToolArgs(tool: string, args: ToolArgs): ToolArgs {
  if (tool === "browser_act" && args.action === "type")
    return { ...args, text: "[redacted]" };
  if (tool === "computer_act" && args.kind === "type_text")
    return { ...args, text: "[redacted]" };
  return args;
}

export function sanitizePersistedToolArgs(
  tool: string,
  args: ToolArgs,
): ToolArgs {
  if (tool === "schedule_terminal_input") {
    return { ...args, text: "[scheduled input omitted]" };
  }
  const redacted = redactToolArgs(tool, args);
  if (
    tool !== "browser_act" ||
    args.action !== "navigate" ||
    typeof args.url !== "string"
  ) {
    return redacted;
  }
  try {
    const url = new URL(args.url);
    url.search = "";
    url.hash = "";
    return { ...redacted, url: url.toString() };
  } catch {
    return { ...redacted, url: "[invalid URL omitted]" };
  }
}

export function sanitizePersistedToolResult(
  tool: string,
  content: string,
): string {
  if (tool.startsWith("browser_"))
    return "[browser result omitted from durable history]";
  // computer_observe carries the AX element slice (roles, names, window
  // titles) and computer_act echoes a fresh observation — never persisted
  // (docs/VIRTUAL-COMPUTER.md: desktop/AX state is ephemeral in chat).
  if (tool.startsWith("computer_"))
    return "[computer result omitted from durable history]";
  return content;
}

function parseBrowserAction(args: ToolArgs): BrowserAction | string {
  switch (args.action) {
    case "navigate":
      return typeof args.url === "string" && args.url.length <= 2048
        ? { action: "navigate", url: args.url, new_tab: args.new_tab }
        : "navigate requires a URL of at most 2048 characters";
    case "click":
      return Number.isInteger(args.index) && (args.index ?? -1) >= 0
        ? {
            action: "click",
            index: args.index as number,
            new_tab: args.new_tab,
          }
        : "click requires a non-negative element index";
    case "type":
      return Number.isInteger(args.index) &&
        typeof args.text === "string" &&
        args.text.length <= 10_000
        ? { action: "type", index: args.index as number, text: args.text }
        : "type requires an element index and text of at most 10000 characters";
    case "scroll":
      return args.direction === "up" || args.direction === "down"
        ? { action: "scroll", direction: args.direction }
        : "scroll direction must be up or down";
    case "go_back":
      return { action: "go_back" };
    case "switch_tab":
    case "close_tab":
      return typeof args.tab_id === "string" &&
        args.tab_id.length > 0 &&
        args.tab_id.length <= 64
        ? { action: args.action, tab_id: args.tab_id }
        : `${args.action} requires a tab_id`;
    default:
      return "unknown browser action";
  }
}

function parseComputerTarget(args: ToolArgs): ComputerTarget | string {
  if (
    Number.isInteger(args.element_index) &&
    (args.element_index ?? -1) >= 0 &&
    typeof args.snapshot_id === "string" &&
    args.snapshot_id.length > 0
  ) {
    return {
      elementIndex: args.element_index as number,
      snapshotId: args.snapshot_id,
    };
  }
  if (
    Number.isInteger(args.x) &&
    (args.x ?? -1) >= 0 &&
    Number.isInteger(args.y) &&
    (args.y ?? -1) >= 0
  ) {
    // v1: screen-absolute point (desktop scope). window_id is accepted but
    // currently ignored (reserved for the P1 per-window element path).
    return {
      x: args.x as number,
      y: args.y as number,
      ...(typeof args.window_id === "string" && args.window_id.length > 0
        ? { windowId: args.window_id }
        : {}),
    };
  }
  return "target requires element_index + snapshot_id (from computer_observe), or screen x + y";
}

function parseComputerAction(args: ToolArgs): ComputerAction | string {
  const target = parseComputerTarget(args);
  if (typeof target === "string") return target;
  switch (args.kind) {
    case "click":
      return { kind: "click", target };
    case "type_text":
      return typeof args.text === "string" && args.text.length <= 10_000
        ? { kind: "type_text", target, text: args.text }
        : "type_text requires text of at most 10000 characters";
    case "press_key":
      return typeof args.key === "string" &&
        args.key.length > 0 &&
        args.key.length <= 64
        ? { kind: "press_key", target, key: args.key }
        : "press_key requires a key name of at most 64 characters";
    case "scroll":
      return args.direction === "up" ||
        args.direction === "down" ||
        args.direction === "left" ||
        args.direction === "right"
        ? {
            kind: "scroll",
            target,
            direction: args.direction,
            amount: args.amount === "page" ? "page" : "line",
          }
        : "scroll direction must be up, down, left, or right";
    default:
      return "unknown computer action kind";
  }
}
