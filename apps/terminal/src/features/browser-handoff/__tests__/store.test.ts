import { beforeEach, describe, expect, it } from "vitest";

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
    const idleExpiresAt = 1_800_000_120_000;
    const hardExpiresAt = 1_800_000_600_000;
    useBrowserHandoffStore.getState().ingestControl({
      type: "browser_handoff_state",
      browserId: "browser-1",
      handoffId: "handoff-1",
      state: "human_active",
      expiresAt: idleExpiresAt,
      hardExpiresAt,
    });
    const first = useBrowserHandoffStore.getState();
    expect(first.idleExpiresAt).toBe(idleExpiresAt);
    expect(first.hardExpiresAt).toBe(hardExpiresAt);

    const updatedIdle = idleExpiresAt + 60_000;
    useBrowserHandoffStore
      .getState()
      .updateExpiry(updatedIdle, first.hardExpiresAt ?? undefined);
    expect(useBrowserHandoffStore.getState().idleExpiresAt).toBe(updatedIdle);
    expect(useBrowserHandoffStore.getState().hardExpiresAt).toBe(
      first.hardExpiresAt,
    );
  });
});
