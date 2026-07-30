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

/** Process-wide numeric aggregates. Never accepts request or session metadata. */
export class BrowserPerformanceMetrics {
  private launchQueueDepth = 0;
  private peakLaunchQueueDepth = 0;
  private launchQueue = timingSummary();
  private chromiumReadiness = timingSummary();
  private mcpReadiness = timingSummary();
  private browserCalls = timingSummary();
  private snapshotBytes = byteSummary();
  private stateBytes = byteSummary();
  private handoffFramesSent = byteSummary();
  private handoffFramesDropped = byteSummary();

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

  chromiumReady(durationMs: number, success: boolean): void {
    this.recordTiming(this.chromiumReadiness, durationMs, success);
  }

  mcpReady(durationMs: number, success: boolean): void {
    this.recordTiming(this.mcpReadiness, durationMs, success);
  }

  browserCall(durationMs: number, success: boolean): void {
    this.recordTiming(this.browserCalls, durationMs, success);
  }

  browserState(bytes: number): void {
    this.recordBytes(this.stateBytes, bytes);
  }

  browserSnapshot(bytes: number): void {
    this.recordBytes(this.snapshotBytes, bytes);
  }

  handoffFrameSent(bytes: number): void {
    this.recordBytes(this.handoffFramesSent, bytes);
  }

  handoffFrameDropped(bytes: number): void {
    this.recordBytes(this.handoffFramesDropped, bytes);
  }

  snapshot() {
    return {
      launchQueue: {
        depth: this.launchQueueDepth,
        peakDepth: this.peakLaunchQueueDepth,
        ...this.launchQueue,
      },
      chromiumReadiness: { ...this.chromiumReadiness },
      mcpReadiness: { ...this.mcpReadiness },
      browserCalls: { ...this.browserCalls },
      stateBytes: { ...this.stateBytes },
      snapshotBytes: { ...this.snapshotBytes },
      handoffFrames: {
        sent: { ...this.handoffFramesSent },
        dropped: { ...this.handoffFramesDropped },
      },
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

export const browserPerformanceMetrics = new BrowserPerformanceMetrics();
