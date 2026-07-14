/**
 * The agent's entire capability surface: seven tools, defined as OpenAI
 * function-calling schemas and dispatched against the gateway client.
 *
 * Because the loop is ours, there are no built-in tools to disable — these are
 * the only things the model can do, and every one flows through tmux-owned
 * processes via the gateway.
 *
 *   READ  (auto):  list_sessions, read_screen, wait_idle
 *   WRITE (ask):   type_text, press_keys, run_command, create_session
 *
 * There is deliberately no kill_session — destroying a session stays a
 * human-only act in the UI.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { AgentNamedKeySchema } from "@sparklab/shared-types";
import { gateway, GatewayError } from "./gateway-client.js";

export const WRITE_TOOLS = new Set([
  "type_text",
  "press_keys",
  "run_command",
  "create_session",
]);

const NAMED_KEYS = AgentNamedKeySchema.options;

export const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_sessions",
      description:
        "List all terminal sessions with their human name, id, currently-running command, attached state, and last activity. Call this first to discover what terminals exist.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_screen",
      description:
        "Read the plain-text contents of a terminal's screen (no colors). Use before acting so you know what is currently shown and whether a job is running.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Target session id (web-...).",
          },
          history_lines: {
            type: "integer",
            minimum: 0,
            maximum: 2000,
            description:
              "Optional lines of scrollback above the visible screen (default 0).",
          },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_idle",
      description:
        "Block until a terminal looks idle: its running command returns to a shell, or the screen stops changing. Use after starting something to know when it finished. Returns the final screen.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
          quiet_ms: { type: "integer", minimum: 250, maximum: 30000 },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description:
        "Type literal text into a terminal. This NEVER executes — no Enter is sent. Use for filling a prompt, then press_keys ['Enter'] to run. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          text: { type: "string", minLength: 1, maxLength: 10000 },
        },
        required: ["session_id", "text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_keys",
      description: `Send one or more named keys to a terminal (in order). Allowed keys: ${NAMED_KEYS.join(", ")}. Use 'Enter' to run a typed command, 'C-c' to interrupt. Requires user approval.`,
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          keys: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: { type: "string", enum: NAMED_KEYS },
          },
        },
        required: ["session_id", "keys"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Type a shell command, press Enter, and wait for it to finish. Returns the resulting screen. The single approval shows the exact command. Use this for ordinary non-interactive commands.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          command: { type: "string", minLength: 1, maxLength: 10000 },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
        },
        required: ["session_id", "command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_session",
      description:
        "Create a new terminal session and return its id. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional display name." },
          cwd: { type: "string", description: "Optional working directory." },
        },
        additionalProperties: false,
      },
    },
  },
];

const SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash"]);

export interface ToolArgs {
  session_id?: string;
  text?: string;
  keys?: string[];
  command?: string;
  name?: string;
  cwd?: string;
  history_lines?: number;
  timeout_ms?: number;
  quiet_ms?: number;
}

/** Which session a call targets (for UI attribution), if any. */
export function targetSession(args: ToolArgs): string | undefined {
  return typeof args.session_id === "string" ? args.session_id : undefined;
}

/** One-line human summary of a call, for the activity feed / approval card. */
export function describeCall(tool: string, args: ToolArgs): string {
  const truncate = (s: string, n = 200) =>
    s.length > n ? s.slice(0, n) + "…" : s;
  switch (tool) {
    case "list_sessions":
      return "list sessions";
    case "read_screen":
      return `read screen${args.history_lines ? ` (+${args.history_lines} history)` : ""}`;
    case "wait_idle":
      return "wait for idle";
    case "type_text":
      return `type: ${truncate(String(args.text ?? ""))}`;
    case "press_keys":
      return `press: ${(args.keys ?? []).join(" ")}`;
    case "run_command":
      return `run: ${truncate(String(args.command ?? ""))}`;
    case "create_session":
      return `create session${args.name ? ` "${args.name}"` : ""}`;
    default:
      return tool;
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function waitIdle(
  sessionId: string,
  timeoutMs: number,
  quietMs: number,
  signal?: AbortSignal,
): Promise<{ idle_reason: string; screen: string }> {
  const start = Date.now();
  let lastScreen: string | null = null;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await gateway.readScreen(sessionId);
    if (SHELLS.has(s.currentCommand)) {
      return { idle_reason: "shell_prompt", screen: s.screen };
    }
    if (s.screen === lastScreen) {
      if (Date.now() - stableSince >= quietMs) {
        return { idle_reason: "quiet", screen: s.screen };
      }
    } else {
      lastScreen = s.screen;
      stableSince = Date.now();
    }
    await abortableSleep(500, signal);
  }
  const final = await gateway.readScreen(sessionId);
  return { idle_reason: "timeout", screen: final.screen };
}

/**
 * Execute a tool and return the string the model sees as the tool result.
 * Approval (for write tools) is handled by the caller BEFORE this runs.
 */
export async function executeTool(
  tool: string,
  args: ToolArgs,
  signal?: AbortSignal,
): Promise<string> {
  try {
    switch (tool) {
      case "list_sessions": {
        const sessions = await gateway.listSessions();
        return JSON.stringify(
          sessions.map((s) => ({
            id: s.id,
            name: s.name,
            currentCommand: s.currentCommand,
            attached: s.attached,
            lastActivity: s.lastActivity,
          })),
        );
      }
      case "read_screen": {
        if (!args.session_id) return "error: session_id is required";
        const s = await gateway.readScreen(
          args.session_id,
          clampInt(args.history_lines, 0, 0, 2000),
        );
        return JSON.stringify({
          screen: s.screen,
          cursor: s.cursor,
          size: s.size,
          altScreen: s.altScreen,
          currentCommand: s.currentCommand,
        });
      }
      case "wait_idle": {
        if (!args.session_id) return "error: session_id is required";
        const r = await waitIdle(
          args.session_id,
          clampInt(args.timeout_ms, 30000, 1000, 120000),
          clampInt(args.quiet_ms, 2000, 250, 30000),
          signal,
        );
        return JSON.stringify(r);
      }
      case "type_text": {
        if (!args.session_id || !args.text)
          return "error: session_id and text are required";
        await gateway.sendKeys(args.session_id, { text: args.text });
        return "ok: text typed (not executed)";
      }
      case "press_keys": {
        if (!args.session_id || !Array.isArray(args.keys))
          return "error: session_id and keys are required";
        const keys = args.keys.filter((k) =>
          (NAMED_KEYS as readonly string[]).includes(k),
        );
        if (keys.length === 0) return "error: no valid keys";
        await gateway.sendKeys(args.session_id, {
          keys: keys as never,
        });
        return `ok: pressed ${keys.join(" ")}`;
      }
      case "run_command": {
        if (!args.session_id || !args.command)
          return "error: session_id and command are required";
        await gateway.sendKeys(args.session_id, { text: args.command });
        await gateway.sendKeys(args.session_id, { keys: ["Enter"] });
        const r = await waitIdle(
          args.session_id,
          clampInt(args.timeout_ms, 30000, 1000, 120000),
          2000,
          signal,
        );
        return JSON.stringify(r);
      }
      case "create_session": {
        const r = await gateway.createSession({
          name: args.name,
          cwd: args.cwd,
        });
        return JSON.stringify({ id: r.id, name: r.name });
      }
      default:
        return `error: unknown tool ${tool}`;
    }
  } catch (err) {
    if (err instanceof GatewayError) {
      return `error: gateway ${err.status}: ${err.message}`;
    }
    if (err instanceof Error && err.name === "AbortError") throw err;
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
