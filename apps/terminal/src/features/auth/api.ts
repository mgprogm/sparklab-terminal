import { MeResponseSchema, type MeResponse } from "@sparklab/shared-types";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class RateLimitError extends Error {
  retryAfter: number;

  constructor(retryAfter: number) {
    super("Rate limited");
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    throw new RateLimitError(retryAfter);
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`Login failed: ${String(res.status)}`);
}

export async function logout(): Promise<void> {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  if (!res.ok) throw new Error(`Logout failed: ${String(res.status)}`);
}

export async function me(): Promise<MeResponse | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok)
    throw new Error(`Authentication check failed: ${String(res.status)}`);
  const data: unknown = await res.json();
  return MeResponseSchema.parse(data);
}
