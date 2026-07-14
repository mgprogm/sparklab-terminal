"use client";

import dynamic from "next/dynamic";

import type { XTermProps } from "./xterm";

/**
 * Dynamically imported XTerm — ssr: false ensures xterm.js never runs on the
 * server (it requires DOM APIs).
 */
export const DynamicXTerm = dynamic<XTermProps>(
  () => import("./xterm").then((mod) => mod.XTermComponent),
  { ssr: false },
);
