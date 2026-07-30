import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
const { BrowserResourceLimiter } =
  await import("./browser-resource-limiter.js");
const { BrowserPerformanceMetrics } =
  await import("./browser-performance-metrics.js");

test("browser resource limiter bounds sessions and serializes launches", async () => {
  let now = 100;
  const metrics = new BrowserPerformanceMetrics();
  const limiter = new BrowserResourceLimiter(1, 1, metrics, () => now);
  const releaseSession = limiter.reserveSession();
  assert.throws(
    () => limiter.reserveSession(),
    /browser_session_limit_reached/,
  );

  const releaseFirstLaunch = await limiter.acquireLaunch();
  let secondStarted = false;
  const second = limiter.acquireLaunch().then((release) => {
    secondStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondStarted, false);
  assert.equal(metrics.snapshot().launchQueue.depth, 1);
  now = 125;
  releaseFirstLaunch();
  const releaseSecondLaunch = await second;
  assert.equal(secondStarted, true);
  releaseSecondLaunch();
  releaseSession();
  assert.deepEqual(limiter.snapshot(), {
    activeSessions: 0,
    activeLaunches: 0,
  });
  assert.deepEqual(metrics.snapshot().launchQueue, {
    depth: 0,
    peakDepth: 1,
    attempts: 1,
    failures: 0,
    totalMs: 25,
    maxMs: 25,
  });
});
