"use client";

/**
 * KanbanDialog — a thin host seam (per KANBAN-PLAN.md D6) for the pluggable
 * Kanban board artifact. The body is a single same-origin `<iframe>` pointed
 * at `/kanban/app.html`; the board UI (list/create/move/edit/delete over
 * `/api/kanban/*`) lives entirely inside that self-contained document, not in
 * React. Swap the file behind the iframe and you swap the artifact.
 *
 * The iframe carries `sandbox="allow-scripts allow-same-origin allow-forms
 * allow-modals"`. `allow-scripts`+`allow-same-origin` provide essentially NO
 * security boundary (a same-origin frame can remove its own sandbox, and it is
 * our own first-party code regardless); their real purpose is DOM/CSS/JS
 * isolation for pluggability. `allow-forms` is required so the artifact's
 * new-board / add-card / edit-card `<form>` submits fire, and `allow-modals`
 * so its `window.confirm()` delete guards work — without these the browser
 * blocks form submission and modals inside a sandboxed frame. This is NOT
 * presented as a security control.
 *
 * Because the iframe is same-origin to the Next app, its relative
 * `fetch("/api/kanban/…")` calls carry the app-origin `gw_session` cookie
 * through the existing gateway proxy — no new auth surface, no cross-origin.
 *
 * Styling mirrors file-explorer-dialog.tsx: DESIGN.md theme tokens only (no
 * hardcoded hex), lucide-react icons at size-3.5/size-4, @sparklab/ui
 * primitives. Kanban is gateway-global (D7), so the dialog needs no session
 * or server props.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { SquareKanban } from "lucide-react";

export function KanbanDialog({
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
            <SquareKanban className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">
              Kanban board
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Create, view, and manage multi-board Kanban task boards. Move cards
            between columns, add and edit cards, and manage boards.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src="/kanban/app.html"
          title="Kanban board"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
