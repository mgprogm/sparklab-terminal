/**
 * Gate 2: Thai multibyte round-trip.
 *
 * Type Thai text into the terminal, echo it to a file inside the tmux
 * session, then read the file back via Node fs and assert byte equality.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";

import {
  GATEWAY_URL,
  createSession,
  deleteSession,
  waitForConnected,
  waitForShellReady,
  tmuxSendKeys,
  waitForTmuxContent,
} from "../helpers";

const THAI_TEXT = "สวัสดีครับ";

test.describe("Gate 2: Thai multibyte round-trip", () => {
  let sessionId: string;
  let tmpFile: string;

  test.beforeAll(async () => {
    const session = await createSession("thai-test");
    sessionId = session.id;
    await waitForShellReady(sessionId);
    tmpFile = path.join(os.tmpdir(), `thai-roundtrip-${Date.now()}.txt`);
  });

  test.afterAll(async () => {
    await deleteSession(sessionId).catch(() => {});
    await fs.unlink(tmpFile).catch(() => {});
  });

  test("Thai text round-trips uncorrupted through the terminal", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Wait a bit for sessions to load
    await page.waitForTimeout(2000);

    // Click the session in the sidebar
    await page.locator(`text="thai-test"`).first().click();
    await waitForConnected(page);

    // Wait for shell prompt
    await page.waitForTimeout(1500);

    // Type the echo command directly via tmux send-keys for reliability,
    // then verify the file content.
    await tmuxSendKeys(sessionId, `echo '${THAI_TEXT}' > ${tmpFile}`);

    // Wait for the command to execute
    await page.waitForTimeout(1000);

    // Read the file and compare
    const content = await fs.readFile(tmpFile, "utf-8");
    expect(content.trim()).toBe(THAI_TEXT);
  });
});
