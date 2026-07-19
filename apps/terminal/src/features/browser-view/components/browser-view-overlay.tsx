"use client";

import { useEffect, useRef } from "react";
import { ArrowLeft, Globe2, RefreshCw } from "lucide-react";

import { useBrowserViewStore } from "../store";

export function BrowserViewOverlay() {
  const view = useBrowserViewStore((state) => state.view);
  const visible = useBrowserViewStore((state) => state.visible);
  const hide = useBrowserViewStore((state) => state.hide);
  const backRef = useRef<HTMLButtonElement>(null);

  // Move keyboard focus off xterm as soon as the overlay opens. Otherwise its
  // hidden textarea can continue sending keystrokes to the covered terminal.
  useEffect(() => {
    if (view && visible) backRef.current?.focus();
  }, [view, visible]);

  if (!view || !visible) return null;

  const imageUrl = `data:${view.screenshot.mediaType};base64,${view.screenshot.data}`;

  return (
    <section
      className="bg-background absolute inset-0 z-20 flex min-h-0 flex-col"
      aria-label="Browser view"
    >
      <div className="border-border flex min-h-[50px] shrink-0 items-center gap-2 border-b px-3">
        <Globe2 className="text-chart-2 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-xs font-medium">
            {view.title || "Browser"}
          </div>
          <div
            className="text-muted-foreground truncate text-[10px]"
            title={view.url}
          >
            {view.url}
          </div>
        </div>
        <span
          className="text-muted-foreground hidden shrink-0 items-center gap-1 text-[10px] sm:flex"
          title={`Browser snapshot revision ${String(view.revision)}`}
        >
          <RefreshCw className="size-3" />
          Updated
        </span>
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
          alt={`Read-only browser snapshot of ${view.title || view.url}`}
          width={view.viewport.width}
          height={view.viewport.height}
          className="max-h-full max-w-full object-contain shadow-lg"
        />
      </div>
      <span className="sr-only">Read-only browser snapshot</span>
    </section>
  );
}
