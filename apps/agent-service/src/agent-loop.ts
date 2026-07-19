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
  AgentWsServerMessage,
} from "@sparklab/shared-types";
import { azure, MODEL } from "./azure.js";
import { CAPS } from "./config.js";
import { ApprovalManager } from "./approvals.js";
import {
  appendMessages,
  loadChat,
  newChatId,
  reconstructTranscript,
} from "./history.js";
import { systemPrompt } from "./system-prompt.js";
import {
  TOOLS,
  WRITE_TOOLS,
  describeCall,
  executeTool,
  targetSession,
  type ToolArgs,
} from "./tools.js";
import { BrowserRuntime, type BrowserAction } from "./browser-runtime.js";

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

  constructor(
    private send: Send,
    resumeChatId?: string,
  ) {
    this.browser = this.newBrowserRuntime();
    this.chatId = resumeChatId || newChatId();
    this.ready = resumeChatId
      ? loadChat(resumeChatId).then((h) => {
          this.history = h;
        })
      : Promise.resolve();
  }

  async init(): Promise<void> {
    await this.ready;
    this.send({ type: "chat_started", chatId: this.chatId });
    // Replay the transcript so a resumed chat (explicit load, page reload, or
    // transient reconnect) renders. The client REPLACES its entries with this.
    if (this.history.length > 0) {
      this.send({
        type: "chat_history",
        chatId: this.chatId,
        entries: reconstructTranscript(this.history),
      });
    }
  }

  onApprovalResponse(requestId: string, behavior: AgentApprovalBehavior): void {
    this.approvals.resolve(requestId, behavior);
  }

  interrupt(): void {
    this.abort?.abort();
    this.approvals.denyAll();
    void this.closeBrowser();
  }

  async dispose(): Promise<void> {
    this.abort?.abort();
    this.approvals.denyAll();
    await this.closeBrowser();
  }

  async handleUserMessage(
    text: string,
    activeSessionId?: string,
  ): Promise<void> {
    await this.ready;
    if (this.running) {
      this.send({
        type: "error",
        message: "The agent is still working on the previous message.",
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

      const system: ChatCompletionMessageParam = {
        role: "system",
        content: systemPrompt(activeSessionId),
      };

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

        const { text: segmentText, toolCalls } = await this.streamOnce(
          [system, ...this.history],
          signal,
        );

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
              tc.name !== "browser_act",
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
      if (tool === "browser_act") {
        const action = parseBrowserAction(args);
        if (typeof action === "string") return `error: ${action}`;
        const result = await this.browser.act(action, signal);
        if (result.snapshot)
          this.send({ type: "browser_view", ...result.snapshot });
        return result.content;
      }
      return executeTool(tool, args, signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (tool.startsWith("browser_") && this.browser.isClosed) {
        this.browser = this.newBrowserRuntime();
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
      this.send({ type: "browser_closed", browserId, revision });
      if (this.browser.browserId === browserId)
        this.browser = this.newBrowserRuntime();
    });
  }

  /** One streaming model call: relay text deltas, accumulate tool calls. */
  private async streamOnce(
    messages: ChatCompletionMessageParam[],
    signal: AbortSignal,
  ): Promise<{ text: string; toolCalls: AccumulatedToolCall[] }> {
    const stream = await azure.chat.completions.create(
      {
        model: MODEL,
        messages,
        tools: TOOLS,
        stream: true,
      },
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
  return tool === "browser_act" && args.action === "type"
    ? { ...args, text: "[redacted]" }
    : args;
}

export function sanitizePersistedToolArgs(
  tool: string,
  args: ToolArgs,
): ToolArgs {
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
  return tool.startsWith("browser_")
    ? "[browser result omitted from durable history]"
    : content;
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
