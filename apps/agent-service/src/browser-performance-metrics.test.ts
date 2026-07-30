import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPerformanceMetrics } from "./browser-performance-metrics.js";

test("browser performance metrics expose aggregate numeric summaries only", () => {
  const metrics = new BrowserPerformanceMetrics();
  metrics.launchQueued();
  metrics.launchQueued();
  metrics.launchDequeued(12.9);
  metrics.launchDequeued(-3);
  metrics.chromiumReady(40, true);
  metrics.mcpReady(75, false);
  metrics.browserCall(9, true);
  metrics.browserCall(11, false);
  metrics.browserState(321);
  metrics.browserSnapshot(654);
  metrics.handoffFrameSent(800);
  metrics.handoffFrameDropped(900);

  assert.deepEqual(metrics.snapshot(), {
    launchQueue: {
      depth: 0,
      peakDepth: 2,
      attempts: 2,
      failures: 0,
      totalMs: 12,
      maxMs: 12,
    },
    chromiumReadiness: {
      attempts: 1,
      failures: 0,
      totalMs: 40,
      maxMs: 40,
    },
    mcpReadiness: {
      attempts: 1,
      failures: 1,
      totalMs: 75,
      maxMs: 75,
    },
    browserCalls: {
      attempts: 2,
      failures: 1,
      totalMs: 20,
      maxMs: 11,
    },
    stateBytes: { count: 1, totalBytes: 321, maxBytes: 321 },
    snapshotBytes: { count: 1, totalBytes: 654, maxBytes: 654 },
    handoffFrames: {
      sent: { count: 1, totalBytes: 800, maxBytes: 800 },
      dropped: { count: 1, totalBytes: 900, maxBytes: 900 },
    },
  });

  const serialized = JSON.stringify(metrics.snapshot());
  assert.doesNotMatch(
    serialized,
    /url|text|coordinate|token|identifier|image|session|action/i,
  );
});
