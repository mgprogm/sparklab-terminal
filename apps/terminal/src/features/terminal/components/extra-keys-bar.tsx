"use client";

/**
 * ExtraKeysBar — mobile toolbar for keys that soft keyboards lack
 * (mobile UX spec §3).
 *
 * - Visible only on coarse-pointer devices (`pointer-coarse:` variant); a
 *   desktop window narrowed below 768 px never shows it.
 * - Every button fires on `pointerdown` with `preventDefault()` so it never
 *   steals focus from xterm's hidden textarea — a `click` handler would
 *   dismiss the OS keyboard on every tap (§3.6).
 * - All sends go through the existing binary WS frame path via
 *   `TerminalHandle.sendInput` (TextEncoder → `Connection.send`). No
 *   protocol change.
 * - `Ctrl`/`Alt` are sticky modifiers: tap → armed (one-shot), tap again →
 *   locked, tap again → off. The current state is mirrored into
 *   `modifiersRef` so xterm's `onData` can modify soft-keyboard input too
 *   (§3.5).
 */

import { cn } from "@sparklab/ui/lib/utils";
import { useEffect, useState } from "react";

import {
  arrowSequence,
  transformInput,
  type ArrowKey,
  type ModifierSnapshot,
  type ModifierState,
} from "../keys";

import type { TerminalHandle } from "./xterm";
import type { RefObject } from "react";

type KeyDef =
  | { label: string; kind: "seq"; seq: string }
  | { label: string; kind: "arrow"; arrow: ArrowKey }
  | { label: string; kind: "mod"; mod: "ctrl" | "alt" };

// Order per spec §3.3 — the first 7 fit without scrolling at 360 px.
const KEYS: KeyDef[] = [
  { label: "Esc", kind: "seq", seq: "\x1b" },
  { label: "Ctrl", kind: "mod", mod: "ctrl" },
  { label: "Tab", kind: "seq", seq: "\x09" },
  { label: "←", kind: "arrow", arrow: "left" },
  { label: "↓", kind: "arrow", arrow: "down" },
  { label: "↑", kind: "arrow", arrow: "up" },
  { label: "→", kind: "arrow", arrow: "right" },
  { label: "-", kind: "seq", seq: "-" },
  { label: "/", kind: "seq", seq: "/" },
  { label: "|", kind: "seq", seq: "|" },
  { label: "~", kind: "seq", seq: "~" },
  { label: "Home", kind: "seq", seq: "\x1b[H" },
  { label: "End", kind: "seq", seq: "\x1b[F" },
  { label: "PgUp", kind: "seq", seq: "\x1b[5~" },
  { label: "PgDn", kind: "seq", seq: "\x1b[6~" },
  { label: "Alt", kind: "mod", mod: "alt" },
];

/** off → armed → locked → off. */
function nextModifierState(state: ModifierState): ModifierState {
  if (state === "off") return "armed";
  if (state === "armed") return "locked";
  return "off";
}

export interface ExtraKeysBarProps {
  /** Imperative handle populated by XTermComponent. */
  handleRef: RefObject<TerminalHandle | null>;
  /** Shared modifier snapshot consumed by xterm's onData handler. */
  modifiersRef: RefObject<ModifierSnapshot | null>;
}

export function ExtraKeysBar({ handleRef, modifiersRef }: ExtraKeysBarProps) {
  const [ctrl, setCtrl] = useState<ModifierState>("off");
  const [alt, setAlt] = useState<ModifierState>("off");

  // Disarm one-shot ("armed") modifiers after they've been applied.
  const consumeArmed = () => {
    setCtrl((s) => (s === "armed" ? "off" : s));
    setAlt((s) => (s === "armed" ? "off" : s));
  };

  // Mirror the current state into the shared ref so the xterm onData handler
  // (soft-keyboard input) sees and consumes it.
  useEffect(() => {
    modifiersRef.current = { ctrl, alt, consume: consumeArmed };
    return () => {
      modifiersRef.current = null;
    };
  }, [ctrl, alt, modifiersRef]);

  const pressKey = (key: KeyDef) => {
    if (key.kind === "mod") {
      const cycle = key.mod === "ctrl" ? setCtrl : setAlt;
      cycle(nextModifierState);
      return;
    }

    const send = (data: string) => handleRef.current?.sendInput(data);
    const mods = { ctrl: ctrl !== "off", alt: alt !== "off" };

    if (key.kind === "arrow") {
      const app = handleRef.current?.getApplicationCursorKeysMode() ?? false;
      send(arrowSequence(key.arrow, app, mods));
    } else {
      // Single chars get Ctrl/Alt applied (Esc, Tab, literals); multi-char
      // sequences (Home/End/PgUp/PgDn) pass through unmodified.
      send(transformInput(key.seq, mods));
    }
    if (mods.ctrl || mods.alt) consumeArmed();
  };

  return (
    <div className="border-border bg-background pointer-coarse:block hidden shrink-0 border-t pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-10 items-stretch gap-0.5 overflow-x-auto px-1 [-webkit-tap-highlight-color:transparent] [overscroll-behavior-x:contain] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {KEYS.map((key) => {
          const modState =
            key.kind === "mod" ? (key.mod === "ctrl" ? ctrl : alt) : null;
          return (
            <button
              key={key.label}
              type="button"
              tabIndex={-1}
              aria-label={key.label}
              aria-pressed={modState ? modState !== "off" : undefined}
              // pointerdown + preventDefault: send without stealing focus
              // from xterm's hidden textarea (§3.6).
              onPointerDown={(e) => {
                e.preventDefault();
                pressKey(key);
              }}
              className={cn(
                "text-secondary-foreground active:bg-accent flex h-10 min-w-10 shrink-0 select-none items-center justify-center rounded-sm px-2 font-mono text-xs transition-colors",
                modState && modState !== "off"
                  ? "bg-primary text-primary-foreground"
                  : undefined,
                // Locked = armed highlight + underline indicator (§3.5).
                modState === "locked" && "underline underline-offset-4",
              )}
            >
              {key.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
