"use client";

/**
 * The agent chat panel. Always mounted (it owns the ⌘J shortcut and the WS
 * connection lifecycle); renders a docked right column on desktop and a bottom
 * Sheet on mobile. Closed = nothing visible but the FAB.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  EllipsisVertical,
  History,
  Loader2,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sparklab/ui/components/ui/sheet";
import { cn } from "@sparklab/ui/lib/utils";
import type {
  AgentApprovalBehavior,
  AgentStatusState,
  SessionInfo,
} from "@sparklab/shared-types";

import { useSessions } from "@/features/terminal/hooks/use-sessions";
import { useTerminalStore } from "@/features/terminal/store";

import { useAgentStore } from "../store";
import { useAgentChat } from "../use-agent-chat";
import { ApprovalCard } from "./approval-card";
import { ChatHistoryDialog } from "./chat-history-dialog";
import { AssistantMessage, UserMessage } from "./chat-message";
import { Composer } from "./composer";
import { ToolEventRow } from "./tool-event-row";
import type { TranscriptEntry } from "../types";

const SUGGESTIONS = [
  "What's running in my sessions?",
  "Re-run the last failing command",
  "Set up a new session for a scratch task",
];

export function AgentChatPanel({ isMobile }: { isMobile: boolean }) {
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const setPanelOpen = useAgentStore((s) => s.setPanelOpen);
  const togglePanel = useAgentStore((s) => s.togglePanel);
  const entries = useAgentStore((s) => s.entries);
  const connected = useAgentStore((s) => s.connected);
  const chatId = useAgentStore((s) => s.chatId);
  const chats = useAgentStore((s) => s.chats);
  const status = useAgentStore((s) => s.status);
  const loadingChat = useAgentStore((s) => s.loadingChat);
  const chatsLoading = useAgentStore((s) => s.chatsLoading);
  const resolveApproval = useAgentStore((s) => s.resolveApproval);
  const setAutoApprove = useAgentStore((s) => s.setAutoApprove);
  const addUserMessage = useAgentStore((s) => s.addUserMessage);

  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const { data: sessions = [] } = useSessions();
  const {
    sendUserMessage,
    sendApproval,
    interrupt,
    listChats,
    newChat,
    loadChat,
    deleteChat,
  } = useAgentChat();

  const [historyOpen, setHistoryOpen] = useState(false);

  // Refresh the history list whenever the modal is open and the socket is up
  // (covers first open, a reconnect while open, and post-delete refetch).
  useEffect(() => {
    if (historyOpen && connected) listChats();
  }, [historyOpen, connected, listChats]);

  const sessionName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) m.set(s.id, s.name);
    return (id?: string) => (id ? (m.get(id) ?? id) : undefined);
  }, [sessions]);

  // ⌘J / Ctrl+J toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePanel]);

  // xterm refits to its container via ResizeObserver; nudge it when the docked
  // column appears/disappears so the terminal reflows to the new width.
  useEffect(() => {
    if (isMobile) return;
    const id = window.setTimeout(
      () => window.dispatchEvent(new Event("resize")),
      50,
    );
    return () => window.clearTimeout(id);
  }, [panelOpen, isMobile]);

  const handleSend = (text: string, target?: string) => {
    addUserMessage(text);
    sendUserMessage(text, target);
  };

  const handleRespond = (
    requestId: string,
    sessionId: string | undefined,
    behavior: AgentApprovalBehavior,
  ) => {
    sendApproval(requestId, behavior);
    resolveApproval(requestId, behavior);
    if (behavior === "allow_always" && sessionId)
      setAutoApprove(sessionId, true);
  };

  const body = (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        connected={connected}
        onNewChat={newChat}
        onOpenHistory={() => setHistoryOpen(true)}
        onClose={() => setPanelOpen(false)}
      />
      <MessageStream
        entries={entries}
        status={status}
        loadingChat={loadingChat}
        sessionName={sessionName}
        onRespond={handleRespond}
        onSuggest={handleSend}
      />
      <Composer
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSend={handleSend}
        onStop={interrupt}
      />
      <ChatHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        chats={chats}
        loading={chatsLoading}
        activeChatId={chatId}
        onSelect={loadChat}
        onDelete={deleteChat}
        onNew={newChat}
      />
    </div>
  );

  if (isMobile) {
    return (
      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent
          side="bottom"
          className="h-[min(85dvh,640px)] gap-0 rounded-t-lg p-0"
        >
          <SheetTitle className="sr-only">Agent chat</SheetTitle>
          <SheetDescription className="sr-only">
            Chat with the terminal agent.
          </SheetDescription>
          {panelOpen && body}
        </SheetContent>
      </Sheet>
    );
  }

  if (!panelOpen) return null;

  return (
    <aside className="border-border bg-background flex w-[360px] shrink-0 flex-col border-l">
      {body}
    </aside>
  );
}

function Header({
  connected,
  onNewChat,
  onOpenHistory,
  onClose,
}: {
  connected: boolean;
  onNewChat: () => void;
  onOpenHistory: () => void;
  onClose: () => void;
}) {
  return (
    <div className="border-border flex h-[42px] shrink-0 items-center gap-2 border-b px-3.5">
      <Sparkles className="text-chart-2 size-4" />
      <span className="text-foreground text-sm font-medium">Agent</span>
      {/* While the panel is open and the socket is down, the connection is
          always retrying — pulse amber so the wait is visible. */}
      <span
        className={cn(
          "size-[6px] rounded-full",
          connected ? "bg-chart-1" : "bg-chart-2 animate-pulse",
        )}
        title={connected ? "connected" : "connecting…"}
      />
      <div className="ml-auto flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-7 items-center justify-center rounded-sm transition-colors"
              aria-label="Chat options"
            >
              <EllipsisVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onNewChat}>
              <Plus className="size-3.5" />
              New chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenHistory}>
              <History className="size-3.5" />
              History
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close agent chat"
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex size-7 items-center justify-center rounded-sm transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

