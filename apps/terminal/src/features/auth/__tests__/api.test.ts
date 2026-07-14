// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { login, logout, me, RateLimitError, UnauthorizedError } from "../api";

describe("auth api", () => {
  beforeEach(() => mockFetch.mockReset());

  it("login() returns void on 204", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
      headers: { get: () => null },
    });
    await expect(login("tok")).resolves.toBeUndefined();
  });

  it("login() throws UnauthorizedError on 401", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
    });
    await expect(login("bad")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("login() throws RateLimitError on 429", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: {
        get: (header: string) => (header === "retry-after" ? "30" : null),
      },
    });
    await expect(login("tok")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("me() returns data on 200", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ authenticated: true }),
    });
    await expect(me()).resolves.toEqual({ authenticated: true });
  });

  it("me() returns null on 401", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: "unauthorized" }),
    });
    await expect(me()).resolves.toBeNull();
  });

  it("logout() returns void on 204", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
    await expect(logout()).resolves.toBeUndefined();
  });
});
