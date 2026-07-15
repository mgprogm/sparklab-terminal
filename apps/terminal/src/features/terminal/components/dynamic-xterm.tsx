"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";

import type { XTermProps } from "./xterm";

/**
 * Dynamically imported XTerm — ssr: false ensures xterm.js never runs on the
 * server (it requires DOM APIs). The loading placeholder renders IN PLACE of
 * the component while the chunk downloads (it is fully replaced on mount, so
 * it can't interfere with tmux's attach redraw / term.reset()).
 */
export const DynamicXTerm = dynamic<XTermProps>(
  () => import("./xterm").then((mod) => mod.XTermComponent),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    ),
  },
);
