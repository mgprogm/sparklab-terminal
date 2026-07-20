"use client";

/**
 * Chat history modal — a resumable list of past conversations, opened from the
 * panel's "Chat options" menu. The service returns only chats owned by the
 * focused terminal; switching terminals clears the list before refetching.
 * Titles come from each chat's first user message. Selecting a row reconnects
 * and replays it; deleting removes both history and terminal ownership.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { cn } from "@sparklab/ui/lib/utils";
import {
  ChevronRight,
  Clock3,
  Loader2,
  MessageSquareText,
  MessagesSquare,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";

import type { AgentChatSummary } from "@sparklab/shared-types";

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function ChatHistoryDialog({
  open,
  onOpenChange,
  chats,
  loading = false,
  activeChatId,
  terminalName,
  onSelect,
  onDelete,
  onNew,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: AgentChatSummary[];
  /** True while the list_chats request is in flight — suppresses the
   *  "no conversations" empty state so it can't flash before the list. */
  loading?: boolean;
  activeChatId: string | null;
  terminalName: string;
  onSelect: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  onNew: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-border/70 border-b px-5 py-5 pr-12">
          <div className="flex items-start gap-3">
            <div className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
              <MessagesSquare className="size-5" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <DialogTitle className="text-base">Chat history</DialogTitle>
              <DialogDescription>
                Conversations are saved separately for each terminal.
              </DialogDescription>
              <div className="bg-muted text-muted-foreground inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium">
                <Terminal className="size-3.5 shrink-0" />
                <span className="truncate">{terminalName}</span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="border-border/70 border-b p-4">
          <button
            type="button"
            onClick={() => {
              onNew();
              onOpenChange(false);
            }}
            className="border-border bg-card hover:border-primary/40 hover:bg-accent focus-visible:border-ring focus-visible:ring-ring/50 shadow-xs flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-colors focus-visible:ring-[3px]"
          >
            <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
              <Plus className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-foreground block text-sm font-medium">
                Start a new chat
              </span>
              <span className="text-muted-foreground block text-xs">
                Begin a fresh conversation in this terminal
              </span>
            </span>
            <ChevronRight className="text-muted-foreground size-4 shrink-0" />
          </button>
        </div>

        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <h3 className="text-foreground text-xs font-semibold uppercase tracking-wide">
            Conversations
          </h3>
          {!loading && chats.length > 0 ? (
            <span className="text-muted-foreground text-xs">
              {chats.length} conversation{chats.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div className="[&::-webkit-scrollbar-thumb]:bg-border max-h-[min(55dvh,420px)] overflow-y-auto px-3 pb-3 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar]:w-1.5">
          {chats.length === 0 && loading ? (
            <div
              role="status"
              className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-12 text-center text-xs"
            >
              <Loader2 className="size-5 animate-spin" />
              Loading conversations…
            </div>
          ) : chats.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <div className="bg-muted text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-full">
                <MessageSquareText className="size-5" />
              </div>
              <p className="text-foreground text-sm font-medium">
                No conversations yet
              </p>
              <p className="text-muted-foreground mt-1 max-w-64 text-xs leading-relaxed">
                Start a chat and it will appear here, linked only to{" "}
                {terminalName}.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {chats.map((c) => {
                const isActive = c.id === activeChatId;
                const title = c.title || "Untitled chat";
                return (
                  <div
                    key={c.id}
                    className={cn(
                      "border-border/70 group relative flex items-center gap-1 rounded-lg border transition-colors",
                      isActive
                        ? "border-primary/30 bg-primary/5"
                        : "hover:bg-accent/60",
                    )}
                  >
                    {isActive ? (
                      <span className="bg-primary absolute inset-y-2 left-0 w-0.5 rounded-r-full" />
                    ) : null}
                    <button
                      type="button"
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => {
                        onSelect(c.id);
                        onOpenChange(false);
                      }}
                      className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-[3px]"
                    >
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-md",
                          isActive
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        <MessageSquareText className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-foreground truncate text-sm font-medium">
                            {title}
                          </span>
                          {isActive ? (
                            <span className="bg-primary/15 text-primary shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                              Current
                            </span>
                          ) : null}
                        </span>
                        <span className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          <span className="inline-flex items-center gap-1">
                            <Clock3 className="size-3" />
                            {relativeTime(c.updatedAt)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <MessageSquareText className="size-3" />
                            {c.messageCount} message
                            {c.messageCount === 1 ? "" : "s"}
                          </span>
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(c.id)}
                      aria-label={`Delete chat: ${title}`}
                      title={`Delete ${title}`}
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/30 mr-2 flex size-8 shrink-0 items-center justify-center rounded-md opacity-100 outline-none transition-all focus-visible:ring-[3px] sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
