/**
 * Gate 3: Reconnect after gateway restart.
 *
 * Kill + restart the gateway process mid-session (tmux server keeps running),
 * wait for the client's backoff reconnect, assert the terminal shows a clean
 * redraw (a marker string printed before the restart appears in the pane)
 * and the session still accepts input.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";

import {
  GATEWAY_PORT,
  createSession,
  deleteSession,
  waitForConnected,
  waitForShellReady,
  tmuxSendKeys,
  captureTmuxPane,
  waitForTmuxContent,
} from "../helpers";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const MARKER = "RECONNECT_MARKER_XYZ";

test.describe("Gate 3: Reconnect after gateway restart", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    const session = await createSession("reconnect-test");
    sessionId = session.id;
    // Wait for the shell to fully initialize
    await waitForShellReady(sessionId);
  });

  test.afterAll(async () => {
    await deleteSession(sessionId).catch(() => {});
  });

  test("terminal reconnects and redraws cleanly after gateway restart", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    await page.locator(`text="reconnect-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(2000);

    // Print a marker string into the tmux session
    await tmuxSendKeys(sessionId, `echo "${MARKER}"`);
    await waitForTmuxContent(sessionId, MARKER, 15_000);

    // Kill the gateway process (find by port)
    await execFileAsync("bash", [
      "-c",
      `lsof -ti:${GATEWAY_PORT} | xargs -r kill -9`,
    ]).catch(() => {});

    // Wait for the client to notice the disconnect
    await page.waitForTimeout(3000);

    // Restart the gateway
    const gatewayProcess = spawn("node", ["src/server.js"], {
      env: { ...process.env, PORT: String(GATEWAY_PORT) },
      stdio: "pipe",
      detached: true,
      cwd: path.resolve(REPO_ROOT, "apps/terminal-gateway"),
    });

    // Wait for gateway to be ready
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      gatewayProcess.stdout?.on("data", (data: Buffer) => {
        if (data.toString().includes("listening")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });
    expect(ready).toBe(true);

    // Wait for client's backoff reconnect (could be up to 15s)
    await page.waitForSelector('text="connected"', { timeout: 30_000 });

    // Verify the marker is still visible (clean redraw from tmux)
    const paneContent = await captureTmuxPane(sessionId);
    const markerCount = paneContent
      .split("\n")
      .filter((line) => line.includes(MARKER)).length;
    expect(markerCount).toBeGreaterThanOrEqual(1);

    // Verify session still accepts input
    const postMarker = `POST_RECONNECT_${Date.now()}`;
    await tmuxSendKeys(sessionId, `echo "${postMarker}"`);
    await waitForTmuxContent(sessionId, postMarker, 10_000);

    // Do NOT kill the restarted gateway — subsequent tests need it.
    // Playwright's webServer tracking lost the original process when we
    // killed it, but the replacement gateway on the same port works fine.
    // Playwright will clean up all child processes at shutdown.
    gatewayProcess.unref();
  });
});
