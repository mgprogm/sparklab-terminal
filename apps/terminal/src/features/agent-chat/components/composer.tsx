"use client";

/**
 * Composer: a single unified input box — an auto-growing textarea over a slim
 * footer holding the target-picker chip (left) and send/stop (right). The
 * target defaults to "Auto" (the focused terminal); picking a session pins it.
 * Enter sends, Shift+Enter inserts a newline. While the agent is working the
 * send button becomes a Stop that interrupts the turn.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import { cn } from "@sparklab/ui/lib/utils";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Pin,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useAgentStore } from "../store";

import type {
  AgentModel,
  AgentReasoningEffort,
  SessionInfo,
} from "@sparklab/shared-types";

const MODEL_LABELS: Record<AgentModel, string> = {
  "gpt-5.6-sol": "Sol",
  "gpt-5.6-terra": "Terra",
  "gpt-5.6-luna": "Luna",
};

const EFFORT_LABELS: Record<AgentReasoningEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function Composer({
  sessions,
  activeSessionId,
  disabled = false,
  onSend,
  onStop,
}: {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  disabled?: boolean;
  onSend: (
    text: string,
    targetSessionId?: string,
    model?: AgentModel,
    reasoningEffort?: AgentReasoningEffort,
  ) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const status = useAgentStore((s) => s.status);
  const pinnedTargetId = useAgentStore((s) => s.pinnedTargetId);
  const setPinnedTargetId = useAgentStore((s) => s.setPinnedTargetId);
  const model = useAgentStore((s) => s.model);
  const setModel = useAgentStore((s) => s.setModel);
  const reasoningEffort = useAgentStore((s) => s.reasoningEffort);
  const setReasoningEffort = useAgentStore((s) => s.setReasoningEffort);
  const availableModels = useAgentStore((s) => s.availableModels);
  const availableReasoningEfforts = useAgentStore(
    (s) => s.availableReasoningEfforts,
  );

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
    if (!t || working || disabled) return;
    onSend(t, effectiveTarget ?? undefined, model, reasoningEffort);
    setText("");
  };

  return (
    <div className="border-border border-t px-3 py-2.5">
      <div className="bg-secondary border-border focus-within:border-ring/60 flex flex-col rounded-md border transition-colors">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled ? "Waiting for terminal chat…" : "Ask the agent…"
          }
          className="text-foreground placeholder:text-muted-foreground max-h-[132px] min-h-8 resize-none bg-transparent px-3 pb-1 pt-2 text-base leading-relaxed outline-none sm:text-sm"
        />

        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex min-w-0 items-center gap-1">
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
                  <span className="max-w-24 truncate">{targetName}</span>
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={working || disabled}
                  aria-label="Choose agent model and reasoning effort"
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50"
                >
                  <SlidersHorizontal className="size-3 shrink-0" />
                  <span>
                    {MODEL_LABELS[model]} · {EFFORT_LABELS[reasoningEffort]}
                  </span>
                  <ChevronDown className="size-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuLabel>Model</DropdownMenuLabel>
                {availableModels.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onClick={() => setModel(option)}
                  >
                    <span>{MODEL_LABELS[option]}</span>
                    {model === option && <Check className="ml-auto size-3.5" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
                {availableReasoningEfforts.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onClick={() => setReasoningEffort(option)}
                  >
                    <span>{EFFORT_LABELS[option]}</span>
                    {reasoningEffort === option && (
                      <Check className="ml-auto size-3.5" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

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
              disabled={!text.trim() || disabled}
              aria-label="Send"
              className={cn(
                "bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-sm transition-opacity",
                (!text.trim() || disabled) && "opacity-40",
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
