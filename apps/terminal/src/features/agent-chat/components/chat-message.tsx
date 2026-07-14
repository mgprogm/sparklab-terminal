"use client";

/**
 * User and assistant message rows. User = a quiet full-width block; assistant =
 * plain prose with a streaming block cursor. Minimal inline formatting only
 * (backtick code + line breaks) — no markdown dependency.
 */
import { Fragment } from "react";
import { cn } from "@sparklab/ui/lib/utils";
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

export function AssistantMessage({ entry }: { entry: AssistantEntry }) {
  return (
    <div className="text-secondary-foreground px-0.5 text-sm leading-relaxed">
      {renderInline(entry.text)}
      {entry.streaming && (
        <span
          className={cn(
            "text-chart-2 ml-0.5 inline-block animate-pulse",
            "align-baseline",
          )}
          aria-hidden="true"
        >
          ▍
        </span>
      )}
    </div>
  );
}
