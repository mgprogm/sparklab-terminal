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
  type FsUploadResponse,
  FsUploadResponseSchema,
} from "@sparklab/shared-types";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

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
        return "File is too large (max 8 MB)";
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

async function fetchFsRead(
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

async function uploadApi(
  sessionId: string,
  destPath: string,
  file: File,
): Promise<FsUploadResponse> {
  const params = new URLSearchParams({ path: destPath });
  const res = await fetch(fsPath(sessionId, `upload?${params.toString()}`), {
    method: "POST",
    body: file,
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) await throwForResponse(res);
  const data: unknown = await res.json();
  return FsUploadResponseSchema.parse(data);
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
    queryFn: () => fetchFsRead(sessionId!, path!),
    enabled: !!sessionId && !!path,
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
  return useMutation({
    mutationFn: (vars: { destPath: string; file: File }) =>
      uploadApi(sessionId, vars.destPath, vars.file),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: fsKeys.lists(sessionId) }),
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
