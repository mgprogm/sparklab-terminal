/**
 * Gate 8: Scrollback restore on reconnect (Phase 3 B1).
 *
 * Runs against an open-mode gateway like gates 2-6 — but spawns its OWN in
 * beforeAll (see there): this file runs in a separate worker, and gateways
 * spawned by a previous worker die with that worker's delayed teardown.
 *
 * Asserts:
 *   a. REST: GET /api/sessions/:id/scrollback returns history (early `seq`
 *      lines present), the `lines` param clamps sanely (0 -> 1, huge -> 10000,
 *      garbage -> default), and a bogus id is 404. The capture uses `-E -1`,
 *      so the response is history ONLY — the visible screen is excluded.
 *   b. UI: after a hard reload the client injects fetched scrollback behind
 *      tmux's attach redraw. Scrolling the terminal up (Shift+PageUp) must
 *      reveal an early line ("42") that is NOT on the visible tmux screen.
 *   c. Regression (gate-5 with scrollback active): vim still redraws cleanly
 *      after reload — tildes visible, no seq history stacked into the
 *      viewport.
 *
 * Renderer note: xterm.tsx prefers the WebGL renderer, which draws to canvas
 * and leaves no readable text in the DOM. This file disables WebGL at browser
 * launch (worker-scoped test.use, serial suite so no parallelism impact) to
 * force xterm's DOM renderer, making `.xterm-rows` text assertable.
 *
 * Race note (accepted in the design): if the first binary frame beats the
 * scrollback fetch, attach proceeds WITHOUT history. The UI test waits for a
 * settle period after connect before scrolling; a consistent failure to find
 * history here means the fetch always loses the race — a product bug, not a
 * flake to retry away.
 */
import { test, expect, type Page } from "@playwright/test";

import {
  GATEWAY_URL,
  createSession,
  deleteSession,
  captureTmuxPane,
  killGatewayListener,
  spawnOrphanGateway,
  tmuxSendKeys,
  waitForConnected,
  waitForShellReady,
  waitForTmuxContent,
} from "../helpers";

const EARLY_LINE = "42";

// Force xterm's DOM renderer (see renderer note above).
test.use({
  launchOptions: { args: ["--disable-webgl", "--disable-webgl2"] },
});

/** Read the visible xterm viewport rows as trimmed text lines. */
async function readXtermRows(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".xterm-rows > div")).map((row) =>
      (row.textContent ?? "").replace(/ /g, " ").trim(),
    ),
  );
}

/** Scroll the terminal up page-by-page until a row matches, or give up. */
async function scrollUpUntilRow(
  page: Page,
  exact: string,
  maxPages = 35,
): Promise<boolean> {
  for (let i = 0; i < maxPages; i++) {
    const rows = await readXtermRows(page);
    if (rows.includes(exact)) return true;
    await page.keyboard.press("Shift+PageUp");
    await page.waitForTimeout(150);
  }
  return (await readXtermRows(page)).includes(exact);
}

