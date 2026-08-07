"use client";

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { Button } from "@sparklab/ui/components/ui/button";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";

export interface FileConflictViewProps {
  local: string;
  remote: string;
  onClose: () => void;
}

const conflictHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    color: "var(--chart-2)",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--chart-1)",
  },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: "var(--chart-2)",
  },
  {
    tag: [tags.number, tags.bool, tags.null, tags.atom],
    color: "var(--chart-1)",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--foreground)" },
  { tag: [tags.variableName, tags.name], color: "var(--foreground)" },
  { tag: [tags.invalid, tags.deleted], color: "var(--destructive)" },
]);

const conflictTheme = EditorView.theme({
  "&": {
    minHeight: "100%",
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    fontSize: "0.75rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    scrollbarColor: "var(--border) transparent",
    scrollbarWidth: "thin",
  },
  ".cm-content": { minHeight: "100%", padding: "0.5rem 0" },
  ".cm-line": { padding: "0 0.75rem" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor:
        "color-mix(in srgb, var(--accent-foreground) 22%, transparent)",
    },
  ".cm-gutters": {
    color: "var(--muted-foreground)",
    backgroundColor: "var(--background)",
    borderRight: "1px solid var(--border)",
  },
  "&.cm-merge-a .cm-changedLine": {
    backgroundColor: "color-mix(in srgb, var(--destructive) 10%, transparent)",
  },
  "&.cm-merge-b .cm-changedLine": {
    backgroundColor: "color-mix(in srgb, var(--chart-1) 10%, transparent)",
  },
  ".cm-merge-a .cm-changedText": {
    background: "color-mix(in srgb, var(--destructive) 18%, transparent)",
  },
  ".cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--chart-1) 18%, transparent)",
  },
  ".cm-collapsedLines": {
    color: "var(--muted-foreground)",
    background: "color-mix(in srgb, var(--muted-foreground) 8%, transparent)",
    fontStyle: "italic",
  },
  ".cm-collapsedLines:hover": {
    color: "var(--foreground)",
    background: "color-mix(in srgb, var(--muted-foreground) 14%, transparent)",
  },
});

const readOnlyExtensions: Extension[] = [
  lineNumbers(),
  highlightSpecialChars(),
  drawSelection(),
  syntaxHighlighting(conflictHighlightStyle),
  conflictTheme,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

export function FileConflictView({
  local,
  remote,
  onClose,
}: FileConflictViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initialLocalRef = useRef(local);
  const initialRemoteRef = useRef(remote);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new MergeView({
      a: { doc: initialLocalRef.current, extensions: readOnlyExtensions },
      b: { doc: initialRemoteRef.current, extensions: readOnlyExtensions },
      parent: host,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });
    view.dom.style.height = "100%";

    return () => view.destroy();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border bg-muted-foreground/5 grid grid-cols-[1fr_1fr_auto] items-center border-b text-xs font-medium">
        <span className="border-border border-r px-3 py-1.5">Your version</span>
        <span className="px-3 py-1.5">On disk</span>
        <Button
          variant="ghost"
          size="icon"
          className="mr-1 size-7"
          aria-label="Close diff"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div
        ref={hostRef}
        className="bg-background min-h-0 flex-1 overflow-hidden [&_.cm-mergeView]:h-full"
      />
    </div>
  );
}
