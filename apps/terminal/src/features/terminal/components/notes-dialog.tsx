"use client";

/**
 * NotesDialog — a thin host seam (per NOTES-TOOL-PLAN.md D6) for the
 * pluggable OneNote-style Notes artifact. The body is a single same-origin
 * `<iframe>` pointed at `/notes/app.html`; the notebook/section/page UI
 * (list/create/move/edit/delete/search over `/api/notes/*`) lives entirely
 * inside that self-contained document, not in React. Swap the file behind
 * the iframe and you swap the artifact.
 *
 * The iframe carries `sandbox="allow-scripts allow-same-origin allow-forms
 * allow-modals"`. `allow-scripts`+`allow-same-origin` provide essentially NO
 * security boundary (a same-origin frame can remove its own sandbox, and it
 * is our own first-party code regardless); their real purpose is DOM/CSS/JS
 * isolation for pluggability. `allow-forms` is required so the artifact's
 * new-notebook / new-section / new-page `<form>` submits fire, and
 * `allow-modals` so its `window.confirm()` delete guards work — without
 * these the browser blocks form submission and modals inside a sandboxed
 * frame. This is NOT presented as a security control.
 *
 * Because the iframe is same-origin to the Next app, its relative
 * `fetch("/api/notes/…")` calls carry the app-origin `gw_session` cookie
 * through the existing gateway proxy — no new auth surface, no cross-origin.
 *
 * Styling mirrors kanban-dialog.tsx: DESIGN.md theme tokens only (no
 * hardcoded hex), lucide-react icons, @sparklab/ui primitives. Notes is
 * gateway-global (D7), so the dialog needs no session or server props.
 *
 * Sized WIDER than Kanban's reading-width cap because the artifact is a
 * three-pane workspace (notebook/section rail, page tree, editor). Both a
 * bare `max-w-[88vw]` AND `sm:max-w-[88vw]` are required — Tailwind's
 * responsive variants don't get deduped against an unprefixed override, so
 * `DialogContent`'s default `sm:max-w-lg` would otherwise win at desktop
 * widths (the documented Munder Difflin gotcha, see CLAUDE.md).
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { NotebookText } from "lucide-react";

export function NotesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] max-w-[88vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[88vw]">
        <DialogHeader className="border-border gap-1.5 border-b px-4 py-3 text-left">
          <div className="flex items-center gap-2">
            <NotebookText className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">Notes</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Create, view, and manage notebooks, sections, and pages. Search
            across notes and edit Markdown pages.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src="/notes/app.html"
          title="Notes"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
