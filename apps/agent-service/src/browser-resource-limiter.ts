import { config } from "./config.js";

/** Process-wide bounds for Chromium trees and expensive concurrent launches. */
export class BrowserResourceLimiter {
  private sessions = 0;
  private launches = 0;
  private launchWaiters: Array<() => void> = [];

  constructor(
    private readonly maxSessions: number,
    private readonly maxLaunches: number,
  ) {}

  reserveSession(): () => void {
    if (this.sessions >= this.maxSessions)
      throw new Error("browser_session_limit_reached");
    this.sessions++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sessions--;
    };
  }

  async acquireLaunch(): Promise<() => void> {
    if (this.launches >= this.maxLaunches) {
      await new Promise<void>((resolve) => this.launchWaiters.push(resolve));
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

  snapshot(): { activeSessions: number; activeLaunches: number } {
    return { activeSessions: this.sessions, activeLaunches: this.launches };
  }
}

export const browserResources = new BrowserResourceLimiter(
  config.browser.maxSessions,
  config.browser.maxConcurrentLaunches,
);
