import { config } from "./config.js";
import {
  computerPerformanceMetrics,
  type ComputerPerformanceMetrics,
} from "./computer-performance-metrics.js";

/**
 * Process-wide bounds for disposable CUA desktops — a near-verbatim copy of
 * `browser-resource-limiter.ts`. `reserveSession()` is the hard cap (throws
 * `cua_desktop_limit_reached`); `acquireLaunch()` is a bounded-concurrency queue
 * so N simultaneous cold `docker run` + X-readiness + driver-spawn sequences on
 * one Docker daemon don't stampede. See docs/VIRTUAL-COMPUTER-REMAINING.md M2.2.
 */
export class ComputerResourceLimiter {
  private desktops = 0;
  private launches = 0;
  private launchWaiters: Array<() => void> = [];

  constructor(
    private readonly maxDesktops: number,
    private readonly maxLaunches: number,
    private readonly metrics: ComputerPerformanceMetrics = computerPerformanceMetrics,
    private readonly now: () => number = Date.now,
  ) {}

  reserveSession(): () => void {
    if (this.desktops >= this.maxDesktops)
      throw new Error("cua_desktop_limit_reached");
    this.desktops++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.desktops--;
    };
  }

  async acquireLaunch(): Promise<() => void> {
    if (this.launches >= this.maxLaunches) {
      const queuedAt = this.now();
      this.metrics.launchQueued();
      await new Promise<void>((resolve) => this.launchWaiters.push(resolve));
      this.metrics.launchDequeued(this.now() - queuedAt);
    } else {
      this.launches++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.launchWaiters.shift();
      if (next) next();
      else this.launches--;
    };
  }

  snapshot(): { activeDesktops: number; activeLaunches: number } {
    return { activeDesktops: this.desktops, activeLaunches: this.launches };
  }
}

export const computerResources = new ComputerResourceLimiter(
  config.cua.maxDesktops,
  config.cua.maxLaunches,
);
