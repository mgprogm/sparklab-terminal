"use client";

/**
 * The agent chat panel. Always mounted (it owns the ⌘J shortcut and the WS
 * connection lifecycle); renders a docked right column on desktop and a bottom
 * Sheet on mobile. Closed = nothing visible but the FAB.
 */
import { useEffect, useMemo, useRef } from "react";
import { EllipsisVertical, Sparkles, Trash2, X } from "lucide-react";
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
  SessionInfo,
} from "@sparklab/shared-types";

import { useSessions } from "@/features/terminal/hooks/use-sessions";
import { useTerminalStore } from "@/features/terminal/store";

import { useAgentStore } from "../store";
import { useAgentChat } from "../use-agent-chat";
import { ApprovalCard } from "./approval-card";
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
  const clearConversation = useAgentStore((s) => s.clearConversation);
  const resolveApproval = useAgentStore((s) => s.resolveApproval);
  const setAutoApprove = useAgentStore((s) => s.setAutoApprove);
  const addUserMessage = useAgentStore((s) => s.addUserMessage);

  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const { data: sessions = [] } = useSessions();
  const { sendUserMessage, sendApproval, interrupt } = useAgentChat();

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
        onClear={clearConversation}
        onClose={() => setPanelOpen(false)}
      />
      <MessageStream
        entries={entries}
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
  onClear,
  onClose,
}: {
  connected: boolean;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <div className="border-border flex h-[42px] shrink-0 items-center gap-2 border-b px-3.5">
      <Sparkles className="text-chart-2 size-4" />
      <span className="text-foreground text-sm font-medium">Agent</span>
      <span
        className={cn(
          "size-[6px] rounded-full",
          connected ? "bg-chart-1" : "bg-muted-foreground/50",
        )}
        title={connected ? "connected" : "disconnected"}
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
            <DropdownMenuItem onClick={onClear}>
              <Trash2 className="size-3.5" />
              Clear conversation
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
  sessionName,
  onRespond,
  onSuggest,
}: {
  entries: TranscriptEntry[];
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

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (entries.length === 0) {
    return <EmptyState onSuggest={onSuggest} />;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3"
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
                  ? "⌨ request denied"
                  : e.state === "expired"
                    ? "⌨ request expired"
                    : "⌨ approved"}
              </div>
            );
          case "notice":
            return (
              <div
                key={e.id}
                className={cn(
                  "rounded-sm px-3 py-2 text-xs",
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
    </div>
  );
}

function EmptyState({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Sparkles className="text-muted-foreground size-8" />
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
