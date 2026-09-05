/**
 * Agent chat store (zustand). Owns the panel's UI state and the folded
 * transcript. The WS connection (connection.ts) drives it through the `ingest`
 * action; components read/dispatch through the hooks below.
 *
 * Persisted keys include the latest chat id per terminal session (see
 * partialize). The transcript is ephemeral here; durable history and terminal
 * ownership live in the service.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { WRITE_TOOL_NAMES } from "./tool-meta";

import type { TranscriptEntry } from "./types";
import type {
  AgentApprovalBehavior,
  AgentChatSummary,
  AgentModel,
  AgentReasoningEffort,
  AgentReplayEntry,
  AgentStatusState,
  AgentWsServerMessage,
  OpenRouterCatalogModel,
} from "@sparklab/shared-types";

/** Fold a server-reconstructed replay entry into a UI transcript entry. */
function replayToEntry(e: AgentReplayEntry): TranscriptEntry {
  switch (e.kind) {
    case "user":
      return { kind: "user", id: e.id, text: e.text ?? "" };
    case "assistant":
      return {
        kind: "assistant",
        id: e.id,
        text: e.text ?? "",
        streaming: false,
      };
    case "tool":
      return {
        kind: "tool",
        id: e.id,
        tool: e.tool ?? "",
        sessionId: e.sessionId,
        summary: e.summary ?? "",
        input: e.input,
        // A tool call is persisted before it is approved/executed. Preserve
        // that incomplete state on a reconnect instead of rendering it as a
        // successful invocation.
        state: e.ok === false ? "error" : e.ok === undefined ? "running" : "ok",
        resultSummary: e.resultSummary,
      };
  }
}

let seq = 0;
const nextId = () => `e${String(++seq)}`;

/** Desktop presentation of the agent panel: right-docked column or modal. */
export type AgentDisplayMode = "docked" | "modal";

interface AgentState {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;

  /** Desktop-only; mobile always uses the bottom Sheet regardless. */
  displayMode: AgentDisplayMode;
  setDisplayMode: (mode: AgentDisplayMode) => void;
  toggleDisplayMode: () => void;

  connected: boolean;
  setConnected: (c: boolean) => void;

  status: AgentStatusState;
  chatId: string | null;
  /** Terminal whose chat is currently rendered. */
  terminalSessionId: string | null;
  /** Last known chat per terminal, used for immediate reload/switch resume. */
  chatIdsByTerminal: Record<string, string>;
  /** One-time migration bridge from the former single global persisted chat. */
  legacyChatId: string | null;
  entries: TranscriptEntry[];
  unreadCount: number;

  /** Past chats for the history modal (populated by `list_chats`). */
  chats: AgentChatSummary[];
  /** True between a `list_chats` request and its `chat_list` response — the
   *  history modal shows a loading row instead of "no conversations". */
  chatsLoading: boolean;
  /** True between a loadChat() reconnect and its `chat_history` replay — the
   *  panel shows "Loading chat…" instead of the new-chat empty state. */
  loadingChat: boolean;

  /** Session the composer targets; null = follow the focused terminal ("Auto"). */
  pinnedTargetId: string | null;
  setPinnedTargetId: (id: string | null) => void;

  /** Model settings apply to the next user message and persist locally. */
  model: AgentModel;
  setModel: (model: AgentModel) => void;
  reasoningEffort: AgentReasoningEffort;
  setReasoningEffort: (effort: AgentReasoningEffort) => void;
  availableModels: AgentModel[];
  availableReasoningEfforts: AgentReasoningEffort[];

  /**
   * The live OpenRouter model catalog for the composer's search picker.
   * Ephemeral (not persisted) — refetched per session via
   * `openrouter_models_request`; empty until first requested or when
   * OpenRouter isn't configured on the service.
   */
  openrouterCatalog: OpenRouterCatalogModel[];
  openrouterCatalogLoading: boolean;
  openrouterCatalogFetchedAt: number | null;
  setOpenRouterCatalogLoading: (loading: boolean) => void;
  /**
   * The specific OpenRouter catalog model selected for the next turn. The
   * composer only reaches OpenRouter through the search picker (there is no
   * plain "use the fixed default" row), so this is set once a result is
   * selected and stays set thereafter — null only for a chat that has never
   * used OpenRouter, or stale state persisted from before this field
   * existed. Persisted (unlike the catalog itself) so a page reload doesn't
   * silently lose the selection.
   */
  openrouterModelId: string | null;
  openrouterModelLabel: string | null;
  openrouterModelSupportedEfforts: AgentReasoningEffort[] | null;
  selectOpenRouterModel: (
    id: string,
    label: string,
    supportedEfforts: AgentReasoningEffort[] | null,
  ) => void;

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
  /** Wipe transcript + chatId for a fresh chat (the WS reconnects with none). */
  resetForNewChat: () => void;
  /** Clear transient state while a terminal-specific connection is opening. */
  beginTerminalSwitch: (
    terminalSessionId: string | null,
    chatId?: string | null,
  ) => void;
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

      displayMode: "docked",
      setDisplayMode: (mode) => set({ displayMode: mode }),
      toggleDisplayMode: () =>
        set((s) => ({
          displayMode: s.displayMode === "docked" ? "modal" : "docked",
        })),

      connected: false,
      setConnected: (c) => set({ connected: c }),

      status: "idle",
      chatId: null,
      terminalSessionId: null,
      chatIdsByTerminal: {},
      legacyChatId: null,
      entries: [],
      unreadCount: 0,
      chats: [],
      chatsLoading: false,
      loadingChat: false,

