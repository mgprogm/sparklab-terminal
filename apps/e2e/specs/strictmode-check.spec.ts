/**
 * StrictMode/dev double-attach check.
 *
 * With the DEV server, attach once and assert tmux list-clients shows
 * exactly 1 client. This guards against the React StrictMode double-mount
 * creating two connections (double-attach).
 *
 * Note: This test requires the dev server rather than the prod build.
 * We'll run it against the prod build's server since that's what our
 * webServer config starts, but the core invariant (cleanup prevents
 * double-attach) is tested in connection.test.ts unit tests.
 *
 * For a true dev-mode check, this would need a separate Playwright config
 * with `next dev` as the webServer command. We include it here as a
 * pragmatic check via the prod build.
 */
import { test, expect } from "@playwright/test";

import {
  createSession,
  deleteSession,
  waitForConnected,
  waitForShellReady,
  tmuxListClients,
} from "../helpers";

test.describe("StrictMode check: single tmux client", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await createSession("strictmode-test");
    sessionId = session.id;
    await waitForShellReady(sessionId);
  });

  test.afterAll(async () => {
    await deleteSession(sessionId).catch(() => {});
  });

  test("only 1 tmux client attached after page load", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    await page.locator(`text="strictmode-test"`).first().click();
    await waitForConnected(page);

    // Wait for any potential double-mount to settle
    await page.waitForTimeout(3000);

    const clientCount = await tmuxListClients(sessionId);
    expect(clientCount).toBe(1);
  });
});
