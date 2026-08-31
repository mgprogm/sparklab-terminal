"use client";

import { ArrowLeft, Monitor, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";

import { useComputerViewStore } from "../store";

/**
 * Read-only overlay for the agent's disposable Linux desktop — the desktop
 * sibling of `BrowserViewOverlay`, minus handoff (docs/VIRTUAL-COMPUTER.md D4
 * reserves `/computer-handoff` for a later phase). It renders above xterm
 * without unmounting or resizing it and moves focus off xterm's hidden
 * textarea while shown.
 */
export function ComputerViewOverlay() {
  const view = useComputerViewStore((state) => state.view);
  const visible = useComputerViewStore((state) => state.visible);
  const hide = useComputerViewStore((state) => state.hide);
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (view && visible) backRef.current?.focus();
  }, [view, visible]);

  if (!view || !visible) return null;

  const imageUrl = `data:${view.screenshot.mediaType};base64,${view.screenshot.data}`;

  return (
    <section
      className="bg-background absolute inset-0 z-20 flex min-h-0 flex-col"
      aria-label="Computer view"
    >
      <div className="border-border flex min-h-[50px] shrink-0 items-center gap-2 border-b px-3">
        <Monitor className="text-chart-2 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-xs font-medium">
            Virtual computer
          </div>
          <div className="text-muted-foreground truncate text-[10px]">
            {view.status} · {view.viewport.width}×{view.viewport.height}
          </div>
        </div>
        <button
          ref={backRef}
          type="button"
          onClick={hide}
          className="border-border bg-card text-secondary-foreground hover:bg-accent flex h-7 shrink-0 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Back to terminal
        </button>
      </div>

      <div className="bg-muted/30 flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <img
          src={imageUrl}
          alt="Read-only snapshot of the agent's virtual computer desktop"
          width={view.viewport.width}
          height={view.viewport.height}
          className="max-h-full max-w-full object-contain shadow-lg"
        />
      </div>

      <div className="border-border text-muted-foreground flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[11px]">
        <RefreshCw className="size-3" /> Read-only snapshot · Updated revision{" "}
        {view.revision}
      </div>
    </section>
  );
}
