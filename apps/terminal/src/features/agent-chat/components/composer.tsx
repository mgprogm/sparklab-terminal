"use client";

/**
 * Composer: a single unified input box — an auto-growing textarea over a slim
 * footer holding the target-picker chip (left) and send/stop (right). The
 * target defaults to "Auto" (the focused terminal); picking a session pins it.
 * Enter sends, Shift+Enter inserts a newline. While the agent is working the
 * send button becomes a Stop that interrupts the turn.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Pin, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import { cn } from "@sparklab/ui/lib/utils";
import type { SessionInfo } from "@sparklab/shared-types";
import { useAgentStore } from "../store";

export function Composer({
  sessions,
  activeSessionId,
  onSend,
  onStop,
}: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onSend: (text: string, targetSessionId?: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const status = useAgentStore((s) => s.status);
  const pinnedTargetId = useAgentStore((s) => s.pinnedTargetId);
  const setPinnedTargetId = useAgentStore((s) => s.setPinnedTargetId);

  const working = status !== "idle";
  const effectiveTarget = pinnedTargetId ?? activeSessionId;
  const targetName =
    sessions.find((s) => s.id === effectiveTarget)?.name ?? "no session";

  // Auto-grow: reset then clamp to ~6 rows. Only show the scrollbar once the
  // content actually exceeds the clamp, otherwise a sub-pixel scrollHeight
  // rounding leaves an unwanted scrollbar on a single empty line.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 132);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > 132 ? "auto" : "hidden";
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || working) return;
    onSend(t, effectiveTarget ?? undefined);
    setText("");
  };

  return (
    <div className="border-border border-t px-3 py-2.5">
      <div className="bg-secondary border-border focus-within:border-ring/60 flex flex-col rounded-md border transition-colors">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Ask the agent…"
          className="text-foreground placeholder:text-muted-foreground max-h-[132px] min-h-8 resize-none bg-transparent px-3 pb-1 pt-2 text-base leading-relaxed outline-none sm:text-sm"
        />

        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-xs transition-colors"
              >
                {pinnedTargetId ? (
                  <Pin className="text-chart-2 size-3 shrink-0" />
                ) : (
                  <span>Auto ·</span>
                )}
                <span className="max-w-32 truncate">{targetName}</span>
                <ChevronDown className="size-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuItem onClick={() => setPinnedTargetId(null)}>
                <span className="text-muted-foreground">
                  Auto (follow focused terminal)
                </span>
              </DropdownMenuItem>
              {sessions.map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onClick={() => setPinnedTargetId(s.id)}
                >
                  <span className="bg-chart-1 size-[6px] rounded-full" />
                  <span className="truncate">{s.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {working ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop the agent"
              className="border-chart-2/50 text-chart-2 hover:bg-chart-2/10 flex size-7 shrink-0 items-center justify-center rounded-sm border transition-colors"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              aria-label="Send"
              className={cn(
                "bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity",
                !text.trim() && "opacity-40",
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
