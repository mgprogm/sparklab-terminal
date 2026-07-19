/**
 * Presentation metadata for tools — shared by tool-event rows and the approval
 * card. Keep tool names in sync with apps/agent-service/src/tools.ts.
 */
import {
  Clock,
  Eye,
  Globe2,
  Keyboard,
  List,
  MousePointer2,
  Plus,
  type LucideIcon,
} from "lucide-react";

export const WRITE_TOOL_NAMES = new Set([
  "type_text",
  "press_keys",
  "run_command",
  "create_session",
  "browser_act",
]);

export const BROWSER_TOOL_NAMES = new Set([
  "browser_observe",
  "browser_list_tabs",
  "browser_act",
]);

export function toolIcon(tool: string): LucideIcon {
  switch (tool) {
    case "read_screen":
      return Eye;
    case "list_sessions":
      return List;
    case "wait_idle":
      return Clock;
    case "create_session":
      return Plus;
    case "browser_observe":
      return Globe2;
    case "browser_list_tabs":
      return List;
    case "browser_act":
      return MousePointer2;
    case "type_text":
    case "press_keys":
    case "run_command":
    default:
      return Keyboard;
  }
}

/**
 * Render control characters visibly (caret notation). Returns segments so the
 * caller can tint control glyphs differently from literal text.
 */
export function visualizeKeys(s: string): { text: string; control: boolean }[] {
  const map: Record<string, string> = {
    Enter: "⏎",
    Escape: "⎋",
    Tab: "⇥",
    Space: "␣",
    BSpace: "⌫",
    "C-c": "⌃C",
    "C-d": "⌃D",
    "C-z": "⌃Z",
    "C-l": "⌃L",
    "C-u": "⌃U",
    "C-r": "⌃R",
    Up: "↑",
    Down: "↓",
    Left: "←",
    Right: "→",
    Home: "⇱",
    End: "⇲",
    PageUp: "⇞",
    PageDown: "⇟",
    DC: "⌦",
  };
  if (map[s]) return [{ text: map[s], control: true }];
  // A literal string: surface embedded newlines / CR as glyphs.
  const out: { text: string; control: boolean }[] = [];
  let buf = "";
  for (const ch of s) {
    if (ch === "\n" || ch === "\r") {
      if (buf) {
        out.push({ text: buf, control: false });
        buf = "";
      }
      out.push({ text: "⏎", control: true });
    } else {
      buf += ch;
    }
  }
  if (buf) out.push({ text: buf, control: false });
  return out;
}
