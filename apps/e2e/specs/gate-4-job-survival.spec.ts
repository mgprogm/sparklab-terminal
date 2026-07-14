/**
 * Gate 4: Job survival across page close.
 *
 * Start a counting job, close the page, wait, reopen, and assert the
 * counter has advanced and continues live.
 */
import { test, expect } from "@playwright/test";

import {
  createSession,
  deleteSession,
  waitForConnected,
  waitForShellReady,
  tmuxSendKeys,
  captureTmuxPane,
  waitForTmuxContent,
} from "../helpers";

test.describe("Gate 4: Job survival across page close", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await createSession("survival-test");
    sessionId = session.id;
    await waitForShellReady(sessionId);
  });

  test.afterAll(async () => {
    // Kill the counting job first
    await tmuxSendKeys(sessionId, "C-c", false).catch(() => {});
    await deleteSession(sessionId).catch(() => {});
  });

  test("job keeps running after page close and resumes live on reopen", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await page.locator(`text="survival-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(2000);

    // Start a counting job via tmux send-keys
    await tmuxSendKeys(
      sessionId,
      "for i in $(seq 1 999); do echo tick_$i; sleep 1; done",
    );

    // Wait until we see an early tick
    await waitForTmuxContent(sessionId, "tick_3", 15_000);

    // Close the page
    await page.close();

    // Wait 5 seconds with the page closed
    await new Promise((r) => setTimeout(r, 5000));

    // Capture tick count while page is closed (job should still be running)
    const paneBeforeReopen = await captureTmuxPane(sessionId);
    const ticksBefore = paneBeforeReopen
      .split("\n")
      .filter((l) => l.match(/tick_\d+/))
      .map((l) => {
        const m = l.match(/tick_(\d+)/);
        return m ? Number(m[1]) : 0;
      });
    const maxTickBefore = Math.max(...ticksBefore, 0);
    // Should have advanced past tick_3 during the 5s wait
    expect(maxTickBefore).toBeGreaterThan(3);

    // Reopen in a new page
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.waitForLoadState("networkidle");
    await page2.waitForTimeout(3000);

    await page2.locator(`text="survival-test"`).first().click();
    await waitForConnected(page2);

    // Wait for the counter to advance further
    await new Promise((r) => setTimeout(r, 3000));
    const paneAfterReopen = await captureTmuxPane(sessionId);
    const ticksAfter = paneAfterReopen
      .split("\n")
      .filter((l) => l.match(/tick_\d+/))
      .map((l) => {
        const m = l.match(/tick_(\d+)/);
        return m ? Number(m[1]) : 0;
      });
    const maxTickAfter = Math.max(...ticksAfter, 0);

    // Counter should have advanced since the page was closed
    expect(maxTickAfter).toBeGreaterThan(maxTickBefore);

    await page2.close();
  });
});
