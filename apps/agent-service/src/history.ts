/**
 * Per-chat conversation persistence as JSONL under data/<chatId>.jsonl.
 *
 * Because the loop is ours, one file serves BOTH jobs the Claude Agent SDK
 * would have handled separately: restoring the model's message history so a
 * dropped WebSocket can resume mid-conversation, and (for the UI) replaying
 * what was said. Each line is one OpenAI chat message.
 */
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type {
  AgentChatSummary,
  AgentReplayEntry,
} from "@sparklab/shared-types";
import { describeCall, targetSession, type ToolArgs } from "./tools.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

function chatFile(chatId: string): string {
  // chatId is a server-minted UUID; still guard against path traversal.
  const safe = chatId.replace(/[^a-zA-Z0-9-]/g, "");
  return join(DATA_DIR, `${safe}.jsonl`);
}

export function newChatId(): string {
  return randomUUID();
}

export async function appendMessages(
  chatId: string,
  messages: ChatCompletionMessageParam[],
): Promise<void> {
  if (messages.length === 0) return;
  await mkdir(DATA_DIR, { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await appendFile(chatFile(chatId), lines, "utf8");
}

export async function loadChat(
  chatId: string,
): Promise<ChatCompletionMessageParam[]> {
  const file = chatFile(chatId);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  const out: ChatCompletionMessageParam[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ChatCompletionMessageParam);
    } catch {
      /* skip a corrupt line rather than losing the whole conversation */
    }
  }
  return out;
}

/** Delete a chat's JSONL file. No-op if it doesn't exist. */
export async function deleteChat(chatId: string): Promise<void> {
  const file = chatFile(chatId);
  if (existsSync(file)) await unlink(file);
}

/**
 * List every persisted chat, newest-first. Metadata is DERIVED from the JSONL
 * (there is no sidecar): title from the first user message, updatedAt from the
 * file mtime, messageCount from the line count. Cheap enough for a single-user
 * tool — one stat + one read per file.
 */
export async function listChats(): Promise<AgentChatSummary[]> {
  if (!existsSync(DATA_DIR)) return [];
  const names = (await readdir(DATA_DIR)).filter((n) => n.endsWith(".jsonl"));
  const out: AgentChatSummary[] = [];
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, "");
    try {
      const file = join(DATA_DIR, name);
      const [info, raw] = await Promise.all([
        stat(file),
        readFile(file, "utf8"),
      ]);
      const messages: ChatCompletionMessageParam[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as ChatCompletionMessageParam);
        } catch {
          /* skip corrupt line */
        }
      }
      if (messages.length === 0) continue; // empty file — nothing to resume
      out.push({
        id,
        title: deriveTitle(messages),
        updatedAt: info.mtimeMs,
        messageCount: messages.length,
      });
    } catch {
      /* unreadable file — omit rather than fail the whole list */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function textContent(content: unknown): string {
  return typeof content === "string" ? content : "";
}

function deriveTitle(messages: ChatCompletionMessageParam[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser ? textContent(firstUser.content).trim() : "";
  if (!text) return "New chat";
  return text.length > 80 ? text.slice(0, 80) + "…" : text;
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

/**
 * Fold stored OpenAI messages into UI transcript entries for replay. Assistant
 * messages carry text and tool_calls together; the following `role:"tool"`
 * messages backfill each tool call's ok/result by tool_call_id. System messages
 * never appear here (the loop adds them per-turn and never persists them).
 */
export function reconstructTranscript(
  messages: ChatCompletionMessageParam[],
): AgentReplayEntry[] {
  const entries: AgentReplayEntry[] = [];
  const toolByCallId = new Map<string, AgentReplayEntry>();
  let n = 0;
  const nextId = () => `h${String(n++)}`;

  for (const m of messages) {
    if (m.role === "user") {
      entries.push({
        kind: "user",
        id: nextId(),
        text: textContent(m.content),
      });
    } else if (m.role === "assistant") {
      const text = textContent(m.content);
      if (text.trim()) {
        entries.push({ kind: "assistant", id: nextId(), text });
      }
      const toolCalls = m.tool_calls as
        ChatCompletionMessageToolCall[] | undefined;
      for (const tc of toolCalls ?? []) {
        if (tc.type !== "function") continue;
        const args = parseArgs(tc.function.arguments);
        const entry: AgentReplayEntry = {
          kind: "tool",
          id: nextId(),
          tool: tc.function.name,
          sessionId: targetSession(args),
          summary: describeCall(tc.function.name, args),
          input: args,
        };
        entries.push(entry);
        toolByCallId.set(tc.id, entry);
      }
    } else if (m.role === "tool") {
      const entry = toolByCallId.get(m.tool_call_id);
      if (!entry) continue;
      const content = textContent(m.content);
      const ok = !(
        content.startsWith("error") ||
        content.startsWith("The user denied") ||
        content.startsWith("Write limit")
      );
      entry.ok = ok;
      if (!ok) entry.resultSummary = content.slice(0, 200);
    }
  }
  return entries;
}
