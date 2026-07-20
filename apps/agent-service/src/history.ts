/**
 * Terminal-linked conversation persistence under data/: one model-message
 * JSONL plus one immutable <chatId>.meta.json ownership record per chat.
 *
 * The JSONL restores model history and reconstructs the UI transcript. The
 * metadata binds the chat to exactly one terminal and lets the service resolve
 * that terminal's latest chat. Same-terminal opens are serialized to avoid
 * minting duplicates when clients switch or reconnect concurrently.
 */
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
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

const DATA_DIR =
  process.env.AGENT_HISTORY_DIR?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "data");

interface ChatMetadata {
  terminalSessionId: string;
  createdAt: number;
}

const terminalLocks = new Map<string, Promise<void>>();
let lastCreatedAt = 0;

function chatFile(chatId: string): string {
  return join(DATA_DIR, `${safeChatId(chatId)}.jsonl`);
}

function metadataFile(chatId: string): string {
  return join(DATA_DIR, `${safeChatId(chatId)}.meta.json`);
}

function safeChatId(chatId: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(chatId)) {
    throw new Error("Invalid chat id");
  }
  return chatId;
}

export function newChatId(): string {
  return randomUUID();
}

async function readMetadata(chatId: string): Promise<ChatMetadata | null> {
  try {
    const parsed = JSON.parse(
      await readFile(metadataFile(chatId), "utf8"),
    ) as Partial<ChatMetadata>;
    return typeof parsed.terminalSessionId === "string" &&
      parsed.terminalSessionId.length > 0 &&
      typeof parsed.createdAt === "number"
      ? {
          terminalSessionId: parsed.terminalSessionId,
          createdAt: parsed.createdAt,
        }
      : null;
  } catch {
    return null;
  }
}

async function linkChat(
  chatId: string,
  terminalSessionId: string,
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  const metadata: ChatMetadata = {
    terminalSessionId,
    createdAt: lastCreatedAt,
  };
  try {
    await writeFile(metadataFile(chatId), JSON.stringify(metadata), {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    const existing = await readMetadata(chatId);
    if (existing?.terminalSessionId === terminalSessionId) return;
    if (existing) {
      throw new Error("Chat belongs to a different terminal session");
    }
    throw error;
  }
}

async function latestChatId(terminalSessionId: string): Promise<string | null> {
  if (!existsSync(DATA_DIR)) return null;
  const names = (await readdir(DATA_DIR)).filter((name) =>
    name.endsWith(".meta.json"),
  );
  let latest: { id: string; updatedAt: number } | null = null;
  for (const name of names) {
    const id = name.replace(/\.meta\.json$/, "");
    const metadata = await readMetadata(id);
    if (metadata?.terminalSessionId !== terminalSessionId) continue;
    let updatedAt = metadata.createdAt;
    try {
      updatedAt = Math.max(updatedAt, (await stat(chatFile(id))).mtimeMs);
    } catch {
      // A brand-new chat has metadata before its first persisted message.
    }
    if (!latest || updatedAt > latest.updatedAt) latest = { id, updatedAt };
  }
  return latest?.id ?? null;
}

/**
 * Resolve the conversation for a terminal. Calls for the same terminal are
 * serialized so two simultaneous first connections cannot mint two chats.
 */
export async function openChat(
  terminalSessionId: string,
  resumeChatId?: string,
  forceNew = false,
): Promise<string> {
  const previous = terminalLocks.get(terminalSessionId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  terminalLocks.set(terminalSessionId, queued);
  await previous;
  try {
    if (resumeChatId) {
      await linkChat(resumeChatId, terminalSessionId);
      return resumeChatId;
    }
    if (!forceNew) {
      const latest = await latestChatId(terminalSessionId);
      if (latest) return latest;
    }
    const chatId = newChatId();
    await linkChat(chatId, terminalSessionId);
    return chatId;
  } finally {
    release();
    if (terminalLocks.get(terminalSessionId) === queued) {
      terminalLocks.delete(terminalSessionId);
    }
  }
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

/** Delete both durable chat files. No-op when they do not exist. */
export async function deleteChat(
  chatId: string,
  terminalSessionId?: string,
): Promise<void> {
  const metadata = await readMetadata(chatId);
  if (
    terminalSessionId &&
    metadata &&
    metadata.terminalSessionId !== terminalSessionId
  ) {
    throw new Error("Chat belongs to a different terminal session");
  }
  await Promise.all(
    [chatFile(chatId), metadataFile(chatId)].map(async (file) => {
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }),
  );
}

/**
 * List every persisted chat, newest-first. Display metadata is derived from the
 * JSONL; terminal ownership comes from the adjacent metadata file. Cheap enough
 * for a single-user tool — one stat + one read per file.
 */
export async function listChats(
  terminalSessionId?: string,
): Promise<AgentChatSummary[]> {
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
      const metadata = await readMetadata(id);
      if (
        terminalSessionId &&
        metadata?.terminalSessionId !== terminalSessionId
      ) {
        continue;
      }
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
        terminalSessionId: metadata?.terminalSessionId ?? null,
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
