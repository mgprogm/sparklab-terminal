/**
 * Approval gate for write tools.
 *
 * When the loop hits a write tool not covered by the chat's allow-always set,
 * it calls requestApproval(): an `approval_request` frame goes to the browser
 * and the loop awaits the user's `approval_response`. A 120s timeout resolves
 * to "deny" so a walked-away user can never leave the agent blocked forever.
 *
 * "allow_always" records tool+session in a per-chat set so subsequent matching
 * writes skip the gate (non-persistent — a new connection starts fresh).
 */
import { randomUUID } from "node:crypto";
import { CAPS } from "./config.js";
import type { AgentApprovalBehavior } from "@sparklab/shared-types";

interface Pending {
  resolve: (behavior: AgentApprovalBehavior) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalManager {
  private pending = new Map<string, Pending>();
  private allowAlways = new Set<string>();

  private key(tool: string, sessionId?: string): string {
    return `${tool}::${sessionId ?? "*"}`;
  }

  isAutoAllowed(tool: string, sessionId?: string): boolean {
    return this.allowAlways.has(this.key(tool, sessionId));
  }

  /**
   * @param send  emits the approval_request frame with the given requestId
   * @returns the user's decision ("deny" on timeout)
   */
  request(
    tool: string,
    sessionId: string | undefined,
    send: (requestId: string) => void,
  ): Promise<AgentApprovalBehavior> {
    const requestId = randomUUID();
    return new Promise<AgentApprovalBehavior>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve("deny");
      }, CAPS.approvalTimeoutMs);
      this.pending.set(requestId, { resolve, timer });
      send(requestId);
    }).then((behavior) => {
      if (behavior === "allow_always") {
        this.allowAlways.add(this.key(tool, sessionId));
      }
      return behavior;
    });
  }

  /** Called when an approval_response frame arrives. */
  resolve(requestId: string, behavior: AgentApprovalBehavior): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(behavior);
  }

  /** Deny everything outstanding (on interrupt or disconnect). */
  denyAll(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve("deny");
    }
    this.pending.clear();
  }
}
