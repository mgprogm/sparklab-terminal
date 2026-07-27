import { create } from "zustand";

import type { BrowserHandoffControlFrame } from "./protocol";

export type HandoffLeaseState =
  "none" | "pending" | "human_active" | "agent_active" | "closed";
export type HandoffConnectionState =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "closed";

interface BrowserHandoffStore {
  browserId: string | null;
  handoffId: string | null;
  token: string | null;
  state: HandoffLeaseState;
  connectionState: HandoffConnectionState;
  expiresAt: number | null;
  hardExpiresAt: number | null;
  idleExpiresAt: number | null;
  ingestControl: (frame: BrowserHandoffControlFrame) => void;
  setConnectionState: (state: HandoffConnectionState) => void;
  consumeToken: () => void;
  updateExpiry: (expiresAt: number, hardExpiresAt?: number) => void;
  clear: () => void;
}

const IDLE_TIMEOUT_MS = 2 * 60_000;
const HARD_TIMEOUT_MS = 10 * 60_000;

const initialState = {
  browserId: null,
  handoffId: null,
  token: null,
  state: "none" as const,
  connectionState: "disconnected" as const,
  expiresAt: null,
  hardExpiresAt: null,
  idleExpiresAt: null,
};

/** Memory-only handoff state. Tokens and frames never use persist middleware. */
export const useBrowserHandoffStore = create<BrowserHandoffStore>()((set) => ({
  ...initialState,

  ingestControl: (frame) =>
    set((current) => {
      if (frame.type === "browser_handoff_ready") {
        return {
          browserId: frame.browserId,
          handoffId: frame.handoffId,
          token: frame.token,
          state: "pending",
          connectionState: "connecting",
          expiresAt: frame.expiresAt,
          hardExpiresAt: null,
          idleExpiresAt: null,
        };
      }

      if (current.browserId && frame.browserId !== current.browserId)
        return current;
      const now = Date.now();
      const becameHuman =
        frame.state === "human_active" && current.state !== "human_active";
      const terminal =
        frame.state === "agent_active" || frame.state === "closed";
      return {
        browserId: frame.browserId,
        handoffId: frame.handoffId ?? current.handoffId,
        state: frame.state,
        expiresAt: frame.expiresAt ?? current.expiresAt,
        ...(becameHuman
          ? {
              hardExpiresAt: now + HARD_TIMEOUT_MS,
              idleExpiresAt: now + IDLE_TIMEOUT_MS,
            }
          : {}),
        ...(terminal
          ? {
              handoffId: null,
              token: null,
              connectionState:
                frame.state === "closed"
                  ? ("closed" as const)
                  : ("disconnected" as const),
              idleExpiresAt: null,
              hardExpiresAt: null,
            }
          : {}),
      };
    }),

  setConnectionState: (connectionState) => set({ connectionState }),
  consumeToken: () => set({ token: null }),
  updateExpiry: (idleExpiresAt, hardExpiresAt) =>
    set({ idleExpiresAt, ...(hardExpiresAt ? { hardExpiresAt } : {}) }),
  clear: () => set(initialState),
}));
