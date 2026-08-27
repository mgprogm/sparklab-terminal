"use client";

/**
 * LayoutMenu — header popover exposing the 5 layout-mode presets
 * (docs/MULTI-WINDOW-PLAN.md §3c/D11).
 */

import { Button } from "@sparklab/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@sparklab/ui/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import { Columns2, Columns3, LayoutGrid, Rows2, Square } from "lucide-react";

import { type LayoutMode } from "../store";

const LAYOUT_OPTIONS: {
  mode: LayoutMode;
  label: string;
  Icon: typeof Square;
}[] = [
  { mode: "single", label: "Single", Icon: Square },
  { mode: "cols-2", label: "Two columns", Icon: Columns2 },
  { mode: "rows-2", label: "Two rows", Icon: Rows2 },
  { mode: "cols-3", label: "Three columns", Icon: Columns3 },
  { mode: "grid-2x2", label: "2x2 grid", Icon: LayoutGrid },
];

export interface LayoutMenuProps {
  mode: LayoutMode;
  onSelect: (mode: LayoutMode) => void;
}

export function LayoutMenu({ mode, onSelect }: LayoutMenuProps) {
  const current =
    LAYOUT_OPTIONS.find((o) => o.mode === mode) ?? LAYOUT_OPTIONS[0]!;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Terminal layout"
              className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              size="sm"
              variant="outline"
            >
              <current.Icon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Terminal layout</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {LAYOUT_OPTIONS.map(({ mode: optionMode, label, Icon }) => (
          <DropdownMenuItem
            aria-current={optionMode === mode}
            className={cn(optionMode === mode && "bg-accent")}
            key={optionMode}
            onSelect={() => onSelect(optionMode)}
          >
            <Icon className="size-3.5" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
