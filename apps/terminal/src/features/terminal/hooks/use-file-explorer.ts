/**
 * Data layer for the File Explorer modal (`/api/sessions/:id/fs/*`).
 *
 * Mirrors use-servers.ts: every fetch parses the response with the shared Zod
 * schema at the boundary, throws `UnauthorizedError` on 401, and otherwise
 * throws a typed `FsError` carrying the HTTP status so the UI can distinguish
 * 403 / 404 / 409 / 413 / unreachable. All paths are absolute; the qualified
 * session id and every `path` query value are URL-encoded.
 *
 * The listing is NOT polled (fs isn't a live stream) — the modal offers a
 * manual Refresh instead. Mutations invalidate the current session's list
 * queries so the visible directory refreshes after a write.
 */
import {
  type FsDeleteResponse,
  FsDeleteResponseSchema,
  type FsGitBaseResponse,
  FsGitBaseResponseSchema,
  type FsListResponse,
  FsListResponseSchema,
  type FsMkdirRequest,
  type FsMkdirResponse,
  FsMkdirResponseSchema,
  type FsReadResponse,
  FsReadResponseSchema,
  type FsRenameRequest,
  type FsRenameResponse,
  FsRenameResponseSchema,
  type FsStatResponse,
  FsStatResponseSchema,
  type FsUploadResponse,
  FsUploadResponseSchema,
  type FsWriteResponse,
  FsWriteResponseSchema,
} from "@sparklab/shared-types";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import { UnauthorizedError } from "@/features/auth/api";

// ---- Errors ----

/** Carries the HTTP status so the modal can map it to a friendly message. */
export class FsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "FsError";
    this.status = status;
  }
}

/** Carries the current file state when a write loses an mtime race. */
export class FsConflictError extends FsError {
  exists: boolean;
  currentMtime?: number | null;
  currentSize?: number;
  constructor(
    exists: boolean,
    currentMtime?: number | null,
    currentSize?: number,
  ) {
    super(409, "stale");
    this.name = "FsConflictError";
    this.exists = exists;
    this.currentMtime = currentMtime;
    this.currentSize = currentSize;
  }
}

/** Turn a thrown fetch/query error into a short, user-facing message. */
export function fsErrorMessage(error: unknown): string {
  if (error instanceof FsError) {
    switch (error.status) {
      case 403:
        return "Permission denied";
      case 404:
        return "Not found";
      case 409:
        return "Already exists";
      case 413:
        return "File is too large (max 1 GB)";
      case 502:
      case 503:
      case 504:
        return "Server unavailable";
      default:
        return error.message || "Something went wrong";
    }
  }
  // A rejected fetch (network / gateway down) never reaches FsError.
  return "Server unavailable";
}

// ---- Query-key factory ----

export const fsKeys = {
  all: ["fs"] as const,
  /** Prefix matching every list query for a session (any path/showHidden). */
  lists: (sessionId: string) => [...fsKeys.all, "list", sessionId] as const,
  list: (sessionId: string, path: string | null, showHidden: boolean) =>
    [...fsKeys.lists(sessionId), path ?? "@cwd", showHidden] as const,
  read: (sessionId: string, path: string) =>
    [...fsKeys.all, "read", sessionId, path] as const,
  stat: (sessionId: string, path: string) =>
    [...fsKeys.all, "stat", sessionId, path] as const,
  gitBase: (sessionId: string, path: string) =>
    [...fsKeys.all, "git-base", sessionId, path] as const,
};

// ---- Fetch helpers ----

