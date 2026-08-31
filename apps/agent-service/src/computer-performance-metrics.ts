/**
 * Process-wide numeric aggregates for the Virtual Computer (CUA) runtime — the
 * desktop counterpart of `browser-performance-metrics.ts`, mirroring its
 * structure and its label-free discipline: this module NEVER accepts
 * coordinates, window titles, URLs, typed input, tokens, image bytes, or any
 * per-request / per-session identifier. Only durations, counts, and byte sizes.
 *
 * `ComputerRuntime.metrics()` stays a per-instance snapshot for unit tests;
 * this singleton is what `/health` exposes (process-wide, like
 * `browserResources` / `browserPerformance`). See docs/VIRTUAL-COMPUTER.md and
 * docs/VIRTUAL-COMPUTER-REMAINING.md M2.4.
 */

export interface TimingSummary {
  attempts: number;
  failures: number;
  totalMs: number;
  maxMs: number;
}

export interface ByteSummary {
  count: number;
  totalBytes: number;
  maxBytes: number;
}

function timingSummary(): TimingSummary {
  return { attempts: 0, failures: 0, totalMs: 0, maxMs: 0 };
}

function byteSummary(): ByteSummary {
  return { count: 0, totalBytes: 0, maxBytes: 0 };
}

/** Coarse, fixed error buckets — numeric counters, never keyed by a message. */
export type ComputerErrorClass =
  "aborted" | "timeout" | "protocol" | "transport";

function errorCounts(): Record<ComputerErrorClass, number> {
  return { aborted: 0, timeout: 0, protocol: 0, transport: 0 };
}

export class ComputerPerformanceMetrics {
  // Cold-start launch queue (computerResources.acquireLaunch), mirroring the
  // browser limiter's queue-depth reporting.
  private launchQueueDepth = 0;
  private peakLaunchQueueDepth = 0;
  private launchQueue = timingSummary();
  // docker run -> X session ready.
  private desktopReadiness = timingSummary();
  // driver `docker exec` spawn -> MCP `initialize` returned. Recorded once per
  // retry attempt (START_ATTEMPTS), so `failures` counts failed cold-start
  // attempts, not desktops — a fully-failed start contributes up to 8 attempts.
  private driverReadiness = timingSummary();
  // Per `tools/call` round-trip (observe's get_desktop_state / list_windows /
  // get_screen_size and act's input tool all pass through here).
  private computerCalls = timingSummary();
  // Decoded screenshot payload pulled out of the container per observe().
  private screenshotBytes = byteSummary();
  // Window-inventory text handed to the model per observe() (the M3.1
  // element-slice bytes will fold in here once per-window elements land).
  private elementBytes = byteSummary();
  private errors = errorCounts();

  launchQueued(): void {
    this.launchQueueDepth++;
    this.peakLaunchQueueDepth = Math.max(
      this.peakLaunchQueueDepth,
      this.launchQueueDepth,
    );
  }

  launchDequeued(durationMs: number): void {
    this.launchQueueDepth = Math.max(0, this.launchQueueDepth - 1);
    this.recordTiming(this.launchQueue, durationMs, true);
  }

  desktopReady(durationMs: number, success: boolean): void {
    this.recordTiming(this.desktopReadiness, durationMs, success);
  }

  driverReady(durationMs: number, success: boolean): void {
    this.recordTiming(this.driverReadiness, durationMs, success);
  }

  computerCall(durationMs: number, success: boolean): void {
    this.recordTiming(this.computerCalls, durationMs, success);
  }

  computerScreenshot(bytes: number): void {
    this.recordBytes(this.screenshotBytes, bytes);
  }

  computerElements(bytes: number): void {
    this.recordBytes(this.elementBytes, bytes);
  }

  computerError(kind: ComputerErrorClass): void {
    this.errors[kind]++;
  }

  snapshot() {
    return {
      launchQueue: {
        depth: this.launchQueueDepth,
        peakDepth: this.peakLaunchQueueDepth,
        ...this.launchQueue,
      },
      desktopReadiness: { ...this.desktopReadiness },
      driverReadiness: { ...this.driverReadiness },
      computerCalls: { ...this.computerCalls },
      screenshotBytes: { ...this.screenshotBytes },
      elementBytes: { ...this.elementBytes },
      errors: { ...this.errors },
    };
  }

  private recordTiming(
    summary: TimingSummary,
    durationMs: number,
    success: boolean,
  ): void {
    const duration = nonNegativeInteger(durationMs);
    summary.attempts++;
    if (!success) summary.failures++;
    summary.totalMs += duration;
    summary.maxMs = Math.max(summary.maxMs, duration);
  }

  private recordBytes(summary: ByteSummary, bytes: number): void {
    const size = nonNegativeInteger(bytes);
    summary.count++;
    summary.totalBytes += size;
    summary.maxBytes = Math.max(summary.maxBytes, size);
  }
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export const computerPerformanceMetrics = new ComputerPerformanceMetrics();
