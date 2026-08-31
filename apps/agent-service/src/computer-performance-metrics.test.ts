import assert from "node:assert/strict";
import test from "node:test";
import { ComputerPerformanceMetrics } from "./computer-performance-metrics.js";

test("computer performance metrics expose aggregate numeric summaries only", () => {
  const metrics = new ComputerPerformanceMetrics();
  metrics.launchQueued();
  metrics.launchQueued();
  metrics.launchDequeued(12.9);
  metrics.launchDequeued(-3);
  metrics.desktopReady(4000, true);
  metrics.driverReady(120, false);
  metrics.driverReady(90, true);
  metrics.computerCall(9, true);
  metrics.computerCall(11, false);
  metrics.computerScreenshot(65_536);
  metrics.computerElements(321);
  metrics.computerError("timeout");
  metrics.computerError("transport");
  metrics.computerError("transport");

  assert.deepEqual(metrics.snapshot(), {
    launchQueue: {
      depth: 0,
      peakDepth: 2,
      attempts: 2,
      failures: 0,
      totalMs: 12,
      maxMs: 12,
    },
    desktopReadiness: { attempts: 1, failures: 0, totalMs: 4000, maxMs: 4000 },
    driverReadiness: { attempts: 2, failures: 1, totalMs: 210, maxMs: 120 },
    computerCalls: { attempts: 2, failures: 1, totalMs: 20, maxMs: 11 },
    screenshotBytes: { count: 1, totalBytes: 65_536, maxBytes: 65_536 },
    elementBytes: { count: 1, totalBytes: 321, maxBytes: 321 },
    errors: { aborted: 0, timeout: 1, protocol: 0, transport: 2 },
  });

  const serialized = JSON.stringify(metrics.snapshot());
  assert.doesNotMatch(
    serialized,
    /url|text|coordinate|token|identifier|image|session|action/i,
  );
});
