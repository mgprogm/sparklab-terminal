/** Durable, append-only state for agent runs. Never store browser pixels/tokens. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type RunLifecycle =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "recovery_required";

export interface AgentRunState {
  id: string;
  chatId: string;
  terminalSessionId: string;
  user: string;
  lifecycle: RunLifecycle;
  lastSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunEvent {
  seq: number;
  at: number;
  kind: string;
  payload?: unknown;
}

const DATA_DIR =
  process.env.AGENT_RUN_DIR?.trim() ||
  join(
    process.env.AGENT_HISTORY_DIR?.trim() ||
      join(dirname(fileURLToPath(import.meta.url)), "..", "data"),
    "runs",
  );

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error("Invalid run id");
  return id;
}

function stateFile(id: string): string {
  return join(DATA_DIR, `${safeId(id)}.json`);
}

function eventFile(id: string): string {
  return join(DATA_DIR, `${safeId(id)}.events.jsonl`);
}

export function newRunState(
  chatId: string,
  terminalSessionId: string,
  user: string,
): AgentRunState {
  const now = Date.now();
  return {
    id: randomUUID(),
    chatId,
    terminalSessionId,
    user,
    lifecycle: "idle",
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export async function writeRunState(state: AgentRunState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const target = stateFile(state.id);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), "utf8");
  await rename(temporary, target);
}

export async function appendRunEvent(
  id: string,
  event: AgentRunEvent,
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(eventFile(id), `${JSON.stringify(event)}\n`, "utf8");
}

export async function listRunStates(): Promise<AgentRunState[]> {
  if (!existsSync(DATA_DIR)) return [];
  const names = (await readdir(DATA_DIR)).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".events.json"),
  );
  const states: AgentRunState[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(
        await readFile(join(DATA_DIR, name), "utf8"),
      ) as AgentRunState;
      if (
        typeof value.id === "string" &&
        typeof value.chatId === "string" &&
        typeof value.terminalSessionId === "string" &&
        typeof value.user === "string" &&
        typeof value.lastSeq === "number" &&
        typeof value.lifecycle === "string"
      )
        states.push(value);
    } catch {
      // A corrupt state must not prevent other runs from recovering.
    }
  }
  return states;
}

export async function latestRunForChat(
  chatId: string,
): Promise<AgentRunState | null> {
  const matches = (await listRunStates())
    .filter((state) => state.chatId === chatId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] ?? null;
}

/**
 * Restore only text that was streamed after the last durable assistant message.
 * Replaying every frame would duplicate tool rows already reconstructed from
 * chat JSONL; an unfinished text segment has no JSONL equivalent.
 */
export async function unfinishedAssistantText(runId: string): Promise<string> {
  if (!existsSync(eventFile(runId))) return "";
  let text = "";
  const raw = await readFile(eventFile(runId), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AgentRunEvent;
      if (event.kind !== "frame" || !event.payload) continue;
      const frame = event.payload as { type?: unknown; text?: unknown };
      if (frame.type === "assistant_delta" && typeof frame.text === "string")
        text += frame.text;
      else if (frame.type === "assistant_message" || frame.type === "error")
        text = "";
    } catch {
      // Individual corrupt event lines do not invalidate the journal.
    }
  }
  return text;
}

async function hasUnresolvedTool(runId: string): Promise<boolean> {
  if (!existsSync(eventFile(runId))) return false;
  const pending = new Set<string>();
  const raw = await readFile(eventFile(runId), "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as AgentRunEvent;
      if (event.kind !== "frame" || !event.payload) continue;
      const frame = event.payload as { type?: unknown; callId?: unknown };
      if (frame.type === "tool_use" && typeof frame.callId === "string")
        pending.add(frame.callId);
      if (frame.type === "tool_result" && typeof frame.callId === "string")
        pending.delete(frame.callId);
    } catch {
      // Corrupt events are ignored; recovery must remain conservative.
    }
  }
  return pending.size > 0;
}

/** Mark live work interrupted: model streams cannot resume safely after restart. */
export async function recoverInterruptedRuns(): Promise<AgentRunState[]> {
  const recovered: AgentRunState[] = [];
  for (const state of await listRunStates()) {
    if (
      state.lifecycle !== "running" &&
      state.lifecycle !== "awaiting_approval"
    )
      continue;
    const recoveryRequired = await hasUnresolvedTool(state.id);
    const next: AgentRunState = {
      ...state,
      lifecycle: recoveryRequired ? "recovery_required" : "interrupted",
      lastSeq: state.lastSeq + 1,
      updatedAt: Date.now(),
    };
    await appendRunEvent(next.id, {
      seq: next.lastSeq,
      at: next.updatedAt,
      kind: recoveryRequired ? "recovery_required" : "interrupted",
    });
    await writeRunState(next);
    recovered.push(next);
  }
  return recovered;
}
