/**
 * Per-chat conversation persistence as JSONL under data/<chatId>.jsonl.
 *
 * Because the loop is ours, one file serves BOTH jobs the Claude Agent SDK
 * would have handled separately: restoring the model's message history so a
 * dropped WebSocket can resume mid-conversation, and (for the UI) replaying
 * what was said. Each line is one OpenAI chat message.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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
