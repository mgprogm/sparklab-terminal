/**
 * @vitest-environment node
 *
 * Tests for the extra-keys / sticky-modifier byte-sequence helpers
 * (mobile UX spec §3.4–3.5). Pure string transforms — the binary WS frame
 * path itself is untouched and covered by connection tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyModifiers,
  arrowSequence,
  transformInput,
  type ModifierSnapshot,
} from "../keys";

const NO_MODS = { ctrl: false, alt: false };

describe("transformInput", () => {
  it("passes input through when no modifier is active", () => {
    expect(transformInput("c", NO_MODS)).toBe("c");
  });

  it("maps Ctrl+letter to a control code (c → \\x03)", () => {
    expect(transformInput("c", { ctrl: true, alt: false })).toBe("\x03");
    expect(transformInput("C", { ctrl: true, alt: false })).toBe("\x03");
    expect(transformInput("[", { ctrl: true, alt: false })).toBe("\x1b");
  });

  it("prefixes ESC for Alt", () => {
    expect(transformInput("b", { ctrl: false, alt: true })).toBe("\x1bb");
  });

  it("applies Ctrl then Alt when both are active", () => {
    expect(transformInput("c", { ctrl: true, alt: true })).toBe("\x1b\x03");
  });

  it("passes non-mappable single chars through for Ctrl", () => {
    expect(transformInput("5", { ctrl: true, alt: false })).toBe("5");
  });

  it("never modifies multi-char chunks (IME commits, CSI sequences)", () => {
    expect(transformInput("\x1b[H", { ctrl: true, alt: true })).toBe("\x1b[H");
    expect(transformInput("hello", { ctrl: true, alt: false })).toBe("hello");
  });
});

describe("applyModifiers", () => {
  const snapshot = (
    ctrl: ModifierSnapshot["ctrl"],
    alt: ModifierSnapshot["alt"],
  ): ModifierSnapshot => ({ ctrl, alt, consume: vi.fn() });

  it("is a no-op without a snapshot", () => {
    expect(applyModifiers("c", null)).toBe("c");
    expect(applyModifiers("c", undefined)).toBe("c");
  });

  it("does not consume when both modifiers are off", () => {
    const mods = snapshot("off", "off");
    expect(applyModifiers("c", mods)).toBe("c");
    expect(mods.consume).not.toHaveBeenCalled();
  });

  it("transforms and consumes when armed", () => {
    const mods = snapshot("armed", "off");
    expect(applyModifiers("c", mods)).toBe("\x03");
    expect(mods.consume).toHaveBeenCalledTimes(1);
  });

  it("transforms when locked (consume is a state-level no-op for locked)", () => {
    const mods = snapshot("locked", "off");
    expect(applyModifiers("d", mods)).toBe("\x04");
    expect(mods.consume).toHaveBeenCalledTimes(1);
  });

  it("consumes even for non-mappable input", () => {
    const mods = snapshot("armed", "off");
    expect(applyModifiers("hello", mods)).toBe("hello");
    expect(mods.consume).toHaveBeenCalledTimes(1);
  });
});

describe("arrowSequence", () => {
  it("uses CSI sequences in normal cursor mode", () => {
    expect(arrowSequence("up", false)).toBe("\x1b[A");
    expect(arrowSequence("down", false)).toBe("\x1b[B");
    expect(arrowSequence("right", false)).toBe("\x1b[C");
    expect(arrowSequence("left", false)).toBe("\x1b[D");
  });

  it("uses SS3 sequences in application cursor mode (vim/htop/less)", () => {
    expect(arrowSequence("up", true)).toBe("\x1bOA");
    expect(arrowSequence("left", true)).toBe("\x1bOD");
  });

  it("uses modified CSI sequences with Ctrl regardless of cursor mode", () => {
    expect(arrowSequence("up", false, { ctrl: true, alt: false })).toBe(
      "\x1b[1;5A",
    );
    expect(arrowSequence("up", true, { ctrl: true, alt: false })).toBe(
      "\x1b[1;5A",
    );
  });

  it("encodes Alt and Ctrl+Alt modifier params", () => {
    expect(arrowSequence("right", false, { ctrl: false, alt: true })).toBe(
      "\x1b[1;3C",
    );
    expect(arrowSequence("down", false, { ctrl: true, alt: true })).toBe(
      "\x1b[1;7B",
    );
  });
});
