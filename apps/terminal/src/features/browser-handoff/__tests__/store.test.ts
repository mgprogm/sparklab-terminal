import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBrowserHandoffStore } from "../store";

describe("browser handoff store", () => {
  beforeEach(() => useBrowserHandoffStore.getState().clear());

  it("keeps ready credentials in ephemeral state and clears them on return", () => {
    useBrowserHandoffStore.getState().ingestControl({
      type: "browser_handoff_ready",
      browserId: "browser-1",
      handoffId: "handoff-1",
      token: "memory-only-token",
      expiresAt: Date.now() + 30_000,
    });
    expect(useBrowserHandoffStore.getState()).toMatchObject({
      token: "memory-only-token",
      state: "pending",
      connectionState: "connecting",
    });
    expect("persist" in useBrowserHandoffStore).toBe(false);

    useBrowserHandoffStore.getState().ingestControl({
      type: "browser_handoff_state",
      browserId: "browser-1",
      handoffId: "handoff-1",
      state: "agent_active",
    });
    expect(useBrowserHandoffStore.getState()).toMatchObject({
      token: null,
      state: "agent_active",
    });
  });

  it("uses authoritative idle and hard deadlines from the server", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    useBrowserHandoffStore.getState().ingestControl({
      type: "browser_handoff_state",
      browserId: "browser-1",
      state: "human_active",
    });
    const first = useBrowserHandoffStore.getState();
    expect(first.idleExpiresAt).toBe(Date.now() + 120_000);
    expect(first.hardExpiresAt).toBe(Date.now() + 600_000);

    const updatedIdle = Date.now() + 60_000;
    useBrowserHandoffStore
      .getState()
      .updateExpiry(updatedIdle, first.hardExpiresAt ?? undefined);
    expect(useBrowserHandoffStore.getState().idleExpiresAt).toBe(updatedIdle);
    expect(useBrowserHandoffStore.getState().hardExpiresAt).toBe(
      first.hardExpiresAt,
    );
    vi.useRealTimers();
  });
});
