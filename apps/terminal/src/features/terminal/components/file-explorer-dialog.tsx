"use client";

/**
 * FileExplorerDialog — browse and manage the filesystem of the server the
 * selected terminal lives on (`/api/sessions/:id/fs/*`). Opened from the
 * "Browse files" button beside the header title.
 *
 * Two panes on desktop (directory list left, file preview/detail right); a
 * single column on mobile that swaps to the preview when a file is selected.
 * Full read/write: list, text preview, download (incl. binaries), upload,
 * mkdir, rename/move, delete (with a strong confirm; recursive delete is an
 * explicit second opt-in).
 *
 * Styling mirrors settings-dialog.tsx / add-server-dialog.tsx: DESIGN.md theme
 * tokens only (no hardcoded hex), lucide-react icons at size-3.5/size-4,
 * @sparklab/ui primitives. The current directory is local component state
 * seeded from the list response (§4a of docs/FILE-EXPLORER-PLAN.md).
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@sparklab/ui/components/ui/alert-dialog";
import { Button } from "@sparklab/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@sparklab/ui/components/ui/dialog";
import { Input } from "@sparklab/ui/components/ui/input";
import { Label } from "@sparklab/ui/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@sparklab/ui/components/ui/tooltip";
import { cn } from "@sparklab/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  CornerLeftUp,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FileSymlink,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { FileConflictView } from "./file-conflict-view";
import { FileEditor } from "./file-editor";
import {
  basename,
  dirname,
  downloadFsFile,
  fetchFsReadOnce,
  fsErrorMessage,
  FsError,
  joinPath,
  useFsDelete,
  FsConflictError,
  fsKeys,
  useFsGitBase,
  useFsList,
  useFsMkdir,
  useFsRead,
  useFsRename,
  useFsStat,
  useFsUpload,
  useFsWrite,
} from "../hooks/use-file-explorer";
import { useMediaQuery } from "../hooks/use-media-query";

import type { FsEntry } from "@sparklab/shared-types";

// Desktop pane split (list pane width, as a % of the two-pane container).
const DEFAULT_LIST_PCT = 58;
const MIN_PANE_PCT = 25;
const MAX_PANE_PCT = 75;

type PendingDiscardAction =
  | { type: "discard" }
  | { type: "select"; entry: FsEntry }
  | { type: "navigate"; path: string }
  | { type: "back" }
  | { type: "close" };

type FileConflict = {
  source: "save" | "external";
  exists: boolean;
  currentMtime?: number | null;
  currentSize?: number;
  pendingWrite?: {
    path: string;
    content: string;
    baseMtime: number | null;
  };
};

// ---- Formatting helpers ----

function formatSize(entry: FsEntry): string {
  if (entry.type === "dir") return "—";
  const bytes = entry.size;
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[i]}`;
}

function formatMtime(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Dirs first, then case-insensitive by name. */
function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === "dir";
    const bDir = b.type === "dir";
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function EntryIcon({ type }: { type: FsEntry["type"] }) {
  if (type === "dir")
    return <Folder className="text-chart-2 size-4 shrink-0" />;
  if (type === "symlink")
    return <FileSymlink className="text-muted-foreground size-4 shrink-0" />;
  return <FileIcon className="text-muted-foreground size-4 shrink-0" />;
}

// ---- Component ----

