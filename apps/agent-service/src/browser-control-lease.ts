export type BrowserLeaseState =
  "agent_active" | "pending" | "human_active" | "closed";

/** Synchronous, authoritative exclusive-control state machine. */
export class BrowserControlLease {
  private value: BrowserLeaseState = "agent_active";

  get state(): BrowserLeaseState {
    return this.value;
  }

  assertAgent(): void {
    if (this.value !== "agent_active")
      throw new Error("browser_under_human_control");
  }

  requestHuman(): void {
    if (this.value !== "agent_active") throw new Error("browser_handoff_busy");
    this.value = "pending";
  }

  activateHuman(): void {
    if (this.value !== "pending") throw new Error("browser_handoff_invalid");
    this.value = "human_active";
  }

  assertHuman(): void {
    if (this.value !== "human_active")
      throw new Error("browser_handoff_inactive");
  }

  returnToAgent(): void {
    if (this.value !== "human_active")
      throw new Error("browser_handoff_invalid");
    this.value = "agent_active";
  }

  close(): void {
    this.value = "closed";
  }
}
