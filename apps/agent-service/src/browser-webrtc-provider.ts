import type {
  BrowserHandoffFallbackReason,
  BrowserHandoffIceServer,
} from "@sparklab/shared-types";
import type { BrowserRuntime } from "./browser-runtime.js";

export interface WebRtcDescription {
  type: "offer" | "answer";
  sdp: string;
}

export interface WebRtcCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string;
}

export interface BrowserWebRtcPeer {
  readonly offer: WebRtcDescription;
  acceptAnswer(description: WebRtcDescription): Promise<void>;
  addRemoteCandidate(candidate: WebRtcCandidate): Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Internal provider seam. Implementations own capture, encoding, ICE/DTLS/SRTP,
 * and congestion control; none of those implementation details cross the WS.
 */
export interface BrowserWebRtcProvider {
  readonly available: boolean;
  createPeer(args: {
    browser: BrowserRuntime;
    negotiationId: string;
    iceServers: BrowserHandoffIceServer[];
    onCandidate: (candidate: WebRtcCandidate) => void;
    onState: (
      state: "connected" | "failed" | "closed",
      reason?: BrowserHandoffFallbackReason,
    ) => void;
  }): Promise<BrowserWebRtcPeer>;
}

export const unavailableWebRtcProvider: BrowserWebRtcProvider = {
  available: false,
  async createPeer() {
    throw new Error("browser_webrtc_provider_unavailable");
  },
};
