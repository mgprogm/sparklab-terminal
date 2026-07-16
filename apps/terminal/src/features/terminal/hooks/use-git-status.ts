import {
  type GitStatusResponse,
  GitStatusResponseSchema,
} from "@sparklab/shared-types";
import { useQuery } from "@tanstack/react-query";

import { UnauthorizedError } from "@/features/auth/api";

// ---- Query-key factory ----
export const gitStatusKeys = {
  all: ["git-status"] as const,
  session: (id: string) => [...gitStatusKeys.all, id] as const,
};

async function fetchGitStatus(id: string): Promise<GitStatusResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/git`);
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok)
    throw new Error(`Failed to fetch git status: ${String(res.status)}`);
  const data: unknown = await res.json();
  return GitStatusResponseSchema.parse(data);
}

/**
 * Poll the git summary for one session's cwd, for the mini footer.
 *
 * Enabled only for the active session on a reachable server — never polls an
 * unreachable host (mirrors the header/explorer `activeServerUnreachable`
 * guard). `retry: false` so a transient 502 doesn't hammer a slow repo; the 5s
 * interval retries anyway. The result is `{ isRepo: false }` outside a repo,
 * which the footer renders as nothing.
 */
export function useGitStatus(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: gitStatusKeys.session(sessionId ?? ""),
    queryFn: () => fetchGitStatus(sessionId as string),
    enabled: enabled && !!sessionId,
    refetchInterval: 5000,
    retry: false,
    staleTime: 2000,
  });
}
