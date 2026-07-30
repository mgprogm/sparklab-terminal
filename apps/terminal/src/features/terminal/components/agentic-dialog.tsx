"use client";

/**
 * AgenticDialog — a thin host seam (per AGENTIC-AI-CREATOR-PLAN.md D8: ONE
 * artifact, an in-app catalog) for the pluggable Agentic AI Creator artifact.
 * The body is a single same-origin `<iframe>` pointed at `/agentic/app.html`;
 * the catalog UI (list apps, create an Agentic AI over `/api/agentic/*`) lives
 * entirely inside that self-contained document, not in React. Swap the file
 * behind the iframe and you swap the artifact.
 *
 * The iframe carries `sandbox="allow-scripts allow-same-origin allow-forms
 * allow-modals"`. `allow-scripts`+`allow-same-origin` provide essentially NO
 * security boundary (a same-origin frame can remove its own sandbox, and it is
 * our own first-party code regardless); their real purpose is DOM/CSS/JS
 * isolation for pluggability. `allow-forms` is required so the artifact's
 * new-app `<form>` submits fire, and `allow-modals` so its `window.confirm()`
 * guards work — without these the browser blocks form submission and modals
 * inside a sandboxed frame. This is NOT presented as a security control.
 *
 * Because the iframe is same-origin to the Next app, its relative
 * `fetch("/api/agentic/…")` calls carry the app-origin `gw_session` cookie
 * through the existing gateway proxy — no new auth surface, no cross-origin.
 *
 * The Agentic AI Creator is gateway-global (D8), so the dialog needs no session
 * or server props — mirrors kanban-dialog.tsx / pm-dialog.tsx.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { Bot } from "lucide-react";

export function AgenticDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="border-border gap-1.5 border-b px-4 py-3 text-left">
          <div className="flex items-center gap-2">
            <Bot className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">
              Agentic AI Creator
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Browse the catalog of Agentic AIs and create a new one. Each Agentic
            AI orchestrates one or more agents over connected artifacts.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src="/agentic/app.html"
          title="Agentic AI Creator"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
