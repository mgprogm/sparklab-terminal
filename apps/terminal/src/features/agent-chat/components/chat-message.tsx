"use client";

/**
 * User and assistant message rows. User = a quiet full-width block; assistant =
 * a streaming block cursor while text arrives. During streaming we use a cheap
 * inline formatter (backtick code + line breaks); once the response finishes we
 * swap in the full markdown renderer (see ./markdown) so the final message gets
 * headings, lists, tables, links, and fenced code.
 */
import { Loader2, Square, Volume2 } from "lucide-react";
import { Fragment } from "react";
import { cn } from "@sparklab/ui/lib/utils";
import { Markdown } from "./markdown";
import type { AssistantEntry, UserEntry } from "../types";

function renderInline(text: string) {
  // Split on `code` spans; preserve newlines as <br/>.
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          key={i}
          className="bg-secondary/60 rounded-xs px-1 font-mono text-[0.85em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    const lines = part.split("\n");
    return (
      <Fragment key={i}>
        {lines.map((line, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {line}
          </Fragment>
        ))}
      </Fragment>
    );
  });
}

export function UserMessage({ entry }: { entry: UserEntry }) {
  return (
    <div className="bg-secondary/50 text-foreground rounded-sm px-2.5 py-1.5 text-sm">
      {renderInline(entry.text)}
    </div>
  );
}

export function AssistantMessage({
  entry,
  speechStatus,
  speechError,
  onSpeak,
  onStop,
}: {
  entry: AssistantEntry;
  speechStatus: "idle" | "loading" | "speaking" | "error";
  speechError: string | null;
  onSpeak: (messageId: string, text: string) => void;
  onStop: () => void;
}) {
  const active = speechStatus === "loading" || speechStatus === "speaking";

  return (
    <div className="text-secondary-foreground px-0.5 text-sm leading-relaxed">
      <div>
        {entry.streaming ? (
          <>
            {renderInline(entry.text)}
            <span
              className={cn(
                "text-chart-2 ml-0.5 inline-block animate-pulse",
                "align-baseline",
              )}
              aria-hidden="true"
            >
              ▍
            </span>
          </>
        ) : (
          <Markdown text={entry.text} />
        )}
      </div>
      {!entry.streaming && (
        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={active ? onStop : () => onSpeak(entry.id, entry.text)}
            aria-label={active ? "Stop" : "Read"}
            title={active ? "Stop" : "Read"}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground flex h-6 items-center gap-1 rounded-sm px-1.5 text-xs transition-colors",
              active && "bg-chart-2/10 text-chart-2",
            )}
          >
            {speechStatus === "loading" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : active ? (
              <Square className="size-2.5 fill-current" />
            ) : (
              <Volume2 className="size-3" />
            )}
            <span>{active ? "Stop" : "Read"}</span>
          </button>
          {speechStatus === "error" && speechError && (
            <span className="text-destructive text-xs">{speechError}</span>
          )}
        </div>
      )}
    </div>
  );
}
