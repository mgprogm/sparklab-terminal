"use client";

/**
 * PmDialog — a thin host seam (per PM-TOOL-PLAN.md D11) for the pluggable
 * Project-management artifact. A sibling of KanbanDialog: the body is a single
 * same-origin `<iframe>` pointed at `/pm/app.html`; the whole PM UI (projects,
 * Board / List / Sprints views, task + sprint CRUD over `/api/pm/*`) lives
 * inside that self-contained document, not in React. Swap the file behind the
 * iframe and you swap the artifact.
 *
 * The iframe carries `sandbox="allow-scripts allow-same-origin allow-forms
 * allow-modals"`. `allow-scripts`+`allow-same-origin` provide essentially NO
 * security boundary (a same-origin frame can remove its own sandbox, and it is
 * our own first-party code regardless); their real purpose is DOM/CSS/JS
 * isolation for pluggability. `allow-forms` is REQUIRED so the artifact's
 * new-project / add-task / edit-task / new-sprint `<form>` submits fire, and
 * `allow-modals` so its `window.confirm()` delete guards work — without these
 * (D11) the browser silently blocks form submission and modals inside a
 * sandboxed frame, the exact gap that bit Kanban. This is NOT a security
 * control.
 *
 * Because the iframe is same-origin to the Next app, its relative
 * `fetch("/api/pm/…")` calls carry the app-origin `gw_session` cookie through
 * the existing gateway proxy — no new auth surface, no cross-origin.
 *
 * Styling mirrors kanban-dialog.tsx: DESIGN.md theme tokens only (no hardcoded
 * hex), lucide-react icons at size-3.5/size-4, @sparklab/ui primitives. PM is
 * gateway-global, so the dialog needs no session or server props.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { SquareGanttChart } from "lucide-react";

export function PmDialog({
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
            <SquareGanttChart className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">
              Project management
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Manage projects, tasks, and sprints. Switch between Board, List, and
            Sprints views; create and edit tasks with assignees, priorities,
            labels, dates, sprints, and dependencies.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src="/pm/app.html"
          title="Project management"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
