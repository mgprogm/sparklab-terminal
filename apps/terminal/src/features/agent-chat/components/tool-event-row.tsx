"use client";

/**
 * A compact one-line record of a tool call, expandable to show the exact
 * input/result. The hairline-left rule marks it as "machine did", distinct
 * from the agent's prose.
 */
import { useState } from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { cn } from "@sparklab/ui/lib/utils";
import { toolIcon, visualizeKeys } from "../tool-meta";
import type { ToolEventEntry } from "../types";

function SessionChip({ name }: { name: string }) {
  return (
    <span className="bg-secondary rounded-xs text-body flex shrink-0 items-center gap-1 px-1.5">
      <span className="bg-chart-1 size-[5px] rounded-full" />
      {name}
    </span>
  );
}

export function ToolEventRow({
  entry,
  sessionName,
}: {
  entry: ToolEventEntry;
  sessionName?: string;
}) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(entry.tool);

  // The summary carries the payload after the first ": " — tint control glyphs.
  const [verb, ...rest] = entry.summary.split(": ");
  const payload = rest.join(": ");

  return (
    <div className="border-l-border border-l-2 pl-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-secondary-foreground flex w-full items-center gap-2 py-1 text-left text-xs"
      >
        {entry.state === "running" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <Icon className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0">{payload ? `${verb}:` : verb}</span>
        {payload && (
          <span className="text-secondary-foreground min-w-0 truncate font-mono">
            {visualizeKeys(payload).map((seg, i) => (
              <span
                key={i}
                className={seg.control ? "text-chart-2" : undefined}
              >
                {seg.text}
              </span>
            ))}
          </span>
        )}
        {sessionName && <SessionChip name={sessionName} />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {entry.state === "ok" && <Check className="text-chart-1 size-3" />}
          {entry.state === "error" && <X className="text-destructive size-3" />}
          <ChevronRight
            className={cn("size-3 transition-transform", open && "rotate-90")}
          />
        </span>
      </button>
      {open && (
        <div className="bg-card border-border mt-1 max-h-56 overflow-auto whitespace-pre rounded-md border p-2 font-mono text-xs">
          {formatInput(entry.input)}
          {entry.resultSummary && (
            <>
              {"\n\n— result —\n"}
              {entry.resultSummary}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
