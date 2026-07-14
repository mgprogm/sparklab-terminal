"use client";

/**
 * Amber attribution overlay for the terminal viewport. When the agent is
 * writing into the currently-visible session, an inset ring + a small pill
 * appear (fading ~1s after the last write, driven by the store's
 * agentActiveSessionIds). Hairline ring only — no shadow (DESIGN.md).
 */
import { Sparkles } from "lucide-react";
import { useAgentStore } from "../store";

export function AgentActivityOverlay({
  activeSessionId,
}: {
  activeSessionId: string | null;
}) {
  const activeIds = useAgentStore((s) => s.agentActiveSessionIds);
  const on = activeSessionId != null && activeIds.includes(activeSessionId);
  if (!on) return null;

  return (
    <div
      className="ring-chart-2/50 pointer-events-none absolute inset-0 z-10 ring-1 ring-inset"
      aria-hidden="true"
    >
      <div className="bg-card border-border text-chart-2 absolute right-2 top-2 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]">
        <span className="bg-chart-2 size-[7px] animate-pulse rounded-full" />
        <Sparkles className="size-3" />
        agent typing
      </div>
    </div>
  );
}
