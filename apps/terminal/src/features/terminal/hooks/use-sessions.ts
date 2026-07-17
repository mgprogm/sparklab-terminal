import {
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  type ListSessionsResponse,
  ListSessionsResponseSchema,
  type UpdateSessionResponse,
  UpdateSessionResponseSchema,
} from "@sparklab/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { UnauthorizedError } from "@/features/auth/api";

// ---- Query-key factory ----
export const sessionKeys = {
  all: ["sessions"] as const,
  list: () => [...sessionKeys.all, "list"] as const,
};

// ---- Fetchers (Zod-parsed at the boundary) ----

async function fetchSessions(): Promise<ListSessionsResponse> {
  const res = await fetch("/api/sessions");
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok)
    throw new Error(`Failed to fetch sessions: ${String(res.status)}`);
  const data: unknown = await res.json();
  return ListSessionsResponseSchema.parse(data);
}

export interface CreateSessionParams {
  name?: string;
  org?: string;
  project?: string;
  /** Target server id from the registry. Omitted => "local" (single-server).
   *  Only sent in multi-server mode so the local-only POST body is unchanged. */
  serverId?: string;
}

async function createSessionApi(
  params?: CreateSessionParams | string,
): Promise<CreateSessionResponse> {
  // Accept legacy string (name-only) or an object with optional org/project.
  const body: Record<string, string> = {};
  if (typeof params === "string") {
    if (params.trim()) body.name = params.trim();
  } else if (params) {
    if (params.name?.trim()) body.name = params.name.trim();
    if (params.org?.trim()) body.org = params.org.trim();
    if (params.project?.trim()) body.project = params.project.trim();
    if (params.serverId?.trim()) body.serverId = params.serverId.trim();
  }

  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const err = (await res
      .json()
      .catch(() => ({ error: String(res.status) }))) as { error?: string };
    throw new Error(err.error ?? String(res.status));
  }
  const data: unknown = await res.json();
  return CreateSessionResponseSchema.parse(data);
}

async function deleteSessionApi(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok && res.status !== 204) {
    const err = (await res
      .json()
      .catch(() => ({ error: String(res.status) }))) as { error?: string };
    throw new Error(err.error ?? String(res.status));
  }
}

export interface UpdateSessionParams {
  id: string;
  name?: string;
  org?: string | null;
  project?: string | null;
  muted?: boolean;
}

async function updateSessionApi(
  params: UpdateSessionParams,
): Promise<UpdateSessionResponse> {
  const { id, ...body } = params;
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const err = (await res
      .json()
      .catch(() => ({ error: String(res.status) }))) as { error?: string };
    throw new Error(err.error ?? String(res.status));
  }
  const data: unknown = await res.json();
  return UpdateSessionResponseSchema.parse(data);
}

// ---- Hooks ----

export function useSessions() {
  return useQuery({
    queryKey: sessionKeys.list(),
    queryFn: fetchSessions,
    refetchInterval: 3000,
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSessionApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSessionApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}

export function useUpdateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSessionApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });
}
