/**
 * Hook tests for use-sessions.ts with QueryClientProvider wrapper + mocked fetch.
 * Verifies Zod parse failures surface as errors.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useCreateSession,
  useDeleteSession,
  useSessions,
} from "../hooks/use-sessions";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useSessions", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and parses a valid session list", async () => {
    const sessions = [
      {
        id: "web-abc",
        name: "alpha",
        createdAt: 1720900000000,
        tags: [],
        currentCommand: "bash",
        attached: false,
      },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(sessions),
    });

    const { result } = renderHook(() => useSessions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0]!.id).toBe("web-abc");
  });

  it("surfaces Zod parse error for invalid shape", async () => {
    // Missing required fields
    const badPayload = [{ id: "web-abc" }]; // missing name, tags, etc.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(badPayload),
    });

    const { result } = renderHook(() => useSessions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeDefined();
  });

  it("surfaces HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useSessions(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe("useCreateSession", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("creates a session and parses response", async () => {
    const response = {
      id: "web-new",
      name: "new-session",
      createdAt: Date.now(),
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(response),
    });

    const { result } = renderHook(() => useCreateSession(), {
      wrapper: createWrapper(),
    });

    result.current.mutate("new-session");

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(response);
  });

  it("surfaces Zod parse error for invalid create response", async () => {
    // createdAt missing
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "web-x", name: "x" }),
    });

    const { result } = renderHook(() => useCreateSession(), {
      wrapper: createWrapper(),
    });

    result.current.mutate("bad");

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe("useDeleteSession", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("deletes a session (204 No Content)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
    });

    const { result } = renderHook(() => useDeleteSession(), {
      wrapper: createWrapper(),
    });

    result.current.mutate("web-dead");

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
  });

  it("surfaces error on non-204 failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "session not found" }),
    });

    const { result } = renderHook(() => useDeleteSession(), {
      wrapper: createWrapper(),
    });

    result.current.mutate("web-nonexistent");

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
