"use client";

/**
 * Floating action button anchored bottom-right inside the terminal viewport.
 * Opens the agent chat. Shows a pulsing amber dot while the agent is working
 * and an off-white unread pill otherwise. Hidden while the panel is open.
 */
import { Sparkles } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import { useAgentStore } from "../store";

export function AgentFab() {
  const panelOpen = useAgentStore((s) => s.panelOpen);
  const togglePanel = useAgentStore((s) => s.togglePanel);
  const status = useAgentStore((s) => s.status);
  const unread = useAgentStore((s) => s.unreadCount);

  if (panelOpen) return null;

  const working = status !== "idle";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={togglePanel}
          aria-label={
            unread > 0
              ? `Open agent chat (${String(unread)} unread)`
              : "Open agent chat"
          }
          aria-expanded={panelOpen}
          className={cn(
            "bg-card border-border text-muted-foreground hover:text-foreground hover:bg-accent",
            "absolute bottom-4 right-4 z-10 flex size-9 items-center justify-center rounded-full border shadow-sm transition-colors",
          )}
        >
          <Sparkles className="size-4" />
          {working ? (
            <span className="ring-background bg-chart-2 absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full ring-2" />
          ) : unread > 0 ? (
            <span className="bg-primary text-primary-foreground ring-background absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums ring-2">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Agent — ⌘J</TooltipContent>
    </Tooltip>
  );
}
