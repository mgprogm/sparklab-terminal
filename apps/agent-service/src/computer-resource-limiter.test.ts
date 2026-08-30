import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
const { ComputerResourceLimiter } =
  await import("./computer-resource-limiter.js");
const { ComputerPerformanceMetrics } =
  await import("./computer-performance-metrics.js");

test("computer resource limiter bounds desktops and serializes launches", async () => {
  let now = 100;
  const metrics = new ComputerPerformanceMetrics();
  const limiter = new ComputerResourceLimiter(2, 1, metrics, () => now);

  const releaseA = limiter.reserveSession();
  const releaseB = limiter.reserveSession();
  assert.throws(() => limiter.reserveSession(), /cua_desktop_limit_reached/);

  const releaseFirstLaunch = await limiter.acquireLaunch();
  let secondStarted = false;
  const second = limiter.acquireLaunch().then((release) => {
    secondStarted = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(secondStarted, false, "2nd launch waits for the 1st to finish");
  assert.equal(metrics.snapshot().launchQueue.depth, 1);

  now = 130;
  releaseFirstLaunch();
  const releaseSecondLaunch = await second;
  assert.equal(secondStarted, true);
  releaseSecondLaunch();

  releaseA();
  releaseB();
  releaseB(); // double-release is a no-op
  assert.deepEqual(limiter.snapshot(), {
    activeDesktops: 0,
    activeLaunches: 0,
  });
  assert.deepEqual(metrics.snapshot().launchQueue, {
    depth: 0,
    peakDepth: 1,
    attempts: 1,
    failures: 0,
    totalMs: 30,
    maxMs: 30,
  });
});

test("reserveSession release is idempotent and frees exactly one slot", () => {
  const limiter = new ComputerResourceLimiter(1, 1);
  const release = limiter.reserveSession();
  assert.throws(() => limiter.reserveSession(), /cua_desktop_limit_reached/);
  release();
  release(); // no double-decrement
  const again = limiter.reserveSession();
  assert.deepEqual(limiter.snapshot(), {
    activeDesktops: 1,
    activeLaunches: 0,
  });
  again();
});
