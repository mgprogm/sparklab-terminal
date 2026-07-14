/**
 * Key-sequence helpers shared by the extra-keys toolbar and the xterm
 * `onData` handler (mobile UX spec §3.4–3.5).
 *
 * Everything here is pure string → string; all sends still go through the
 * existing binary WS path (`TextEncoder` → `Connection.send`). No protocol
 * change.
 */

/** Sticky-modifier state: off → armed (one-shot) → locked (until tapped off). */
export type ModifierState = "off" | "armed" | "locked";

/**
 * Snapshot of the toolbar's modifier state, shared with the xterm `onData`
 * handler via a ref owned by TerminalShell. `consume()` disarms any
 * one-shot ("armed") modifier after it has been applied to (or passed
 * through with) an input.
 */
export interface ModifierSnapshot {
  ctrl: ModifierState;
  alt: ModifierState;
  consume: () => void;
}

/** Chars that have a Ctrl+<char> control-code mapping (code & 0x1f). */
const CTRL_MAPPABLE = /^[a-zA-Z@[\\\]^_?]$/;

/**
 * Apply active modifiers to a single input chunk.
 *
 * - Ctrl + mappable single char → control code (`c` → `\x03`).
 * - Alt + single char → ESC prefix.
 * - Multi-char chunks (IME/autocomplete commits, CSI sequences) pass through
 *   unmodified.
 */
export function transformInput(
  data: string,
  mods: { ctrl: boolean; alt: boolean },
): string {
  if (data.length !== 1) return data;
  let out = data;
  if (mods.ctrl && CTRL_MAPPABLE.test(out)) {
    out = String.fromCharCode(out.charCodeAt(0) & 0x1f);
  }
  if (mods.alt) out = `\x1b${out}`;
  return out;
}

/**
 * Modifier-aware wrapper used by xterm's `onData`: applies the snapshot's
 * active modifiers and consumes non-locked ones. Non-mappable input passes
 * through unmodified but still consumes an armed modifier.
 */
export function applyModifiers(
  data: string,
  mods: ModifierSnapshot | null | undefined,
): string {
  if (!mods || (mods.ctrl === "off" && mods.alt === "off")) return data;
  const out = transformInput(data, {
    ctrl: mods.ctrl !== "off",
    alt: mods.alt !== "off",
  });
  mods.consume();
  return out;
}

export type ArrowKey = "up" | "down" | "left" | "right";

const ARROW_FINAL: Record<ArrowKey, string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/**
 * Byte sequence for an arrow key.
 *
 * - Unmodified: application cursor keys mode → `\x1bO<X>`, else `\x1b[<X>`
 *   (vim/htop/less set application mode — this matters, spec §3.4).
 * - With modifiers: xterm-style `\x1b[1;<N><X>` where N = 1 + (alt?2) + (ctrl?4).
 */
export function arrowSequence(
  key: ArrowKey,
  applicationCursorKeys: boolean,
  mods: { ctrl: boolean; alt: boolean } = { ctrl: false, alt: false },
): string {
  const final = ARROW_FINAL[key];
  const param = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
  if (param > 1) return `\x1b[1;${param}${final}`;
  return applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
}
