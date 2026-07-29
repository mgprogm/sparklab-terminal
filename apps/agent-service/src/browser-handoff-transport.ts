import { createHmac, createHash } from "node:crypto";
import type {
  BrowserHandoffFallbackReason,
  BrowserHandoffIceServer,
  BrowserHandoffTransport,
} from "@sparklab/shared-types";
import { config } from "./config.js";
import { browserPerformanceMetrics } from "./browser-performance-metrics.js";

export type BrowserHandoffTransportState =
  | "awaiting_capabilities"
  | "jpeg_active"
  | "webrtc_negotiating"
  | "webrtc_active"
  | "fallback"
  | "closed";

/** Explicit state machine kept independent from any future media provider. */
export class BrowserHandoffTransportMachine {
  private value: BrowserHandoffTransportState = "awaiting_capabilities";
  private selected: BrowserHandoffTransport = "jpeg_ws";
  private lastFallbackReason?: BrowserHandoffFallbackReason;

  get state(): BrowserHandoffTransportState {
    return this.value;
  }

  get transport(): BrowserHandoffTransport {
    return this.selected;
  }

  get fallbackReason(): BrowserHandoffFallbackReason | undefined {
    return this.lastFallbackReason;
  }

  select(args: {
    preferWebRtc: boolean;
    clientSupportsWebRtc: boolean;
    providerAvailable: boolean;
    peerCapacity: boolean;
  }): {
    transport: BrowserHandoffTransport;
    reason?: BrowserHandoffFallbackReason;
  } {
    if (this.value !== "awaiting_capabilities") {
      if (this.value === "jpeg_active" || this.value === "fallback")
        return {
          transport: this.selected,
          reason: this.lastFallbackReason,
        };
      throw new Error("browser_transport_invalid_state");
    }
    if (!args.preferWebRtc) {
      this.value = "jpeg_active";
      return { transport: "jpeg_ws" };
    }
    const reason = !args.clientSupportsWebRtc
      ? "client_unsupported"
      : !args.providerAvailable
        ? "media_provider_unavailable"
        : !args.peerCapacity
          ? "peer_limit"
          : undefined;
    if (reason) {
      this.value = "fallback";
      this.lastFallbackReason = reason;
      return { transport: "jpeg_ws", reason };
    }
    this.selected = "webrtc";
    this.value = "webrtc_negotiating";
    return { transport: "webrtc" };
  }

  connected(): void {
    if (this.value !== "webrtc_negotiating")
      throw new Error("browser_transport_invalid_state");
    this.value = "webrtc_active";
  }

  fallback(reason: BrowserHandoffFallbackReason): void {
    if (this.value === "closed")
      throw new Error("browser_transport_invalid_state");
    this.selected = "jpeg_ws";
    this.value = "fallback";
    this.lastFallbackReason = reason;
  }

  /** A resumed authenticated socket must perform a fresh capability exchange. */
  resetForReconnect(): void {
    if (this.value === "closed")
      throw new Error("browser_transport_invalid_state");
    this.selected = "jpeg_ws";
    this.value = "awaiting_capabilities";
    this.lastFallbackReason = undefined;
  }

  close(): void {
    this.value = "closed";
  }
}

/** coturn TURN REST credentials: short-lived, opaque, and never logged. */
export function createHandoffIceServers(
  handoffId: string,
  now = Date.now(),
): BrowserHandoffIceServer[] {
  const servers: BrowserHandoffIceServer[] = config.handoff.stunUrls.map(
    (url) => ({ urls: url }),
  );
  if (config.handoff.turnUrls.length === 0 || !config.handoff.turnSecret)
    return servers;
  const expires = Math.floor(now / 1000) + config.handoff.turnTtlSeconds;
  const opaque = createHash("sha256")
    .update(handoffId)
    .digest("hex")
    .slice(0, 16);
  const username = `${expires}:${opaque}`;
  const credential = createHmac("sha1", config.handoff.turnSecret)
    .update(username)
    .digest("base64");
  servers.push({ urls: [...config.handoff.turnUrls], username, credential });
  return servers;
}

type CleanupReason =
  | "finished"
  | "token_timeout"
  | "idle_timeout"
  | "hard_timeout"
  | "disconnect_timeout"
  | "cancel"
  | "chat_revoked"
  | "browser_revoked"
  | "shutdown"
  | "activation_failed";

class BrowserHandoffMetrics {
  private activeHandoffs = 0;
  private activePeers = 0;
  private fallbacks = 0;
  private droppedFrames = 0;
  private negotiationFailures: Record<string, number> = {};
  private cleanupReasons: Record<string, number> = {};
  private selectedTransports: Record<string, number> = {};
  private iceStates: Record<string, number> = {};
  private completedNegotiations = 0;
  private negotiationDurationMs = 0;

  handoffStarted(): void {
    this.activeHandoffs++;
  }
  handoffEnded(reason: CleanupReason): void {
    this.activeHandoffs = Math.max(0, this.activeHandoffs - 1);
    this.cleanupReasons[reason] = (this.cleanupReasons[reason] ?? 0) + 1;
  }
  fallback(reason: BrowserHandoffFallbackReason): void {
    this.fallbacks++;
    this.negotiationFailures[reason] =
      (this.negotiationFailures[reason] ?? 0) + 1;
  }
  frameDropped(): void {
    this.droppedFrames++;
  }
  frameBytesDropped(bytes: number): void {
    browserPerformanceMetrics.handoffFrameDropped(bytes);
  }
  frameSent(bytes: number): void {
    browserPerformanceMetrics.handoffFrameSent(bytes);
  }
  peerStarted(): void {
    this.activePeers++;
  }
  peerEnded(): void {
    this.activePeers = Math.max(0, this.activePeers - 1);
  }
  transportSelected(transport: BrowserHandoffTransport): void {
    this.selectedTransports[transport] =
      (this.selectedTransports[transport] ?? 0) + 1;
  }
  negotiationCompleted(durationMs: number): void {
    this.completedNegotiations++;
    this.negotiationDurationMs += Math.max(0, Math.trunc(durationMs));
  }
  iceState(state: string): void {
    this.iceStates[state] = (this.iceStates[state] ?? 0) + 1;
  }
  snapshot() {
    return {
      activeHandoffs: this.activeHandoffs,
      activePeers: this.activePeers,
      fallbacks: this.fallbacks,
      droppedFrames: this.droppedFrames,
      negotiationFailures: { ...this.negotiationFailures },
      cleanupReasons: { ...this.cleanupReasons },
      selectedTransports: { ...this.selectedTransports },
      iceStates: { ...this.iceStates },
      completedNegotiations: this.completedNegotiations,
      negotiationDurationMs: this.negotiationDurationMs,
    };
  }
}

export const browserHandoffMetrics = new BrowserHandoffMetrics();
export type BrowserHandoffCleanupReason = CleanupReason;