export function FileExplorerDialog({
  open,
  onOpenChange,
  sessionId,
  serverName,
  unreachable = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  serverName?: string;
  unreachable?: boolean;
}) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const sid = sessionId ?? "";
  const queryClient = useQueryClient();

  // Current directory: seeded from the first list response (null => "resolve
  // the session cwd"). Reset whenever the dialog (re)opens or the session
  // changes so it always re-seeds the cwd.
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [draftContent, setDraftContent] = useState<string | null>(null);
  const [editorContentOverride, setEditorContentOverride] = useState<
    string | null
  >(null);
  const [loadedMtime, setLoadedMtime] = useState<number | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const [conflict, setConflict] = useState<FileConflict | null>(null);
  const [diffViewOpen, setDiffViewOpen] = useState(false);
  const [diffRemoteContent, setDiffRemoteContent] = useState<string | null>(
    null,
  );
  const [diffUnavailable, setDiffUnavailable] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState(false);
  const [pendingDiscardAction, setPendingDiscardAction] =
    useState<PendingDiscardAction | null>(null);

  // Write-op dialogs.
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [overwriteRename, setOverwriteRename] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null);
  const [recursiveTarget, setRecursiveTarget] = useState<FsEntry | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const paneContainerRef = useRef<HTMLDivElement>(null);
  const lastHandledStatUpdateRef = useRef(0);
  const dismissedExternalVersionRef = useRef<string | null>(null);
  const diffFetchIdRef = useRef(0);
  const [listWidthPct, setListWidthPct] = useState(DEFAULT_LIST_PCT);

  const listQuery = useFsList(
    sessionId,
    currentPath,
    showHidden,
    open && !unreachable,
  );
  const readQuery = useFsRead(sessionId, previewPath);
  const isEditablePreview = Boolean(
    previewPath &&
    readQuery.data &&
    !readQuery.data.binary &&
    !readQuery.data.truncated,
  );
  const gitBaseQuery = useFsGitBase(sessionId, previewPath, {
    enabled: isEditablePreview,
  });
  const statQuery = useFsStat(sessionId, previewPath, {
    enabled: open && isEditablePreview,
  });

  const mkdir = useFsMkdir(sid);
  const rename = useFsRename(sid);
  const remove = useFsDelete(sid);
  const upload = useFsUpload(sid);
  const write = useFsWrite(sid);

  // Reset local state when the dialog opens or the session changes.
  useEffect(() => {
    if (open) {
      setCurrentPath(null);
      setSelected(null);
      setPreviewPath(null);
      setDraftContent(null);
      setEditorContentOverride(null);
      setLoadedMtime(null);
      setResetToken(0);
      setConflict(null);
      setDiffViewOpen(false);
      setDiffRemoteContent(null);
      setDiffUnavailable(null);
      setDiffLoading(false);
      lastHandledStatUpdateRef.current = 0;
      dismissedExternalVersionRef.current = null;
      diffFetchIdRef.current += 1;
      setPendingDiscard(false);
      setPendingDiscardAction(null);
      setOpError(null);
    }
  }, [open, sessionId]);

  useEffect(() => {
    if (readQuery.data?.path === previewPath) {
      setLoadedMtime(readQuery.data.mtime);
    }
  }, [previewPath, readQuery.data]);

  useEffect(() => {
    const stat = statQuery.data;
    if (
      !stat ||
      stat.path !== previewPath ||
      loadedMtime === null ||
      statQuery.dataUpdatedAt === lastHandledStatUpdateRef.current
    )
      return;

    lastHandledStatUpdateRef.current = statQuery.dataUpdatedAt;
    const changed = !stat.exists || stat.mtime !== loadedMtime;
    if (!changed) return;

    const version = stat.exists
      ? `${stat.path}:true:${String(stat.mtime)}:${String(stat.size)}`
      : `${stat.path}:false`;
    if (dismissedExternalVersionRef.current === version) return;

    setConflict((current) => {
      if (current?.source === "save") return current;
      return {
        source: "external",
        exists: stat.exists,
        ...(stat.exists
          ? { currentMtime: stat.mtime, currentSize: stat.size }
          : {}),
      };
    });
  }, [loadedMtime, previewPath, statQuery.data, statQuery.dataUpdatedAt]);

  // Seed the current directory from the first successful listing. Must
  // ignore placeholder data (keepPreviousData carries the last-viewed
  // directory across close/reopen) — otherwise the dialog reseeds to
  // whatever was last browsed instead of the terminal's live cwd, since the
  // placeholder is available synchronously before the fresh cwd resolution
  // (which re-queries tmux) has a chance to land.
  useEffect(() => {
    if (
      listQuery.data &&
      !listQuery.isPlaceholderData &&
      currentPath === null
    ) {
      setCurrentPath(listQuery.data.path);
    }
  }, [listQuery.data, listQuery.isPlaceholderData, currentPath]);

  const canWrite = currentPath != null && !unreachable;
  const isDirty =
    draftContent !== null && draftContent !== readQuery.data?.content;

  const clearPreviewEditState = () => {
    setDraftContent(null);
    setEditorContentOverride(null);
    setLoadedMtime(null);
    setConflict(null);
    setDiffViewOpen(false);
    setDiffRemoteContent(null);
    setDiffUnavailable(null);
    setDiffLoading(false);
    lastHandledStatUpdateRef.current = 0;
    dismissedExternalVersionRef.current = null;
    diffFetchIdRef.current += 1;
  };

  // ---- Navigation ----
  const performNavigateTo = (path: string) => {
    setCurrentPath(path);
    setSelected(null);
    setPreviewPath(null);
    clearPreviewEditState();
    setOpError(null);
  };

  const performSelectEntry = (entry: FsEntry) => {
    setSelected(entry.name);
    const full = joinPath(currentPath ?? "/", entry.name);
    const nextPreviewPath = entry.type === "dir" ? null : full;
    if (nextPreviewPath !== previewPath) clearPreviewEditState();
    // Files (and symlinks/other, which the read endpoint resolves) preview;
    // directories only highlight until double-clicked.
    setPreviewPath(nextPreviewPath);
  };

  const requestDiscard = (action: PendingDiscardAction) => {
    setPendingDiscardAction(action);
    setPendingDiscard(true);
  };

  const navigateTo = (path: string) => {
    if (isDirty) {
      requestDiscard({ type: "navigate", path });
      return;
    }
    performNavigateTo(path);
  };

  const openEntry = (entry: FsEntry) => {
    const full = joinPath(currentPath ?? "/", entry.name);
    if (entry.type === "dir") navigateTo(full);
  };

  const selectEntry = (entry: FsEntry) => {
    const full = joinPath(currentPath ?? "/", entry.name);
    const nextPreviewPath = entry.type === "dir" ? null : full;
    if (isDirty && nextPreviewPath !== previewPath) {
      requestDiscard({ type: "select", entry });
      return;
    }
    performSelectEntry(entry);
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isDirty) {
      requestDiscard({ type: "close" });
      return;
    }
    onOpenChange(nextOpen);
  };

  const handleMobileBack = () => {
    if (isDirty) {
      requestDiscard({ type: "back" });
      return;
    }
    setPreviewPath(null);
    setSelected(null);
    clearPreviewEditState();
  };

  const confirmDiscard = () => {
    const action = pendingDiscardAction;
    setDraftContent(null);
    setEditorContentOverride(null);
    setConflict(null);
    setDiffViewOpen(false);
    setDiffRemoteContent(null);
    setDiffUnavailable(null);
    diffFetchIdRef.current += 1;
    setResetToken((token) => token + 1);
    setPendingDiscard(false);
    setPendingDiscardAction(null);

    if (action?.type === "select") performSelectEntry(action.entry);
    if (action?.type === "navigate") performNavigateTo(action.path);
    if (action?.type === "back") {
      setPreviewPath(null);
      setSelected(null);
      setLoadedMtime(null);
    }
    if (action?.type === "close") onOpenChange(false);
  };

  const handleSave = () => {
    if (
      !previewPath ||
      !readQuery.data ||
      !isEditablePreview ||
      write.isPending
    )
      return;
    const path = previewPath;
    const content = draftContent ?? readQuery.data.content ?? "";
    const pendingWrite = { path, content, baseMtime: loadedMtime };
    setOpError(null);
    setConflict(null);
    write.mutate(
      {
        ...pendingWrite,
        force: false,
      },
      {
        onSuccess: (response) => {
          setDraftContent(null);
          setEditorContentOverride(null);
          setConflict(null);
          setDiffViewOpen(false);
          setDiffRemoteContent(null);
          setDiffUnavailable(null);
          diffFetchIdRef.current += 1;
          lastHandledStatUpdateRef.current = statQuery.dataUpdatedAt;
          setLoadedMtime(response.mtime);
          void queryClient.invalidateQueries({
            queryKey: fsKeys.read(sid, path),
          });
        },
        onError: (error) => {
          if (error instanceof FsConflictError) {
            setConflict({
              source: "save",
              exists: error.exists,
              pendingWrite,
              ...(error.currentMtime !== undefined
                ? { currentMtime: error.currentMtime }
                : {}),
              ...(error.currentSize !== undefined
                ? { currentSize: error.currentSize }
                : {}),
            });
          } else {
            setOpError(fsErrorMessage(error));
          }
        },
      },
    );
  };

  const handleConflictReload = async () => {
    const result = await readQuery.refetch();
    if (result.isSuccess && result.data) {
      setLoadedMtime(result.data.mtime);
      setDraftContent(null);
      setEditorContentOverride(null);
      setConflict(null);
      setDiffViewOpen(false);
      setDiffRemoteContent(null);
      setDiffUnavailable(null);
      diffFetchIdRef.current += 1;
      dismissedExternalVersionRef.current = null;
      setResetToken((token) => token + 1);
      setOpError(null);
    } else if (result.error) {
      setOpError(fsErrorMessage(result.error));
    }
  };

  const handleViewDiff = async () => {
    if (!previewPath || !sessionId) return;
    const requestId = diffFetchIdRef.current + 1;
    diffFetchIdRef.current = requestId;
    setDiffViewOpen(true);
    setDiffRemoteContent(null);
    setDiffUnavailable(null);
    setDiffLoading(true);

    try {
      const remote = await fetchFsReadOnce(sessionId, previewPath);
      if (diffFetchIdRef.current !== requestId) return;
      if (remote.binary) {
        setDiffUnavailable("Diff unavailable — the on-disk file is binary.");
      } else if (remote.truncated) {
        setDiffUnavailable(
          "Diff unavailable — the on-disk file is larger than the preview limit.",
        );
      } else {
        setDiffRemoteContent(remote.content ?? "");
      }
    } catch (error) {
      if (diffFetchIdRef.current === requestId) {
        setDiffUnavailable(`Diff unavailable — ${fsErrorMessage(error)}.`);
      }
    } finally {
      if (diffFetchIdRef.current === requestId) setDiffLoading(false);
    }
  };

  const closeDiffView = () => {
    setEditorContentOverride(draftContent ?? readQuery.data?.content ?? "");
    setDiffViewOpen(false);
  };

  const dismissConflict = () => {
    if (conflict && previewPath) {
      dismissedExternalVersionRef.current = conflict.exists
        ? `${previewPath}:true:${String(conflict.currentMtime)}:${String(conflict.currentSize)}`
        : `${previewPath}:false`;
    }
    setEditorContentOverride(draftContent ?? readQuery.data?.content ?? "");
    setConflict(null);
    setDiffViewOpen(false);
    setDiffRemoteContent(null);
    setDiffUnavailable(null);
    diffFetchIdRef.current += 1;
  };

  const handleOverwriteConflict = () => {
    if (conflict?.source !== "save" || !conflict.pendingWrite) return;
    const pendingWrite = conflict.pendingWrite;
    setOpError(null);
    write.mutate(
      {
        ...pendingWrite,
        content: draftContent ?? readQuery.data?.content ?? "",
        force: true,
      },
      {
        onSuccess: (response) => {
          setDraftContent(null);
          setEditorContentOverride(null);
          setLoadedMtime(response.mtime);
          setConflict(null);
          setDiffViewOpen(false);
          setDiffRemoteContent(null);
          setDiffUnavailable(null);
          diffFetchIdRef.current += 1;
          lastHandledStatUpdateRef.current = statQuery.dataUpdatedAt;
          void queryClient.invalidateQueries({
            queryKey: fsKeys.read(sid, pendingWrite.path),
          });
        },
        onError: (error) => setOpError(fsErrorMessage(error)),
      },
    );
  };

  // ---- Write ops ----
  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name || currentPath == null) return;
    setOpError(null);
    mkdir.mutate(
      { path: joinPath(currentPath, name) },
      {
        onSuccess: () => {
          setNewFolderOpen(false);
          setNewFolderName("");
        },
        onError: (err) => setOpError(fsErrorMessage(err)),
      },
    );
  };

  const submitRename = () => {
    if (!renameTarget || currentPath == null) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const from = joinPath(currentPath, renameTarget.name);
    const to = joinPath(currentPath, name);
    setOpError(null);
    rename.mutate(
      { from, to },
      {
        onSuccess: () => setRenameTarget(null),
        onError: (err) => {
          if (err instanceof FsError && err.status === 409) {
            setRenameTarget(null);
            setOverwriteRename({ from, to });
          } else {
            setOpError(fsErrorMessage(err));
          }
        },
      },
    );
  };

  const confirmOverwriteRename = () => {
    if (!overwriteRename) return;
    rename.mutate(
      { ...overwriteRename, overwrite: true },
      {
        onSettled: () => setOverwriteRename(null),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleteTarget || currentPath == null) return;
    const target = deleteTarget;
    const path = joinPath(currentPath, target.name);
    remove.mutate(
      { path, recursive: false },
      {
        onSuccess: () => {
          setDeleteTarget(null);
          if (selected === target.name) {
            setSelected(null);
            setPreviewPath(null);
          }
        },
        onError: (err) => {
          setDeleteTarget(null);
          // Non-empty directory: escalate to an explicit recursive confirm.
          if (
            err instanceof FsError &&
            err.status === 409 &&
            target.type === "dir"
          ) {
            setRecursiveTarget(target);
          } else {
            setOpError(fsErrorMessage(err));
          }
        },
      },
    );
  };

  const confirmRecursiveDelete = () => {
    if (!recursiveTarget || currentPath == null) return;
    const target = recursiveTarget;
    const path = joinPath(currentPath, target.name);
    remove.mutate(
      { path, recursive: true },
      {
        onSettled: () => setRecursiveTarget(null),
        onSuccess: () => {
          if (selected === target.name) {
            setSelected(null);
            setPreviewPath(null);
          }
        },
        onError: (err) => setOpError(fsErrorMessage(err)),
      },
    );
  };

  const onUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file || currentPath == null) return;
    setOpError(null);
    upload.mutate(
      { destPath: joinPath(currentPath, file.name), file },
      { onError: (err) => setOpError(fsErrorMessage(err)) },
    );
  };

  // ---- Derived view state ----
  const displayPath = currentPath ?? listQuery.data?.path ?? "";
  const segments = displayPath ? displayPath.split("/").filter(Boolean) : [];
  const crumbs = [
    { label: "/", path: "/" },
    ...segments.map((seg, i) => ({
      label: seg,
      path: `/${segments.slice(0, i + 1).join("/")}`,
    })),
  ];

  const entries = listQuery.data ? sortEntries(listQuery.data.entries) : [];
  const showListPane = !isMobile || previewPath == null;
  const showPreviewPane = !isMobile || previewPath != null;
  const gitBaseContent =
    gitBaseQuery.data?.isRepo === true &&
    gitBaseQuery.data.tracked === true &&
    "content" in gitBaseQuery.data
      ? gitBaseQuery.data.content
      : null;
  const language = previewPath
    ? basename(previewPath).match(/\.([^.]+)$/)?.[1]
    : undefined;
  const canRefreshDiff =
    isEditablePreview &&
    !gitBaseQuery.isFetching &&
    (gitBaseContent !== null || gitBaseQuery.isFetched);

  // Drag the divider to resize the list vs. preview panes (desktop only).
  // Tracks the pointer's X within the pane container and sets the list pane's
  // width %, clamped so neither pane can collapse. Listeners live on the window
  // for the duration of the drag so it keeps tracking outside the thin handle.
  const startPaneResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = paneContainerRef.current;
    if (!container) return;
    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setListWidthPct(Math.min(MAX_PANE_PCT, Math.max(MIN_PANE_PCT, pct)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="flex h-[min(90dvh,860px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="border-border gap-1.5 border-b px-4 py-3 text-left">
          <div className="flex items-center gap-2">
            <HardDrive className="text-muted-foreground size-4 shrink-0" />
            <DialogTitle className="text-sm font-medium">Files</DialogTitle>
            {serverName && (
              <span className="text-muted-foreground truncate text-xs">
                {serverName}
              </span>
            )}
          </div>
          <DialogDescription className="sr-only">
            Browse, upload, download, rename, and delete files on the server
            this session runs on.
          </DialogDescription>

          {/* Breadcrumb + toolbar */}
          <div className="mt-1 flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  aria-label="Up one directory"
                  disabled={
                    displayPath === "/" || displayPath === "" || unreachable
                  }
                  onClick={() => navigateTo(dirname(displayPath))}
                >
                  <CornerLeftUp className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Up one directory</TooltipContent>
            </Tooltip>

            <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex shrink-0 items-center">
                  {i > 0 && (
                    <ChevronRight className="text-muted-foreground size-3 shrink-0" />
                  )}
                  <button
                    type="button"
                    className={cn(
                      "hover:bg-accent max-w-[12rem] truncate rounded px-1 py-0.5 transition-colors",
                      i === crumbs.length - 1
                        ? "text-foreground font-medium"
                        : "text-muted-foreground",
                    )}
                    onClick={() => navigateTo(c.path)}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </nav>

            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={
                      showHidden ? "Hide hidden files" : "Show hidden files"
                    }
                    aria-pressed={showHidden}
                    onClick={() => setShowHidden((v) => !v)}
                  >
                    {showHidden ? (
                      <Eye className="size-3.5" />
                    ) : (
                      <EyeOff className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {showHidden ? "Hide hidden files" : "Show hidden files"}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="New folder"
                    disabled={!canWrite}
                    onClick={() => {
                      setNewFolderName("");
                      setOpError(null);
                      setNewFolderOpen(true);
                    }}
                  >
                    <FolderPlus className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New folder</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Upload file"
                    disabled={!canWrite || upload.isPending}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {upload.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Upload className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Upload file (max 1 GB)</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Refresh"
                    disabled={unreachable}
                    onClick={() => void listQuery.refetch()}
                  >
                    <RefreshCw
                      className={cn(
                        "size-3.5",
                        listQuery.isFetching && "animate-spin",
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {upload.isPending && (
            <div className="mt-1 flex items-center gap-2">
              <div
                role="progressbar"
                aria-label="Upload progress"
                aria-valuenow={upload.progress ?? 0}
                aria-valuemin={0}
                aria-valuemax={100}
                className="bg-accent h-1 flex-1 overflow-hidden rounded-full"
              >
                <div
                  className="bg-primary h-full rounded-full transition-[width]"
                  style={{ width: `${upload.progress ?? 0}%` }}
                />
              </div>
              <span className="text-muted-foreground w-9 shrink-0 text-right text-xs tabular-nums">
                {upload.progress ?? 0}%
              </span>
            </div>
          )}

          {opError && (
            <p className="text-destructive mt-1 text-xs">{opError}</p>
          )}
        </DialogHeader>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onUploadChange}
        />

        <div ref={paneContainerRef} className="flex min-h-0 flex-1">
          {/* Directory list */}
          {showListPane && (
            <div
              className={cn(
                "@container flex min-w-0 flex-col overflow-hidden",
                isMobile || !showPreviewPane ? "flex-1" : "",
              )}
              style={
                !isMobile && showPreviewPane
                  ? { width: `${listWidthPct}%` }
                  : undefined
              }
            >
              <div className="[&::-webkit-scrollbar-thumb]:bg-border flex-1 overflow-y-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar]:w-1.5">
                {!sessionId ? (
                  <p className="text-muted-foreground p-4 text-sm">
                    No session selected.
                  </p>
                ) : unreachable ? (
                  <p className="text-muted-foreground p-4 text-sm">
                    Server unavailable — reconnect to browse files.
                  </p>
                ) : listQuery.isLoading ? (
                  <div className="space-y-1 p-2">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <div
                        key={i}
                        className="bg-muted-foreground/10 h-7 animate-pulse rounded"
                      />
                    ))}
                  </div>
                ) : listQuery.isError ? (
                  <div className="flex flex-col items-start gap-2 p-4">
                    <p className="text-muted-foreground text-sm">
                      {fsErrorMessage(listQuery.error)}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void listQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : entries.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-sm">
                    This folder is empty.
                  </p>
                ) : (
                  <ul className="py-1">
                    {entries.map((entry) => {
                      const isSel = selected === entry.name;
                      return (
                        <li key={entry.name}>
                          <div
                            className={cn(
                              "group flex cursor-default items-center gap-2 px-3 py-1 text-sm",
                              isSel ? "bg-accent" : "hover:bg-accent/50",
                            )}
                            onClick={() => selectEntry(entry)}
                            onDoubleClick={() => openEntry(entry)}
                          >
                            <EntryIcon type={entry.type} />
                            <span className="text-foreground min-w-0 flex-1 truncate">
                              {entry.name}
                              {entry.type === "symlink" &&
                                entry.symlinkTarget && (
                                  <span className="text-muted-foreground">
                                    {" → "}
                                    {entry.symlinkTarget}
                                  </span>
                                )}
                            </span>

                            {/* Per-row actions (hover or selected). */}
                            <span
                              className={cn(
                                "flex shrink-0 items-center gap-0.5",
                                isSel
                                  ? "opacity-100"
                                  : "opacity-0 group-hover:opacity-100",
                              )}
                            >
                              {entry.type !== "dir" && (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors"
                                  title="Download"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    downloadFsFile(
                                      sid,
                                      joinPath(currentPath ?? "/", entry.name),
                                    );
                                  }}
                                >
                                  <Download className="size-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground rounded-sm p-1 transition-colors"
                                title="Rename"
                                disabled={!canWrite}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setRenameValue(entry.name);
                                  setOpError(null);
                                  setRenameTarget(entry);
                                }}
                              >
                                <Pencil className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-destructive rounded-sm p-1 transition-colors"
                                title="Delete"
                                disabled={!canWrite}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpError(null);
                                  setDeleteTarget(entry);
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </span>

                            <span className="text-muted-foreground @sm:inline hidden w-16 shrink-0 text-right text-xs tabular-nums">
                              {formatSize(entry)}
                            </span>
                            <span className="text-muted-foreground @lg:inline hidden w-36 shrink-0 text-right text-xs tabular-nums">
                              {formatMtime(entry.mtime)}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {listQuery.data?.truncated && (
                <p className="border-border text-muted-foreground border-t px-3 py-1.5 text-xs">
                  Showing the first {entries.length} entries — this folder has
                  more.
                </p>
              )}
            </div>
          )}

          {/* Draggable divider: resize the list vs. preview panes (desktop). */}
          {!isMobile && showListPane && showPreviewPane && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file list"
              tabIndex={0}
              onPointerDown={startPaneResize}
              onDoubleClick={() => setListWidthPct(DEFAULT_LIST_PCT)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft")
                  setListWidthPct((p) => Math.max(MIN_PANE_PCT, p - 3));
                if (e.key === "ArrowRight")
                  setListWidthPct((p) => Math.min(MAX_PANE_PCT, p + 3));
              }}
              className="bg-border hover:bg-foreground/30 focus-visible:bg-foreground/40 w-1 shrink-0 cursor-col-resize transition-colors focus:outline-none"
            />
          )}

          {/* Preview / detail pane */}
          {showPreviewPane && (
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {isMobile && previewPath && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground border-border flex items-center gap-1.5 border-b px-3 py-2 text-xs"
                  onClick={handleMobileBack}
                >
                  <ArrowLeft className="size-3.5" />
                  Back to files
                </button>
              )}

              {!previewPath ? (
                <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-center text-xs">
                  Select a file to preview.
                </div>
              ) : readQuery.isLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="text-muted-foreground size-5 animate-spin" />
                </div>
              ) : readQuery.isError ? (
                <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-center text-xs">
                  {fsErrorMessage(readQuery.error)}
                </div>
              ) : readQuery.data ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
                    <span className="text-foreground flex min-w-0 items-center gap-1.5 truncate text-xs font-medium">
                      <span className="truncate">
                        {basename(readQuery.data.path)}
                      </span>
                      {isEditablePreview && isDirty && (
                        <span
                          className="bg-chart-2 size-1.5 shrink-0 rounded-full"
                          aria-label="Unsaved changes"
                        />
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      {isEditablePreview && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={!isDirty || write.isPending}
                            onClick={handleSave}
                          >
                            {write.isPending && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            Save
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={!isDirty}
                            onClick={() => requestDiscard({ type: "discard" })}
                          >
                            Discard
                          </Button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7"
                                aria-label="Refresh diff"
                                disabled={!canRefreshDiff}
                                onClick={() => void gitBaseQuery.refetch()}
                              >
                                <RefreshCw
                                  className={cn(
                                    "size-3.5",
                                    gitBaseQuery.isFetching && "animate-spin",
                                  )}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Refresh diff</TooltipContent>
                          </Tooltip>
                        </>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0"
                        onClick={() =>
                          downloadFsFile(sid, readQuery.data!.path)
                        }
                      >
                        <Download className="size-3.5" />
                        Download
                      </Button>
                    </div>
                  </div>

                  {isEditablePreview && conflict && (
                    <div className="border-border bg-muted-foreground/5 flex items-center justify-between gap-3 border-b px-3 py-1.5">
                      <p className="text-muted-foreground text-xs">
                        This file changed on disk since you opened it.
                      </p>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          disabled={diffLoading}
                          onClick={() => void handleViewDiff()}
                        >
                          {diffLoading && (
                            <Loader2 className="size-3.5 animate-spin" />
                          )}
                          View diff
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7"
                          disabled={readQuery.isFetching}
                          onClick={() => void handleConflictReload()}
                        >
                          {readQuery.isFetching && (
                            <Loader2 className="size-3.5 animate-spin" />
                          )}
                          Reload
                        </Button>
                        {conflict.source === "save" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7"
                            disabled={write.isPending}
                            onClick={handleOverwriteConflict}
                          >
                            {write.isPending && (
                              <Loader2 className="size-3.5 animate-spin" />
                            )}
                            Overwrite anyway
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Dismiss conflict"
                          onClick={dismissConflict}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}

                  {readQuery.data.binary ? (
                    <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-center text-xs">
                      Binary file — preview unavailable.
                    </div>
                  ) : readQuery.data.truncated ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <p className="text-muted-foreground bg-muted-foreground/5 border-border border-b px-3 py-1.5 text-xs">
                        Preview truncated to the first 256 KB.
                      </p>
                      <pre className="text-foreground [&::-webkit-scrollbar-thumb]:bg-border flex-1 overflow-auto whitespace-pre px-3 py-2 font-mono text-xs [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar]:w-1.5">
                        {readQuery.data.content ?? ""}
                      </pre>
                    </div>
                  ) : diffViewOpen ? (
                    diffRemoteContent !== null ? (
                      <FileConflictView
                        local={draftContent ?? readQuery.data?.content ?? ""}
                        remote={diffRemoteContent ?? ""}
                        onClose={closeDiffView}
                      />
                    ) : (
                      <div className="text-muted-foreground flex flex-1 items-center justify-center p-4 text-center text-xs">
                        {diffLoading ? (
                          <Loader2 className="size-5 animate-spin" />
                        ) : (
                          (diffUnavailable ?? "Diff unavailable.")
                        )}
                      </div>
                    )
                  ) : (
                    <FileEditor
                      key={`${previewPath}-${loadedMtime}-${resetToken}`}
                      content={editorContentOverride ?? readQuery.data.content!}
                      gitBaseContent={gitBaseContent}
                      readOnly={false}
                      language={language}
                      onChange={(next) => setDraftContent(next)}
                      onSave={handleSave}
                    />
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </DialogContent>

      {/* New folder */}
      <Dialog
        open={newFolderOpen}
        onOpenChange={(o) => {
          if (!o && !mkdir.isPending) setNewFolderOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder in {displayPath || "the current directory"}.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitNewFolder();
            }}
          >
            <div className="space-y-1.5">
              <Label
                htmlFor="fs-new-folder"
                className="text-muted-foreground text-xs"
              >
                Folder name
              </Label>
              <Input
                id="fs-new-folder"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="my-folder"
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              {opError && <p className="text-destructive text-xs">{opError}</p>}
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewFolderOpen(false)}
                disabled={mkdir.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={newFolderName.trim() === "" || mkdir.isPending}
              >
                {mkdir.isPending && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                {mkdir.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog
        open={!!renameTarget}
        onOpenChange={(o) => {
          if (!o && !rename.isPending) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>
              Rename “{renameTarget?.name}”.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <div className="space-y-1.5">
              <Label
                htmlFor="fs-rename"
                className="text-muted-foreground text-xs"
              >
                New name
              </Label>
              <Input
                id="fs-rename"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              {opError && <p className="text-destructive text-xs">{opError}</p>}
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameTarget(null)}
                disabled={rename.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={renameValue.trim() === "" || rename.isPending}
              >
                {rename.isPending && (
                  <Loader2 className="size-3.5 animate-spin" />
                )}
                {rename.isPending ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename overwrite confirm (409) */}
      <AlertDialog
        open={!!overwriteRename}
        onOpenChange={(o) => {
          if (!o && !rename.isPending) setOverwriteRename(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite existing file?</AlertDialogTitle>
            <AlertDialogDescription>
              {overwriteRename ? basename(overwriteRename.to) : ""} already
              exists. Overwriting replaces it permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setOverwriteRename(null)}
              disabled={rename.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={rename.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmOverwriteRename();
              }}
            >
              {rename.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Overwrite
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unsaved changes confirm */}
      <AlertDialog
        open={pendingDiscard}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setPendingDiscard(false);
            setPendingDiscardAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to this file will be permanently lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingDiscard(false);
                setPendingDiscardAction(null);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                confirmDiscard();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o && !remove.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleteTarget?.type === "dir" ? "folder" : "file"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete “{deleteTarget?.name}”? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setDeleteTarget(null)}
              disabled={remove.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {remove.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Recursive delete confirm (non-empty dir, 409) */}
      <AlertDialog
        open={!!recursiveTarget}
        onOpenChange={(o) => {
          if (!o && !remove.isPending) setRecursiveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Folder is not empty</AlertDialogTitle>
            <AlertDialogDescription>
              “{recursiveTarget?.name}” contains other files and folders. Delete
              it and everything inside it? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setRecursiveTarget(null)}
              disabled={remove.isPending}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={remove.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirmRecursiveDelete();
              }}
            >
              {remove.isPending && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              Delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
