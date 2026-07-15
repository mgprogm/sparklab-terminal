import {
  type CreateServerRequest,
  type CreateServerResponse,
  CreateServerResponseSchema,
  type ListServersResponse,
  ListServersResponseSchema,
  type TestServerRequest,
  type TestServerResponse,
  TestServerResponseSchema,
} from "@sparklab/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { UnauthorizedError } from "@/features/auth/api";

// ---- Query-key factory ----
export const serverKeys = {
  all: ["servers"] as const,
  list: () => [...serverKeys.all, "list"] as const,
};

// ---- Fetchers (Zod-parsed at the boundary) ----

async function fetchServers(): Promise<ListServersResponse> {
  const res = await fetch("/api/servers");
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok)
    throw new Error(`Failed to fetch servers: ${String(res.status)}`);
  const data: unknown = await res.json();
  return ListServersResponseSchema.parse(data);
}

async function createServerApi(
  body: CreateServerRequest,
): Promise<CreateServerResponse> {
  const res = await fetch("/api/servers", {
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
  return CreateServerResponseSchema.parse(data);
}

async function deleteServerApi(id: string): Promise<void> {
  const res = await fetch(`/api/servers/${encodeURIComponent(id)}`, {
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

async function testServerApi(
  body: TestServerRequest,
): Promise<TestServerResponse> {
  const res = await fetch("/api/servers/test", {
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
  return TestServerResponseSchema.parse(data);
}

// ---- Hooks ----

export function useServers() {
  return useQuery({
    queryKey: serverKeys.list(),
    queryFn: fetchServers,
    // Same cadence as sessions so reachability dots flip without a refresh.
    refetchInterval: 3000,
  });
}

export function useCreateServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createServerApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverKeys.list() });
    },
  });
}

export function useDeleteServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteServerApi,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: serverKeys.list() });
    },
  });
}

export function useTestServer() {
  return useMutation({ mutationFn: testServerApi });
}
