"use client";

/**
 * TaskmasterHubDialog — thin host seam (mirrors PmDialog) for the pluggable
 * Task Master Hub artifact. The body is a single same-origin iframe at
 * /taskmaster-hub/app.html; its self-contained UI talks to /api/taskmaster.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { ListChecks } from "lucide-react";

export function TaskmasterHubDialog({
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
            <ListChecks className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">
              Task Master Hub
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Dashboard over multiple claude-task-master projects. Every
            read/write shells out to the real task-master CLI.
          </DialogDescription>
        </DialogHeader>

        <iframe
          src="/taskmaster-hub/app.html"
          title="Task Master Hub"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
          className="h-full w-full border-0"
        />
      </DialogContent>
    </Dialog>
  );
}
