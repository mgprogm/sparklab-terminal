import {
  type CreateSessionResponse,
  CreateSessionResponseSchema,
  type ListSessionsResponse,
  ListSessionsResponseSchema,
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

async function createSessionApi(name?: string): Promise<CreateSessionResponse> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name?.trim() ? { name: name.trim() } : {}),
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
