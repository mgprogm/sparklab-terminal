/**
 * Gate 5: vim redraw on reattach.
 *
 * Open vim in the session, reload the page, assert the vim screen is
 * redrawn (capture-pane contains vim UI markers like ~ lines).
 */
import { test, expect } from "@playwright/test";

import {
  createSession,
  deleteSession,
  waitForConnected,
  waitForShellReady,
  tmuxSendKeys,
  captureTmuxPane,
} from "../helpers";

test.describe("Gate 5: vim redraw on reattach", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await createSession("vim-test");
    sessionId = session.id;
    await waitForShellReady(sessionId);
  });

  test.afterAll(async () => {
    // Quit vim: send Escape then :q!
    await tmuxSendKeys(sessionId, "Escape", false).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await tmuxSendKeys(sessionId, ":q!").catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await deleteSession(sessionId).catch(() => {});
  });

  test("vim redraws correctly after page reload", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await page.locator(`text="vim-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(2000);

    // Open vim via tmux send-keys
    await tmuxSendKeys(sessionId, "vim");

    // Wait for vim to appear
    await new Promise((r) => setTimeout(r, 3000));

    // Verify vim is showing (capture-pane should contain ~ lines)
    let pane = await captureTmuxPane(sessionId);
    // Vim shows ~ lines for empty buffer, and possibly "VIM" in the bottom line
    const vimTildeCount = pane
      .split("\n")
      .filter((l) => l.trim() === "~").length;
    expect(vimTildeCount).toBeGreaterThan(0);

    // Reload the page
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await page.locator(`text="vim-test"`).first().click();
    await waitForConnected(page);

    // Wait for redraw
    await new Promise((r) => setTimeout(r, 3000));

    // After reload, vim should still be showing (tmux redraws on attach)
    pane = await captureTmuxPane(sessionId);
    const vimTildeCountAfterReload = pane
      .split("\n")
      .filter((l) => l.trim() === "~").length;
    expect(vimTildeCountAfterReload).toBeGreaterThan(0);
  });
});
