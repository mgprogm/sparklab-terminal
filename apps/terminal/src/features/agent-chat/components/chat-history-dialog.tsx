"use client";

/**
 * Chat history modal — a resumable list of past conversations, opened from the
 * panel's "Chat options" menu. Titles come from each chat's first user message;
 * clicking a row resumes it (the service replays its transcript). The current
 * chat is marked and kept at the top of mind; delete removes it for good.
 */
import { Loader2, MessagesSquare, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { cn } from "@sparklab/ui/lib/utils";
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
  onSelect: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  onNew: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-border border-b px-4 py-3">
          <DialogTitle className="text-sm font-medium">
            Chat history
          </DialogTitle>
          <DialogDescription className="sr-only">
            Resume or delete a past conversation with the agent.
          </DialogDescription>
        </DialogHeader>

        <button
          type="button"
          onClick={() => {
            onNew();
            onOpenChange(false);
          }}
          className="border-border text-secondary-foreground hover:bg-accent flex items-center gap-2 border-b px-4 py-2.5 text-sm transition-colors"
        >
          <Plus className="text-muted-foreground size-4" />
          New chat
        </button>

        <div className="[&::-webkit-scrollbar-thumb]:bg-border max-h-[min(60dvh,420px)] overflow-y-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar]:w-1.5">
          {chats.length === 0 && loading ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-10 text-center text-xs">
              <Loader2 className="size-5 animate-spin" />
              Loading conversations…
            </div>
          ) : chats.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-6 py-10 text-center text-xs">
              <MessagesSquare className="size-5 opacity-60" />
              No past conversations yet.
            </div>
          ) : (
            chats.map((c) => {
              const isActive = c.id === activeChatId;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "border-border/60 group flex items-center gap-2 border-b px-4 py-2.5 last:border-b-0",
                    isActive ? "bg-accent/50" : "hover:bg-accent/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(c.id);
                      onOpenChange(false);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start text-left"
                  >
                    <span className="text-foreground line-clamp-1 w-full text-sm">
                      {c.title || "Untitled chat"}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {relativeTime(c.updatedAt)} · {c.messageCount} message
                      {c.messageCount === 1 ? "" : "s"}
                      {isActive ? " · current" : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    aria-label="Delete chat"
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 flex size-7 shrink-0 items-center justify-center rounded-sm opacity-0 transition-colors group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
