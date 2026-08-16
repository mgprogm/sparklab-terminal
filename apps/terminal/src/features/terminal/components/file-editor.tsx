"use client";

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { unifiedMergeView } from "@codemirror/merge";
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

export interface FileEditorProps {
  /**
   * The last externally loaded value, not a controlled-input value. Keep this
   * pinned while the user edits: do not feed the latest `onChange` value back
   * into `content`, because a change here replaces the entire editor document.
   * Track edits separately in caller state (for example, `draftContent`),
   * populated by `onChange`.
   */
  content: string;
  gitBaseContent: string | null;
  readOnly?: boolean;
  language?: string;
  onChange: (content: string) => void;
  onSave: () => void;
}

interface SourceFormat {
  lineSeparator: "\n" | "\r\n";
  hasTrailingNewline: boolean;
}

const externalContentUpdate = Annotation.define<boolean>();

function detectSourceFormat(content: string): SourceFormat {
  const lineSeparator = content.includes("\r\n") ? "\r\n" : "\n";

  return {
    lineSeparator,
    // CodeMirror retains the final empty line in its Text document, so no
    // separate trailing-newline transformation is needed on output.
    hasTrailingNewline: content.endsWith(lineSeparator),
  };
}

const editorHighlightStyle = HighlightStyle.define([
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
  {
    tag: [tags.heading, tags.strong],
    color: "var(--foreground)",
    fontWeight: "600",
  },
  { tag: tags.emphasis, fontStyle: "italic" },
  {
    tag: [tags.link, tags.url],
    color: "var(--chart-2)",
    textDecoration: "underline",
  },
  { tag: [tags.invalid, tags.deleted], color: "var(--destructive)" },
]);

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    minHeight: "0",
    color: "var(--foreground)",
    backgroundColor: "var(--background)",
    fontSize: "0.75rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    scrollbarColor: "var(--border) transparent",
    scrollbarWidth: "thin",
  },
  ".cm-scroller::-webkit-scrollbar": { width: "0.375rem", height: "0.375rem" },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    backgroundColor: "var(--border)",
    borderRadius: "9999px",
  },
  ".cm-content": { minHeight: "100%", padding: "0.5rem 0" },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor:
        "color-mix(in srgb, var(--accent-foreground) 22%, transparent)",
    },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
  },
  ".cm-gutters": {
    color: "var(--muted-foreground)",
    backgroundColor: "var(--background)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    color: "var(--foreground)",
    backgroundColor: "var(--accent)",
  },
  ".cm-changeGutter": { borderRight: "0" },
  ".cm-merge-b .cm-changedLineGutter": { background: "var(--chart-1)" },
  ".cm-deletedLineGutter": {
    background: "var(--destructive)",
  },
  ".cm-inlineChangedLineGutter": { backgroundColor: "var(--chart-2)" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "color-mix(in srgb, var(--chart-1) 10%, transparent)",
  },
  ".cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--chart-1) 18%, transparent)",
  },
  ".cm-deletedChunk": {
    color: "var(--muted-foreground)",
    backgroundColor: "color-mix(in srgb, var(--destructive) 10%, transparent)",
  },
  "&.cm-merge-b .cm-deletedText, .cm-deletedChunk .cm-deletedText": {
    background: "color-mix(in srgb, var(--destructive) 18%, transparent)",
  },
  ".cm-tooltip": {
    color: "var(--foreground)",
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
  },
});

function mergeExtension(
  state: EditorState,
  gitBaseContent: string | null,
): Extension {
  if (gitBaseContent === null) return [];

  return unifiedMergeView({
    // Convert through this state's separator-aware API. Passing a string
    // directly would make @codemirror/merge apply its own newline splitter.
    original: state.toText(gitBaseContent),
    gutter: true,
    mergeControls: false,
  });
}

export function FileEditor({
  content,
  gitBaseContent,
  readOnly = false,
  language,
  onChange,
  onSave,
}: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initialContentRef = useRef(content);
  const initialGitBaseContentRef = useRef(gitBaseContent);
  const sourceFormatRef = useRef(detectSourceFormat(content));
  const lineSeparatorCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const sourceFormat = sourceFormatRef.current;
    const lineSeparatorCompartment = lineSeparatorCompartmentRef.current;
    const languageCompartment = languageCompartmentRef.current;
    const mergeCompartment = mergeCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    const initialState = EditorState.create({
      doc: initialContentRef.current,
      extensions: [EditorState.lineSeparator.of(sourceFormat.lineSeparator)],
    });

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialState.doc,
        extensions: [
          lineSeparatorCompartment.of(
            EditorState.lineSeparator.of(sourceFormat.lineSeparator),
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(editorHighlightStyle),
          editorTheme,
          EditorView.editorAttributes.of({ "aria-label": "File editor" }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                onSaveRef.current();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((transaction) =>
                transaction.annotation(externalContentUpdate),
              )
            ) {
              // Text.toString() always uses LF. sliceDoc() is CodeMirror's
              // separator-aware serializer and preserves a final empty line.
              onChangeRef.current(update.state.sliceDoc());
            }
          }),
          languageCompartment.of([]),
          mergeCompartment.of(
            mergeExtension(initialState, initialGitBaseContentRef.current),
          ),
          readOnlyCompartment.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
        ],
      }),
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.sliceDoc() === content) return;

    const sourceFormat = detectSourceFormat(content);
    sourceFormatRef.current = sourceFormat;
    view.dispatch({
      effects: lineSeparatorCompartmentRef.current.reconfigure(
        EditorState.lineSeparator.of(sourceFormat.lineSeparator),
      ),
    });

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: [
        externalContentUpdate.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }, [content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: mergeCompartmentRef.current.reconfigure(
        mergeExtension(view.state, gitBaseContent),
      ),
    });
  }, [gitBaseContent]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const languageCompartment = languageCompartmentRef.current;
    const extension = language?.replace(/^\./, "").toLowerCase();
    const description = extension
      ? languages.find((candidate) =>
          candidate.extensions.some(
            (candidateExtension) =>
              candidateExtension.toLowerCase() === extension,
          ),
        )
      : undefined;
    let cancelled = false;

    view.dispatch({ effects: languageCompartment.reconfigure([]) });
    if (!description) return;

    void description
      .load()
      .then((support) => {
        if (!cancelled && viewRef.current === view) {
          view.dispatch({
            effects: languageCompartment.reconfigure(support),
          });
        }
      })
      .catch(() => {
        // An unavailable optional language bundle leaves the editor in its
        // already-configured plain-text mode.
      });

    return () => {
      cancelled = true;
    };
  }, [language]);

  return (
    <div
      ref={hostRef}
      className="bg-background text-foreground min-h-0 w-full flex-1 overflow-hidden"
    />
  );
}
