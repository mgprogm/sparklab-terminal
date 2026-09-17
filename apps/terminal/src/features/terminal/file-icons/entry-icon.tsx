"use client";

/**
 * EntryIcon — the glyph for one File Explorer directory entry.
 *
 * Which set an entry draws from depends on what the entry IS:
 *
 *   - `file` / `dir` are file TYPES, so they get the vscode-icons glyph
 *   - `symlink` and `other` are entry KINDS, so they keep their lucide glyph.
 *     A symlink's own name says nothing about what it points at (which may not
 *     even exist) and the row already renders `→ target` beside it; `other`
 *     covers sockets, FIFOs and devices, which have no file type at all.
 *
 * `theme` is the Appearance setting. "plain" restores the original
 * single-colour lucide pair for anyone who finds the colour noisy — under it
 * this component renders exactly what it did before the icon set landed. The
 * caller reads the theme ONCE and passes it down: a listing can hold thousands
 * of rows, and a store subscription per row would be wasteful.
 */

import { File as FileIcon, FileSymlink, Folder } from "lucide-react";

import { FileTypeIcon } from "./file-type-icon";

import type { FileIconTheme } from "../store";
import type { FsEntry } from "@sparklab/shared-types";

export function EntryIcon({
  type,
  name,
  theme,
}: {
  type: FsEntry["type"];
  name: string;
  theme: FileIconTheme;
}) {
  if (type === "symlink")
    return <FileSymlink className="text-muted-foreground size-4 shrink-0" />;
  if (type === "other")
    return <FileIcon className="text-muted-foreground size-4 shrink-0" />;

  if (theme === "plain") {
    return type === "dir" ? (
      <Folder className="text-chart-2 size-4 shrink-0" />
    ) : (
      <FileIcon className="text-muted-foreground size-4 shrink-0" />
    );
  }

  return <FileTypeIcon name={name} kind={type === "dir" ? "dir" : "file"} />;
}