      pinnedTargetId: null,
      setPinnedTargetId: (id) => set({ pinnedTargetId: id }),

      model: "gpt-5.6-sol",
      setModel: (model) => set({ model }),
      reasoningEffort: "medium",
      setReasoningEffort: (reasoningEffort) => set({ reasoningEffort }),
      availableModels: ["gpt-5.6-sol"],
      availableReasoningEfforts: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],

      openrouterCatalog: [],
      openrouterCatalogLoading: false,
      openrouterCatalogFetchedAt: null,
      setOpenRouterCatalogLoading: (loading) =>
        set({ openrouterCatalogLoading: loading }),
      openrouterModelId: null,
      openrouterModelLabel: null,
      openrouterModelSupportedEfforts: null,
      selectOpenRouterModel: (id, label, supportedEfforts) =>
        set((s) => ({
          model: "openrouter-gpt-latest",
          openrouterModelId: id,
          openrouterModelLabel: label,
          openrouterModelSupportedEfforts: supportedEfforts,
          // Don't silently keep an effort this model doesn't support.
          reasoningEffort:
            supportedEfforts && !supportedEfforts.includes(s.reasoningEffort)
              ? supportedEfforts[0]
              : s.reasoningEffort,
        })),

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
          case "agent_capabilities":
            set((state) => ({
              availableModels: frame.models,
              availableReasoningEfforts: frame.reasoningEfforts,
              model: frame.models.includes(state.model)
                ? state.model
                : frame.defaultModel,
              reasoningEffort: frame.reasoningEfforts.includes(
                state.reasoningEffort,
              )
                ? state.reasoningEffort
                : frame.defaultReasoningEffort,
            }));
            break;

          case "chat_started":
            set((state) => ({
              chatId: frame.chatId,
              terminalSessionId: frame.terminalSessionId,
              chatIdsByTerminal: {
                ...state.chatIdsByTerminal,
                [frame.terminalSessionId]: frame.chatId,
              },
              legacyChatId: null,
              loadingChat: false,
            }));
            break;

          case "chat_list":
            set({ chats: frame.chats, chatsLoading: false });
            break;

          case "openrouter_models_response":
            set({
              openrouterCatalog: frame.models,
              openrouterCatalogFetchedAt: frame.fetchedAt,
              openrouterCatalogLoading: false,
            });
            break;

          case "chat_history":
            // REPLACE, never append: this fires on explicit load, page reload,
            // AND every transient reconnect (server JSONL is the source of
            // truth). Appending would duplicate the transcript on a flaky link.
            set({
              chatId: frame.chatId,
              entries: frame.entries.map(replayToEntry),
              unreadCount: 0,
              status: "idle",
              loadingChat: false,
              agentActiveSessionIds: [],
              _writeActive: {},
            });
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
              const existingIndex = entries.findIndex(
                (e) => e.kind === "tool" && e.id === frame.callId,
              );
              if (existingIndex >= 0) {
                const updated = [...entries];
                updated[existingIndex] = {
                  kind: "tool",
                  id: frame.callId,
                  tool: frame.tool,
                  sessionId: frame.sessionId,
                  summary: frame.summary,
                  input: frame.input,
                  state: "running",
                };
                return {
                  entries: updated,
                  ...(isWrite ? bumpWrite(s, frame.sessionId, +1) : {}),
                };
              }
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

          case "approval_resolved":
            get().resolveApproval(frame.requestId, frame.behavior);
            break;

          case "recovery_required":
            set((s) => ({
              entries: [
                ...s.entries.filter((e) => e.kind !== "recovery"),
                {
                  kind: "recovery",
                  id: nextId(),
                  text: frame.message,
                  state: "pending",
                },
              ],
              unreadCount: s.panelOpen ? 0 : s.unreadCount + 1,
            }));
            break;

          case "recovery_resolved":
            set((s) => ({
              entries: s.entries.map((e) =>
                e.kind === "recovery" && e.state === "pending"
                  ? { ...e, state: frame.behavior }
                  : e,
              ),
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

      resetForNewChat: () =>
        set({
          chatId: null,
          entries: [],
          unreadCount: 0,
          status: "idle",
          loadingChat: false,
          agentActiveSessionIds: [],
          _writeActive: {},
        }),

      beginTerminalSwitch: (terminalSessionId, chatId = null) =>
        set({
          terminalSessionId,
          chatId,
          entries: [],
          unreadCount: 0,
          status: "idle",
          loadingChat: terminalSessionId !== null,
          chats: [],
          chatsLoading: false,
          pinnedTargetId: null,
          agentActiveSessionIds: [],
          _writeActive: {},
        }),
    }),
    {
      name: "agent-chat-store",
      partialize: (s) => ({
        panelOpen: s.panelOpen,
        displayMode: s.displayMode,
        chatIdsByTerminal: s.chatIdsByTerminal,
        legacyChatId: s.legacyChatId,
        model: s.model,
        reasoningEffort: s.reasoningEffort,
        openrouterModelId: s.openrouterModelId,
        openrouterModelLabel: s.openrouterModelLabel,
        openrouterModelSupportedEfforts: s.openrouterModelSupportedEfforts,
      }),
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as Partial<AgentState>;
        if (version === 0) {
          return {
            ...state,
            legacyChatId:
              typeof state.chatId === "string" ? state.chatId : null,
            chatId: null,
            chatIdsByTerminal: {},
          } as AgentState;
        }
        return state as AgentState;
      },
    },
  ),
);
