import { create } from "zustand";

import type { BrowserHandoffControlFrame } from "./protocol";
import type {
  BrowserHandoffFallbackReason,
  BrowserHandoffTransport,
} from "./protocol";

export type HandoffLeaseState =
  "none" | "pending" | "human_active" | "agent_active" | "closed";
export type HandoffConnectionState =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "closed";

interface BrowserHandoffStore {
  browserId: string | null;
  handoffId: string | null;
  token: string | null;
  resume: boolean;
  state: HandoffLeaseState;
  connectionState: HandoffConnectionState;
  expiresAt: number | null;
  hardExpiresAt: number | null;
  idleExpiresAt: number | null;
  transport: BrowserHandoffTransport;
  transportState: "idle" | "negotiating" | "connected" | "fallback" | "failed";
  transportReason: BrowserHandoffFallbackReason | null;
  ingestControl: (frame: BrowserHandoffControlFrame) => void;
  setConnectionState: (state: HandoffConnectionState) => void;
  consumeToken: () => void;
  updateExpiry: (expiresAt: number, hardExpiresAt?: number) => void;
  setTransportState: (value: {
    transport: BrowserHandoffTransport;
    state: "idle" | "negotiating" | "connected" | "fallback" | "failed";
    reason?: BrowserHandoffFallbackReason;
  }) => void;
  clear: () => void;
}

const initialState = {
  browserId: null,
  handoffId: null,
  token: null,
  resume: false,
  state: "none" as const,
  connectionState: "disconnected" as const,
  expiresAt: null,
  hardExpiresAt: null,
  idleExpiresAt: null,
  transport: "jpeg_ws" as const,
  transportState: "idle" as const,
  transportReason: null,
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
          resume: frame.resume === true,
          state: frame.resume ? "human_active" : "pending",
          connectionState: "connecting",
          expiresAt: frame.expiresAt,
          hardExpiresAt: null,
          idleExpiresAt: null,
        };
      }

      if (current.browserId && frame.browserId !== current.browserId)
        return current;
      const terminal =
        frame.state === "agent_active" || frame.state === "closed";
      return {
        browserId: frame.browserId,
        handoffId: frame.handoffId ?? current.handoffId,
        state: frame.state,
        expiresAt: frame.expiresAt ?? current.expiresAt,
        ...(frame.state === "human_active"
          ? {
              hardExpiresAt: frame.hardExpiresAt ?? current.hardExpiresAt,
              idleExpiresAt: frame.expiresAt ?? current.idleExpiresAt,
            }
          : {}),
        ...(terminal
          ? {
              handoffId: null,
              token: null,
              resume: false,
              connectionState:
                frame.state === "closed"
                  ? ("closed" as const)
                  : ("disconnected" as const),
              idleExpiresAt: null,
              hardExpiresAt: null,
              transport: "jpeg_ws" as const,
              transportState: "idle" as const,
              transportReason: null,
            }
          : {}),
      };
    }),

  setConnectionState: (connectionState) => set({ connectionState }),
  consumeToken: () => set({ token: null }),
  updateExpiry: (idleExpiresAt, hardExpiresAt) =>
    set({ idleExpiresAt, ...(hardExpiresAt ? { hardExpiresAt } : {}) }),
  setTransportState: ({ transport, state, reason }) =>
    set({ transport, transportState: state, transportReason: reason ?? null }),
  clear: () => set(initialState),
}));