function fsPath(sessionId: string, suffix: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/fs/${suffix}`;
}

async function throwForResponse(res: Response): Promise<never> {
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  throw new FsError(res.status, err.error ?? String(res.status));
}

async function fetchFsList(
  sessionId: string,
  path: string | null,
  showHidden: boolean,
): Promise<FsListResponse> {
  const params = new URLSearchParams();
  if (path != null) params.set("path", path);
  params.set("showHidden", showHidden ? "1" : "0");
  const res = await fetch(fsPath(sessionId, `list?${params.toString()}`));
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsListResponseSchema.parse(data);
}

export async function fetchFsReadOnce(
  sessionId: string,
  path: string,
): Promise<FsReadResponse> {
  const params = new URLSearchParams({ path });
  const res = await fetch(fsPath(sessionId, `read?${params.toString()}`));
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsReadResponseSchema.parse(data);
}

async function fetchFsStat(
  sessionId: string,
  path: string,
): Promise<FsStatResponse> {
  const params = new URLSearchParams({ path });
  const res = await fetch(fsPath(sessionId, `stat?${params.toString()}`));
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsStatResponseSchema.parse(data);
}

async function fetchFsGitBase(
  sessionId: string,
  path: string,
): Promise<FsGitBaseResponse> {
  const params = new URLSearchParams({ path });
  const res = await fetch(fsPath(sessionId, `git-base?${params.toString()}`));
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsGitBaseResponseSchema.parse(data);
}

async function mkdirApi(
  sessionId: string,
  body: FsMkdirRequest,
): Promise<FsMkdirResponse> {
  const res = await fetch(fsPath(sessionId, "mkdir"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsMkdirResponseSchema.parse(data);
}

async function renameApi(
  sessionId: string,
  body: FsRenameRequest,
): Promise<FsRenameResponse> {
  const res = await fetch(fsPath(sessionId, "entry"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsRenameResponseSchema.parse(data);
}

async function deleteApi(
  sessionId: string,
  path: string,
  recursive: boolean,
): Promise<FsDeleteResponse> {
  const params = new URLSearchParams({ path });
  if (recursive) params.set("recursive", "1");
  const res = await fetch(fsPath(sessionId, `entry?${params.toString()}`), {
    method: "DELETE",
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsDeleteResponseSchema.parse(data);
}

// XHR, not fetch: fetch has no cross-browser way to observe request-body
// upload progress, only XMLHttpRequest.upload.onprogress does.
function uploadApi(
  sessionId: string,
  destPath: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<FsUploadResponse> {
  const params = new URLSearchParams({ path: destPath });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", fsPath(sessionId, `upload?${params.toString()}`));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        reject(new UnauthorizedError());
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        let err: { error?: string } = {};
        try {
          err = JSON.parse(xhr.responseText) as { error?: string };
        } catch {
          // non-JSON error body (e.g. a proxy 502 page) — fall through below
        }
        reject(new FsError(xhr.status, err.error ?? String(xhr.status)));
        return;
      }
      try {
        const data: unknown = JSON.parse(xhr.responseText);
        resolve(FsUploadResponseSchema.parse(data));
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

async function writeApi(
  sessionId: string,
  path: string,
  content: string,
  baseMtime: number | null,
  force: boolean,
): Promise<FsWriteResponse> {
  const params = new URLSearchParams({ path, force: force ? "1" : "0" });
  if (baseMtime != null) params.set("baseMtime", String(baseMtime));
  const res = await fetch(fsPath(sessionId, `write?${params.toString()}`), {
    method: "PUT",
    body: content,
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 409) {
    const err = (await res.json()) as {
      error: "stale";
      exists: boolean;
      currentMtime?: number | null;
      currentSize?: number;
    };
    throw new FsConflictError(err.exists, err.currentMtime, err.currentSize);
  }
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsWriteResponseSchema.parse(data);
}

// ---- Queries ----

export function useFsList(
  sessionId: string | null,
  path: string | null,
  showHidden: boolean,
  enabled: boolean,
) {
  return useQuery({
    queryKey: fsKeys.list(sessionId ?? "", path, showHidden),
    queryFn: () => fetchFsList(sessionId!, path, showHidden),
    enabled: enabled && !!sessionId,
    // Not a live stream: no refetchInterval (manual Refresh instead). Keep the
    // previous directory visible while the next one loads (no empty flash).
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

export function useFsRead(sessionId: string | null, path: string | null) {
  return useQuery({
    queryKey: fsKeys.read(sessionId ?? "", path ?? ""),
    queryFn: () => fetchFsReadOnce(sessionId!, path!),
    enabled: !!sessionId && !!path,
    staleTime: 30 * 1000,
  });
}

export function useFsStat(
  sessionId: string | null,
  path: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: fsKeys.stat(sessionId ?? "", path ?? ""),
    queryFn: () => fetchFsStat(sessionId!, path!),
    enabled: !!sessionId && !!path && (options?.enabled ?? true),
    refetchInterval: 5000,
    staleTime: 30 * 1000,
  });
}

export function useFsGitBase(
  sessionId: string | null,
  path: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: fsKeys.gitBase(sessionId ?? "", path ?? ""),
    queryFn: () => fetchFsGitBase(sessionId!, path!),
    enabled: !!sessionId && !!path && (options?.enabled ?? true),
    staleTime: 30 * 1000,
  });
}

// ---- Mutations ----

export function useFsMkdir(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FsMkdirRequest) => mkdirApi(sessionId, body),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: fsKeys.lists(sessionId) }),
  });
}

export function useFsRename(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FsRenameRequest) => renameApi(sessionId, body),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: fsKeys.lists(sessionId) }),
  });
}

export function useFsDelete(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { path: string; recursive: boolean }) =>
      deleteApi(sessionId, vars.path, vars.recursive),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: fsKeys.lists(sessionId) }),
  });
}

export function useFsUpload(sessionId: string) {
  const qc = useQueryClient();
  // Upload progress lives outside react-query's mutation state (it has no
  // channel for a fetch/XHR's in-flight byte count) — tracked here instead
  // and reset on every new attempt / on settle.
  const [progress, setProgress] = useState<number | null>(null);
  const mutation = useMutation({
    mutationFn: (vars: { destPath: string; file: File }) =>
      uploadApi(sessionId, vars.destPath, vars.file, setProgress),
    onMutate: () => setProgress(0),
    onSettled: () => setProgress(null),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: fsKeys.lists(sessionId) }),
  });
  return { ...mutation, progress };
}

export function useFsWrite(sessionId: string) {
  return useMutation({
    mutationFn: (vars: {
      path: string;
      content: string;
      baseMtime: number | null;
      force?: boolean;
    }) =>
      writeApi(
        sessionId,
        vars.path,
        vars.content,
        vars.baseMtime,
        vars.force ?? false,
      ),
  });
}

// ---- Download (plain anchor to the streamed endpoint; not a query) ----

export function downloadFsFile(sessionId: string, path: string): void {
  const params = new URLSearchParams({ path });
  const url = fsPath(sessionId, `download?${params.toString()}`);
  const a = document.createElement("a");
  a.href = url;
  a.download = basename(path);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- Path helpers (absolute, POSIX) ----

export function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
}
