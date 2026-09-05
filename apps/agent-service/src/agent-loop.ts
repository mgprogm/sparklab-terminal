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
  CodexRunResponse,
} from "@sparklab/shared-types";
import {
  DEFAULT_MODEL,
  isCodexCliModel,
  resolveModel,
  type ResolvedModel,
} from "./azure.js";
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
import { gateway, GatewayError } from "./gateway-client.js";

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
  /** A successful Task Master claim is the mandatory implementation preflight. */
  private activeTask: { projectId: string; taskId: string } | null = null;

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
    /**
     * Only meaningful when `model === "openrouter-gpt-latest"`: selects one
     * specific catalog entry for this turn instead of the configured
     * default. Validated against the live OpenRouter catalog by
     * `resolveModel` — an unknown id resolves like any unconfigured model.
     */
    openrouterModelId?: string,
  ): Promise<void> {
    await this.ready;
    if (this.running) {
      this.send({
        type: "error",
        message: "The agent is still working on the previous message.",
      });
      return;
    }

    // "Codex CLI" is not a chat-completions model — route the whole turn to the
    // Codex CLI via the gateway (Option B). It has its own agentic loop and
    // tools; the agent-service tool set is not offered for these turns.
    if (isCodexCliModel(model)) {
      await this.runCodexProviderTurn(text, activeSessionId);
      return;
    }

    const resolved = await resolveModel(model, openrouterModelId);
    if (!resolved) {
      this.send({
        type: "error",
        message: "The selected agent model is not configured on this service.",
      });
      return;
    }
    // A model whose reasoning is mandatory (e.g. some OpenRouter catalog
    // entries) rejects/ignores an effort of "none" — transparently upgrade
    // rather than send a value that model can't honor.
    const effectiveReasoningEffort: AgentReasoningEffort =
      resolved.mandatoryReasoningFallback && reasoningEffort === "none"
        ? resolved.mandatoryReasoningFallback
        : reasoningEffort;
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
          effectiveReasoningEffort,
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
            let approvalRequestId = "";
            const behavior = await this.approvals.request(
              tc.name,
              sessionId,
              (requestId) => {
                approvalRequestId = requestId;
                this.send({
                  type: "approval_request",
                  requestId,
                  tool: tc.name,
                  sessionId,
                  summary,
                  input: publicArgs,
                });
              },
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
              // The wire `behavior` is "deny" whether the human clicked Deny
              // or just never responded before the 120s approval timeout —
              // the two are NOT the same event, and telling the model "the
              // user denied this" for a timeout is a lie the model then
              // repeats to a human who never saw the choice (confirmed live,
              // 2026-08-31: an approval sat un-actioned during unrelated
              // investigation, timed out, and the model reported "you denied
              // this action" to someone who hadn't).
              const timedOut = this.approvals.wasTimedOut(approvalRequestId);
              resultContent = timedOut
                ? "This action was not approved within the 120-second approval window — the human did not respond (they may be away or busy), they did not explicitly deny it. Do not retry it without asking first; tell the human it timed out and ask whether to try again or do something else."
                : "The user denied this action. Do not retry it; explain or offer an alternative.";
              ok = false;
              this.send({
                type: "tool_result",
                callId: tc.id,
                tool: tc.name,
                ok: false,
                summary: timedOut
                  ? "approval timed out (no response)"
                  : "denied by user",
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
        this.send({ type: "error", message: describeStreamError(err) });
      }
    } finally {
      this.running = false;
      this.abort = null;
      this.send({ type: "status", state: "idle" });
    }
  }

  /**
   * One turn when the selected "model" is the Codex CLI (Option B). Each user
   * message is handed to `codex exec` (non-interactive) through the gateway,
   * rooted at the selected terminal's cwd. Mirrors `run_codex`: one individual
   * approval per turn (never allow-always), and the sandbox `mode` is the real
   * write boundary. Turns are independent — no prior chat is sent to Codex.
   * Persists a plain user + assistant pair so replay/recovery need no new shape.
   */
  private async runCodexProviderTurn(
    text: string,
    activeSessionId?: string,
  ): Promise<void> {
    if (!config.codex.providerEnabled) {
      this.send({
        type: "error",
        message: "The Codex CLI provider is not enabled on this service.",
      });
      return;
    }
    const sessionId = activeSessionId;
    if (!sessionId) {
      this.send({
        type: "error",
        message:
          "Codex CLI needs a target terminal session — select or open one, then send again.",
      });
      return;
    }

    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const mode = config.codex.providerMode;

    try {
      const userMsg: ChatCompletionMessageParam = {
        role: "user",
        content: text,
      };
      this.history.push(userMsg);
      await appendMessages(this.chatId, [userMsg]);

      const summary = `run Codex [${mode}]: ${
        text.length > 120 ? `${text.slice(0, 120)}…` : text
      }`;
      const publicInput = { session_id: sessionId, prompt: text, mode };

      // Per-turn one-time approval, reusing the `run_codex` tool identity so the
      // approval card + policy treat it identically.
      this.send({ type: "status", state: "awaiting_approval" });
      let approvalRequestId = "";
      const behavior = await this.approvals.request(
        "run_codex",
        sessionId,
        (requestId) => {
          approvalRequestId = requestId;
          this.send({
            type: "approval_request",
            requestId,
            tool: "run_codex",
            sessionId,
            summary,
            input: publicInput,
          });
        },
        false, // one-time — no persistent allow-always for a Codex run
        (requestId, resolvedBehavior) =>
          this.send({
            type: "approval_resolved",
            requestId,
            behavior: resolvedBehavior,
          }),
      );

      if (signal.aborted) return;

      if (behavior === "deny") {
        const timedOut = this.approvals.wasTimedOut(approvalRequestId);
        const notice = timedOut
          ? "The Codex run was not approved within the 120-second window (no response), so nothing ran. Send again if you'd like to retry."
          : "You declined the Codex run, so nothing ran.";
        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          content: notice,
        };
        this.history.push(assistantMsg);
        await appendMessages(this.chatId, [assistantMsg]);
        this.send({ type: "assistant_message", text: notice });
        return;
      }

      this.send({ type: "status", state: "acting" });
      let reply: string;
      try {
        const result = await gateway.runCodex(
          sessionId,
          { prompt: text, mode },
          { signal },
        );
        reply = formatCodexProviderReply(result);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        reply = codexProviderErrorMessage(err);
      }

      if (signal.aborted) return;
      const assistantMsg: ChatCompletionMessageParam = {
        role: "assistant",
        content: reply,
      };
      this.history.push(assistantMsg);
      await appendMessages(this.chatId, [assistantMsg]);
      this.send({ type: "assistant_message", text: reply });
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
      if (
        ["run_command", "type_text", "press_keys", "run_codex"].includes(
          tool,
        ) &&
        !this.activeTask
      ) {
        return "error: Task Master preflight required: list/show an actionable task and call taskmaster_claim before implementation tools.";
      }
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
      if (tool === "computer_list_windows")
        return await this.computer.listWindows(signal);
      if (tool === "computer_capture") {
        if (!args.session_id) return "error: session_id is required";
        if (
          typeof args.path !== "string" ||
          !args.path.startsWith("/") ||
          args.path.length > 4096
        ) {
          return "error: path must be an absolute path of at most 4096 characters";
        }
        const result = await this.computer.observe(signal);
        if (!result.snapshot)
          return "error: computer did not return a screenshot";
        this.send({ type: "computer_view", ...result.snapshot });
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
      const result = await executeTool(tool, args, signal, {
        id: `chat-${this.chatId}`,
        name: "Agent Chat",
        role: "Developer",
        tool: "Agent Chat",
      });
      if (
        tool === "taskmaster_claim" &&
        !result.startsWith("error:") &&
        args.project_id &&
        args.task_id
      ) {
        this.activeTask = {
          projectId: args.project_id,
          taskId: args.task_id,
        };
      }
      if (
        tool === "taskmaster_release" &&
        !result.startsWith("error:") &&
        this.activeTask?.projectId === args.project_id &&
        this.activeTask?.taskId === args.task_id
      )
        this.activeTask = null;
      return result;
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

function stringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Turns a raw upstream chat-completions error into a clearer chat message.
 * A 429 in particular gets a specific, actionable explanation instead of the
 * SDK's bare "<status> <body message>" string — a provider's own body
 * message for a rate limit is frequently as unhelpful as OpenRouter's own
 * "Provider returned error" (it means the upstream inference provider
 * behind the requested model rate-limited it, not OpenRouter itself; any
 * `error.metadata.raw`/`provider_name` OpenRouter attaches is surfaced when
 * present). Applies to every provider — Azure/Ark can 429 too — since none
 * of them give a friendlier body message on their own.
 */
export function describeStreamError(err: unknown): string {
  if (!(err instanceof Error)) return "unexpected agent error";
  const status = (err as { status?: unknown }).status;
  if (status !== 429) return err.message;

  const body = (err as { error?: unknown }).error;
  const metadata =
    body && typeof body === "object"
      ? (body as { metadata?: unknown }).metadata
      : undefined;
  const raw = stringField(metadata, "raw");
  const providerName = stringField(metadata, "provider_name");
  const bodyMessage = stringField(body, "message");

  return [
    "Rate limited (429) by the model provider.",
    providerName ? `Upstream provider: ${providerName}.` : undefined,
    raw ??
      (bodyMessage && bodyMessage !== "Provider returned error"
        ? bodyMessage
        : undefined),
    "Free or low-cost models often share a low request rate across all users of that provider, so this can happen even on a fresh account — wait a bit and try again, or pick a different model.",
  ]
    .filter((p): p is string => Boolean(p))
    .join(" ");
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
  // Keyed on kind, so it also covers the M3.1 element-target form
  // (element_index + snapshot_id) of type_text.
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
  // computer_observe carries the window inventory (titles, geometry), the
  // indexed AT-SPI element list, and a screenshot; computer_act echoes a fresh
  // observation — never persisted (docs/VIRTUAL-COMPUTER.md: desktop state is
  // ephemeral in chat).
  if (tool.startsWith("computer_"))
    return "[computer result omitted from durable history]";
  return content;
}

/**
 * Render a Codex CLI run result as the assistant reply for a Codex-provider
 * turn. A short italic status line (mode / exit / duration / truncation) sits
 * above Codex's own output so the human sees what ran without a tool card.
 * Pure — unit-tested in agent-loop.test.ts.
 */
export function formatCodexProviderReply(result: CodexRunResponse): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const exit =
    result.exitCode === null ? "exit unknown" : `exit ${result.exitCode}`;
  const meta = [
    `Codex CLI · ${result.mode} · ${exit} · ${seconds}s`,
    result.truncated ? " · output truncated" : "",
  ].join("");
  const body = result.output.trim() || "(Codex produced no output.)";
  return `_${meta}_\n\n${body}`;
}

/** Map a gateway failure from a Codex-provider run to a human-readable reply. */
function codexProviderErrorMessage(err: unknown): string {
  if (err instanceof GatewayError) {
    if (err.status === 503)
      return "Codex CLI is not available on that server — it may not be installed, or the CLI could not start.";
    if (err.status === 504)
      return "Codex CLI did not finish before the time limit. Try a smaller, more specific task.";
    return `The Codex run failed (${err.status}): ${err.message}`;
  }
  return `The Codex run failed: ${
    err instanceof Error ? err.message : String(err)
  }`;
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
  // M3.1: element target (from the latest computer_observe) is preferred; a
  // screen-absolute desktop point is the fallback. Element branch first so a
  // model that supplies both is routed to the element.
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
    return { x: args.x as number, y: args.y as number };
  }
  return "target requires element_index + snapshot_id (preferred) or screen x + y";
}

export function parseComputerAction(args: ToolArgs): ComputerAction | string {
  // hotkey is global — it takes no target. The driver rejects a chord shorter
  // than 2 keys, so reject that here rather than spend a one-time approval.
  if (args.kind === "hotkey") {
    const keys = args.keys;
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 8)
      return 'hotkey requires a chord of 2 to 8 keys (modifier(s) + one non-modifier key, e.g. ["ctrl","l"])';
    if (
      keys.some((k) => typeof k !== "string" || k.length === 0 || k.length > 16)
    )
      return "hotkey keys must each be a short key name of 1 to 16 characters";
    return { kind: "hotkey", keys };
  }
  const target = parseComputerTarget(args);
  if (typeof target === "string") return target;
  const isElement = "elementIndex" in target;
  switch (args.kind) {
    case "click":
      return { kind: "click", target };
    case "double_click":
      return { kind: "double_click", target };
    case "right_click":
      return { kind: "right_click", target };
    case "drag":
      if (isElement)
        return "drag cannot target an element_index — supply screen x,y for both the start and end points";
      if (
        !Number.isInteger(args.to_x) ||
        (args.to_x ?? -1) < 0 ||
        !Number.isInteger(args.to_y) ||
        (args.to_y ?? -1) < 0
      )
        return "drag requires integer to_x and to_y of at least 0";
      return {
        kind: "drag",
        target,
        to: { x: args.to_x as number, y: args.to_y as number },
      };
    case "type_text":
      return typeof args.text === "string" && args.text.length <= 10_000
        ? { kind: "type_text", target, text: args.text }
        : "type_text requires text of at most 10000 characters";
    case "press_key":
      if (isElement)
        return "press_key cannot target an element_index — supply screen x,y (element targeting is for click and type_text)";
      return typeof args.key === "string" &&
        args.key.length > 0 &&
        args.key.length <= 64
        ? { kind: "press_key", target, key: args.key }
        : "press_key requires a key name of at most 64 characters";
    case "scroll":
      if (isElement)
        return "scroll cannot target an element_index — supply screen x,y (element targeting is for click and type_text)";
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