test.describe("Gate 8: Scrollback restore", () => {
  let sessionId: string;

  test.beforeAll(async () => {
    // Take OWNERSHIP of the gateway. This file's test.use(launchOptions)
    // forces a separate worker; the open-mode gateway inherited from gate-7's
    // afterAll belongs to the PREVIOUS worker, whose delayed teardown reaps
    // it a few seconds into this file (observed as: 8a green, then the
    // gateway vanishing mid-8b). A conditional "spawn only if the port is
    // down" probe races that delayed reap, so unconditionally replace the
    // listener with a gateway owned by THIS worker.
    await killGatewayListener();
    await spawnOrphanGateway();

    const session = await createSession("scrollback-test");
    sessionId = session.id;
    await waitForShellReady(sessionId);
    // Fill the session's history: 500 numbered lines. The visible 24-row
    // screen ends around 477-500; everything earlier (incl. "42") is history.
    await tmuxSendKeys(sessionId, "seq 1 500");
    await waitForTmuxContent(sessionId, "500", 15_000);
  });

  test.afterAll(async () => {
    // Quit vim if test c left it open, then delete the session.
    await tmuxSendKeys(sessionId, "Escape", false).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await tmuxSendKeys(sessionId, ":q!").catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    await deleteSession(sessionId).catch(() => {});
    // Our open-mode gateway on 3907 IS the state every other spec expects —
    // leave it listening (suite-level hygiene reaps it after the run).
  });

  test("a. REST scrollback returns history, clamps lines, 404s bogus ids", async () => {
    const base = `${GATEWAY_URL}/api/sessions/${encodeURIComponent(sessionId)}/scrollback`;

    // Default (2000): early line present as its own line; the visible screen
    // (tail of seq + prompt) is excluded by -E -1.
    const res = await fetch(base);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: string };
    expect(typeof body.lines).toBe("string");
    expect(new RegExp(`^${EARLY_LINE}$`, "m").test(body.lines)).toBe(true);

    // lines=1 -> exactly one history line (the one just above the screen).
    const one = await fetch(`${base}?lines=1`);
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { lines: string };
    expect(oneBody.lines.trim().split("\n")).toHaveLength(1);

    // lines=0 clamps up to 1 -> still a single line, still 200.
    const zero = await fetch(`${base}?lines=0`);
    expect(zero.status).toBe(200);
    const zeroBody = (await zero.json()) as { lines: string };
    expect(zeroBody.lines.trim().split("\n")).toHaveLength(1);

    // Huge value clamps down to 10000 -> 200 with full history.
    const huge = await fetch(`${base}?lines=999999`);
    expect(huge.status).toBe(200);
    const hugeBody = (await huge.json()) as { lines: string };
    expect(new RegExp(`^${EARLY_LINE}$`, "m").test(hugeBody.lines)).toBe(true);

    // Garbage value falls back to the default -> 200 with history.
    const garbage = await fetch(`${base}?lines=abc`);
    expect(garbage.status).toBe(200);
    const garbageBody = (await garbage.json()) as { lines: string };
    expect(new RegExp(`^${EARLY_LINE}$`, "m").test(garbageBody.lines)).toBe(
      true,
    );

    // Bogus ids: well-formed-but-missing and malformed both 404.
    const missing = await fetch(
      `${GATEWAY_URL}/api/sessions/web-does-not-exist/scrollback`,
    );
    expect(missing.status).toBe(404);
    const malformed = await fetch(
      `${GATEWAY_URL}/api/sessions/bogus/scrollback`,
    );
    expect(malformed.status).toBe(404);
  });

  test("b. UI: history is scrollable after a hard reload", async ({ page }) => {
    test.setTimeout(90_000);

    // Sanity: the early line must NOT be on the visible tmux screen — the
    // only way it can reach the browser is via the scrollback injection.
    const pane = await captureTmuxPane(sessionId);
    expect(new RegExp(`^${EARLY_LINE}$`, "m").test(pane)).toBe(false);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.locator(`text="scrollback-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(1500);

    // Hard reload -> reconnect -> reset + scrollback injection + redraw.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.locator(`text="scrollback-test"`).first().click();
    await waitForConnected(page);
    // Settle: let the first frame + injected history land.
    await page.waitForTimeout(2500);

    // The viewport (before scrolling) shows the live screen, not history.
    const viewportRows = await readXtermRows(page);
    expect(viewportRows).not.toContain(EARLY_LINE);

    // Scroll up: the injected history must contain the early line. A miss
    // here after a clean reload means scrollback lost the fetch-vs-frame
    // race (or was never injected) — report as a product bug, do not retry.
    await page.locator(".xterm").first().click();
    const found = await scrollUpUntilRow(page, EARLY_LINE);
    expect(
      found,
      `line "${EARLY_LINE}" not found in xterm buffer after scrolling up — scrollback was not injected`,
    ).toBe(true);
  });

  test("c. regression: vim redraw stays clean with scrollback active", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.locator(`text="scrollback-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(1500);

    // Open vim on top of a session that has scrollback history.
    await tmuxSendKeys(sessionId, "vim");
    await new Promise((r) => setTimeout(r, 3000));
    let pane = await captureTmuxPane(sessionId);
    expect(
      pane.split("\n").filter((l) => l.trim() === "~").length,
    ).toBeGreaterThan(0);

    // Reload: attach redraw + scrollback injection must not stack.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.locator(`text="scrollback-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(3000);

    // tmux still shows vim (gate-5 invariant).
    pane = await captureTmuxPane(sessionId);
    expect(
      pane.split("\n").filter((l) => l.trim() === "~").length,
    ).toBeGreaterThan(0);

    // The xterm VIEWPORT shows vim, not seq history: tilde rows present, and
    // no bare-number rows (seq output) leaked into the visible screen — that
    // would be the double-draw/stacking failure the design doc warns about.
    const rows = await readXtermRows(page);
    expect(rows.filter((r) => r === "~").length).toBeGreaterThan(0);
    expect(rows.filter((r) => /^\d+$/.test(r))).toHaveLength(0);
  });
});
