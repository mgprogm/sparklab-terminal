/**
 * Agent chat store (zustand). Owns the panel's UI state and the folded
 * transcript. The WS connection (connection.ts) drives it through the `ingest`
 * action; components read/dispatch through the hooks below.
 *
 * Only `panelOpen` is persisted (like sidebarCollapsed) — the transcript is
 * ephemeral in the client; durable history lives in the service's JSONL.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AgentApprovalBehavior,
  AgentStatusState,
  AgentWsServerMessage,
} from "@sparklab/shared-types";
import { WRITE_TOOL_NAMES } from "./tool-meta";
import type { TranscriptEntry } from "./types";

let seq = 0;
const nextId = () => `e${String(++seq)}`;

interface AgentState {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;

  connected: boolean;
  setConnected: (c: boolean) => void;

  status: AgentStatusState;
  chatId: string | null;
  entries: TranscriptEntry[];
  unreadCount: number;

  /** Session the composer targets; null = follow the focused terminal ("Auto"). */
  pinnedTargetId: string | null;
  setPinnedTargetId: (id: string | null) => void;

  /** Per-session auto-approve for writes (non-persistent). */
  autoApprove: Record<string, boolean>;
  setAutoApprove: (sessionId: string, on: boolean) => void;

  /** Sessions the agent is actively writing to (for terminal attribution). */
  agentActiveSessionIds: string[];
  /** Internal: outstanding write count per session. */
  _writeActive: Record<string, number>;

  /** Locally append the user's message the moment they hit send. */
  addUserMessage: (text: string) => void;
  /** Fold one server frame into state. */
  ingest: (frame: AgentWsServerMessage) => void;
  /** Resolve an approval entry locally (server has been told separately). */
  resolveApproval: (requestId: string, behavior: AgentApprovalBehavior) => void;
  clearConversation: () => void;
}

function bumpWrite(
  state: AgentState,
  sessionId: string | undefined,
  delta: number,
): Partial<AgentState> {
  if (!sessionId) return {};
  const counts = { ...state._writeActive };
  counts[sessionId] = Math.max(0, (counts[sessionId] ?? 0) + delta);
  if (counts[sessionId] === 0) delete counts[sessionId];
  return {
    _writeActive: counts,
    agentActiveSessionIds: Object.keys(counts),
  };
}

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      panelOpen: false,
      setPanelOpen: (open) =>
        set((s) => ({
          panelOpen: open,
          unreadCount: open ? 0 : s.unreadCount,
        })),
      togglePanel: () =>
        set((s) => ({
          panelOpen: !s.panelOpen,
          unreadCount: !s.panelOpen ? 0 : s.unreadCount,
        })),

      connected: false,
      setConnected: (c) => set({ connected: c }),

      status: "idle",
      chatId: null,
      entries: [],
      unreadCount: 0,

      pinnedTargetId: null,
      setPinnedTargetId: (id) => set({ pinnedTargetId: id }),

      autoApprove: {},
      setAutoApprove: (sessionId, on) =>
        set((s) => ({ autoApprove: { ...s.autoApprove, [sessionId]: on } })),

      agentActiveSessionIds: [],
      _writeActive: {},

      addUserMessage: (text) =>
        set((s) => ({
          entries: [...s.entries, { kind: "user", id: nextId(), text }],
        })),

      ingest: (frame) => {
        switch (frame.type) {
          case "chat_started":
            set({ chatId: frame.chatId });
            break;

          case "assistant_delta":
            set((s) => {
              const last = s.entries[s.entries.length - 1];
              if (last && last.kind === "assistant" && last.streaming) {
                const updated = [...s.entries];
                updated[updated.length - 1] = {
                  ...last,
                  text: last.text + frame.text,
                };
                return { entries: updated };
              }
              return {
                entries: [
                  ...s.entries,
                  {
                    kind: "assistant",
                    id: nextId(),
                    text: frame.text,
                    streaming: true,
                  },
                ],
              };
            });
            break;

          case "assistant_message":
            set((s) => {
              const last = s.entries[s.entries.length - 1];
              const unread = s.panelOpen ? 0 : s.unreadCount + 1;
              if (last && last.kind === "assistant" && last.streaming) {
                const updated = [...s.entries];
                updated[updated.length - 1] = {
                  ...last,
                  text: frame.text,
                  streaming: false,
                };
                return { entries: updated, unreadCount: unread };
              }
              return {
                entries: [
                  ...s.entries,
                  {
                    kind: "assistant",
                    id: nextId(),
                    text: frame.text,
                    streaming: false,
                  },
                ],
                unreadCount: unread,
              };
            });
            break;

          case "tool_use":
            set((s) => {
              // Finalize any open streaming assistant bubble so the next
              // assistant text starts fresh below the tool events.
              const entries = s.entries.map((e) =>
                e.kind === "assistant" && e.streaming
                  ? { ...e, streaming: false }
                  : e,
              );
              const isWrite = WRITE_TOOL_NAMES.has(frame.tool);
              return {
                entries: [
                  ...entries,
                  {
                    kind: "tool",
                    id: frame.callId,
                    tool: frame.tool,
                    sessionId: frame.sessionId,
                    summary: frame.summary,
                    input: frame.input,
                    state: "running",
                  },
                ],
                ...(isWrite ? bumpWrite(s, frame.sessionId, +1) : {}),
              };
            });
            break;

          case "tool_result":
            set((s) => {
              const entries = s.entries.map((e) =>
                e.kind === "tool" && e.id === frame.callId
                  ? {
                      ...e,
                      state: frame.ok ? ("ok" as const) : ("error" as const),
                      resultSummary: frame.summary,
                    }
                  : e,
              );
              return { entries };
            });
            // Clear write-attribution ~1s after the write completes.
            {
              const entry = get().entries.find(
                (e) => e.kind === "tool" && e.id === frame.callId,
              );
              if (
                entry &&
                entry.kind === "tool" &&
                WRITE_TOOL_NAMES.has(entry.tool) &&
                entry.sessionId
              ) {
                const sid = entry.sessionId;
                setTimeout(() => set((s) => bumpWrite(s, sid, -1)), 1000);
              }
            }
            break;

          case "approval_request":
            set((s) => ({
              entries: [
                ...s.entries,
                {
                  kind: "approval",
                  id: frame.requestId,
                  tool: frame.tool,
                  sessionId: frame.sessionId,
                  summary: frame.summary,
                  input: frame.input,
                  state: "pending",
                },
              ],
              unreadCount: s.panelOpen ? 0 : s.unreadCount + 1,
            }));
            break;

          case "status":
            set({ status: frame.state });
            break;

          case "error":
            set((s) => ({
              entries: [
                ...s.entries,
                {
                  kind: "notice",
                  id: nextId(),
                  text: frame.message,
                  tone: "error",
                },
              ],
            }));
            break;

          case "pong":
            break;
        }
      },

      resolveApproval: (requestId, behavior) =>
        set((s) => ({
          entries: s.entries.map((e) =>
            e.kind === "approval" && e.id === requestId
              ? { ...e, state: behavior }
              : e,
          ),
        })),

      clearConversation: () =>
        set({
          entries: [],
          unreadCount: 0,
          status: "idle",
          agentActiveSessionIds: [],
          _writeActive: {},
        }),
    }),
    {
      name: "agent-chat-store",
      partialize: (s) => ({ panelOpen: s.panelOpen }),
    },
  ),
);