function MessageStream({
  entries,
  status,
  loadingChat,
  sessionName,
  onRespond,
  onSuggest,
}: {
  entries: TranscriptEntry[];
  status: AgentStatusState;
  loadingChat: boolean;
  sessionName: (id?: string) => string | undefined;
  onRespond: (
    requestId: string,
    sessionId: string | undefined,
    behavior: AgentApprovalBehavior,
  ) => void;
  onSuggest: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // The agent is busy but nothing in the stream shows it yet: no streaming
  // assistant bubble, no running tool row, no pending approval card. This
  // covers the send→first-token wait and the post-approval dead zone.
  const last = entries[entries.length - 1];
  const showThinking =
    (status === "thinking" || status === "acting") &&
    !(last?.kind === "assistant" && last.streaming) &&
    !(last?.kind === "tool" && last.state === "running") &&
    !(last?.kind === "approval" && last.state === "pending");

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, showThinking]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (entries.length === 0) {
    // A resumed chat's transcript is in flight — don't flash the new-chat
    // empty state while waiting for the chat_history replay.
    if (loadingChat) {
      return (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-xs">
          <Loader2 className="size-4 animate-spin" />
          Loading chat…
        </div>
      );
    }
    return <EmptyState onSuggest={onSuggest} />;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="[&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/40 flex-1 space-y-2.5 overflow-y-auto px-3.5 py-3 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-1.5"
    >
      {entries.map((e) => {
        switch (e.kind) {
          case "user":
            return <UserMessage key={e.id} entry={e} />;
          case "assistant":
            return <AssistantMessage key={e.id} entry={e} />;
          case "tool":
            return (
              <ToolEventRow
                key={e.id}
                entry={e}
                sessionName={sessionName(e.sessionId)}
              />
            );
          case "approval":
            return e.state === "pending" ? (
              <ApprovalCard
                key={e.id}
                entry={e}
                sessionName={sessionName(e.sessionId)}
                onRespond={(b) => onRespond(e.id, e.sessionId, b)}
              />
            ) : (
              <div
                key={e.id}
                className="border-l-border text-muted-foreground border-l-2 py-1 pl-2 text-xs"
              >
                {e.state === "deny"
                  ? `${e.tool.startsWith("browser_") ? "🌐" : "⌨"} request denied`
                  : e.state === "expired"
                    ? `${e.tool.startsWith("browser_") ? "🌐" : "⌨"} request expired`
                    : `${e.tool.startsWith("browser_") ? "🌐" : "⌨"} approved`}
              </div>
            );
          case "notice":
            return (
              <div
                key={e.id}
                className={cn(
                  "rounded-sm px-2.5 py-1.5 text-xs",
                  e.tone === "error"
                    ? "text-destructive bg-destructive/10"
                    : "text-muted-foreground bg-secondary/40",
                )}
              >
                {e.text}
              </div>
            );
        }
      })}
      {showThinking && (
        <div className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          {status === "acting" ? "Working…" : "Thinking…"}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
      <Sparkles className="text-muted-foreground size-6" />
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">Terminal agent</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Reads your terminals, types commands, manages sessions.
          <br />
          Typing always asks first.
        </p>
      </div>
      <div className="flex flex-col items-stretch gap-1.5 pt-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggest(s)}
            className="border-border bg-card text-secondary-foreground hover:bg-accent rounded-sm border px-2.5 py-1.5 text-xs transition-colors"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
