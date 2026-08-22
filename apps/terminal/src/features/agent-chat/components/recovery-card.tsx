"use client";

import { Button } from "@sparklab/ui/components/ui/button";
import { CircleAlert } from "lucide-react";

import type { RecoveryEntry } from "../types";

export function RecoveryCard({
  entry,
  onResolve,
}: {
  entry: RecoveryEntry;
  onResolve: (behavior: "verified" | "cancelled") => void;
}) {
  if (entry.state !== "pending") {
    return (
      <div className="border-l-border text-muted-foreground border-l-2 py-1 pl-2 text-xs">
        Recovery{" "}
        {entry.state === "verified"
          ? "verified — you can continue"
          : "cancelled"}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Recovery verification needed"
      className="border-chart-4/50 bg-card flex flex-col gap-2 rounded-md border p-2.5"
    >
      <div className="text-chart-4 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider">
        <CircleAlert className="size-3.5" />
        Verify before continuing
      </div>
      <p className="text-foreground text-xs leading-relaxed">{entry.text}</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => onResolve("verified")}
          className="h-7 text-xs"
        >
          Verify & continue
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResolve("cancelled")}
          className="h-7 text-xs"
        >
          Cancel
        </Button>
      </div>
      <p className="text-muted-foreground text-[11px]">
        The incomplete tool call will not be rerun automatically.
      </p>
    </div>
  );
}
