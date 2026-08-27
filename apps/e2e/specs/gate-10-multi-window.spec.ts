/**
 * Gate 10: Multi-window terminal display.
 *
 * Covers docs/MULTI-WINDOW-PLAN.md §6's new-E2E bullet against the real FE
 * implementation (see docs/MULTI-WINDOW-DECISIONS.md, "Phase 2 (FE)"
 * section, for the exact selectors and deviations this spec relies on):
 *
 *   - Opening `cols-2` via the layout menu renders exactly two
 *     [data-testid="terminal-pane"] elements, each with a live,
 *     independently-attached xterm (single mode stays chrome-less — zero
 *     pane wrappers in the DOM, D10).
 *   - Two DIFFERENT sessions attached to the two panes are isolated:
 *     keystrokes typed into pane B's xterm reach ONLY session B's tmux pane
 *     — verified server-side via tmux capture-pane (house style: terminal
 *     content assertions never go through the xterm canvas/DOM, see
 *     helpers.ts), and asserted ABSENT from session A's pane too.
 *   - D4 (a session shown in one pane can't be picked into another) is
 *     enforced and IS visible in the UI at the per-pane level: the
 *     SessionPickerMenu in terminal-pane.tsx disables (`data-disabled`) and
 *     badges ("shown") any session already shown in another pane. (The
 *     top-level ⌘⇧O TerminalSwitcher was NOT updated to grey these out, per
 *     the FE decisions doc's noted follow-up — this gate only asserts the
 *     per-pane picker, which is what D4's enforcement actually lives in.)
 *   - Dragging the [role="separator"] divider visibly reflows both panes
 *     and, per D5, the underlying /attach WebSocket sees ZERO "resize"
 *     frames while the pointer is down and moving, and AT LEAST ONE after
 *     pointerup — not exactly one, since the split's onRatiosChange commit
 *     and xterm.tsx's own coalesced-flush effect can each independently
 *     fire a (harmless, idempotent) sendResize() in the same tick. This is
 *     asserted by listening to the REAL WebSocket traffic via Playwright's
 *     `page.on("websocket")` / `ws.on("framesent")` — connection.ts is
 *     deliberately left untouched (no dev-only `window.__resizeFrames`
 *     counter was needed; see docs/MULTI-WINDOW-DECISIONS.md, "Phase 3
 *     (BE) — testing notes").
 *   - Closing a pane out of `cols-2` downgrades to `single`
 *     (CLOSE_PANE_DOWNGRADE, §8 decision #5) and the DOM drops back to zero
 *     [data-testid="terminal-pane"] elements (D10), with the surviving
 *     session still cleanly, singly attached (tmux list-clients === 1,
 *     strictmode-check.spec.ts's pattern).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";

import {
  createSession,
  deleteSession,
  captureTmuxPane,
  tmuxListClients,
  waitForConnected,
  waitForShellReady,
  waitForTmuxContent,
} from "../helpers";

const SESSION_A_NAME = "gate10-pane-a";
const SESSION_B_NAME = "gate10-pane-b";
const DISTINCT_TEXT = "gate10_pane_b_only_9f3a";

/**
 * Open whichever session-picker trigger the pane currently shows — the
 * populated pane's "Change session" dropdown button, or an empty pane's
 * "Pick a session" button — and select `sessionName` from the (page-level,
 * portal-rendered) dropdown menu.
 */
async function assignSession(
  page: Page,
  pane: Locator,
  sessionName: string,
): Promise<void> {
  const changeButton = pane.locator('button[aria-label="Change session"]');
  if ((await changeButton.count()) > 0) {
    await changeButton.click();
  } else {
    await pane.getByRole("button", { name: "Pick a session" }).click();
  }
  await page.getByRole("menuitem", { name: sessionName }).click();
  await page.waitForTimeout(1000);
}

test.describe("Gate 10: Multi-window terminal display", () => {
  let sessionAId: string;
  let sessionBId: string;

  test.beforeAll(async () => {
    const a = await createSession(SESSION_A_NAME);
    const b = await createSession(SESSION_B_NAME);
    sessionAId = a.id;
    sessionBId = b.id;
    await waitForShellReady(sessionAId);
    await waitForShellReady(sessionBId);
  });

  test.afterAll(async () => {
    await deleteSession(sessionAId).catch(() => {});
    await deleteSession(sessionBId).catch(() => {});
  });

  test("cols-2: isolated panes, D4 disable, resize coalescing, close-pane downgrade", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // Count every "resize" frame sent on any real /attach WebSocket, for
    // the D5 assertion below. Attached before navigation so it can't miss
    // a pane's initial connect-time resize.
    const resizeFrameCount = { value: 0 };
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/attach")) return;
      ws.on("framesent", (frame) => {
        try {
          const raw =
            typeof frame.payload === "string"
              ? frame.payload
              : frame.payload.toString("utf8");
          const data = JSON.parse(raw) as { type?: string };
          if (data.type === "resize") resizeFrameCount.value += 1;
        } catch {
          // Binary keystroke frames aren't JSON text; ignore.
        }
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);

    // Default single mode: zero pane wrappers in the DOM (D10).
    await expect(page.locator('[data-testid="terminal-pane"]')).toHaveCount(0);

    // Select session A into the (single) focused pane first.
    await page.locator(`text="${SESSION_A_NAME}"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(1000);

    // Open the layout menu -> "Two columns" (cols-2).
    await page.getByRole("button", { name: "Terminal layout" }).click();
    await page.getByRole("menuitem", { name: "Two columns" }).click();

    const panes = page.locator('[data-testid="terminal-pane"]');
    await expect(panes).toHaveCount(2);
    const paneA = panes.nth(0);
    const paneB = panes.nth(1);

    // Explicitly attach the two DIFFERENT sessions — don't rely on
    // setLayoutMode's recentSessionIds auto-fill for either pane (pane 1 is
    // almost certainly empty at this point: the only id ever clicked is A,
    // already claimed by pane 0, so auto-fill has nothing left to give it).
    await assignSession(page, paneA, SESSION_A_NAME);
    await assignSession(page, paneB, SESSION_B_NAME);
    await expect(paneA).toContainText(SESSION_A_NAME);
    await expect(paneB).toContainText(SESSION_B_NAME);
    await page.waitForTimeout(1500);

    // NOW both panes hold a live, independently-attached xterm.
    await expect(paneA.locator(".xterm-helper-textarea")).toHaveCount(1);
    await expect(paneB.locator(".xterm-helper-textarea")).toHaveCount(1);

    // --- D4: a session shown in one pane can't be picked into another ---
    // Re-open pane B's picker; session A (shown in pane A) must render
    // disabled with a "shown" badge, not merely go unclicked.
    await paneB.locator('button[aria-label="Change session"]').click();
    const disabledItem = page.getByRole("menuitem", { name: SESSION_A_NAME });
    await expect(disabledItem).toHaveAttribute("data-disabled", "");
    await expect(disabledItem).toContainText("shown");
    await page.keyboard.press("Escape");

    // --- Isolation: typing into pane B reaches ONLY session B's tmux ---
    await paneB.locator(".xterm").first().click();
    await page.keyboard.type(`echo ${DISTINCT_TEXT}`);
    await page.keyboard.press("Enter");
    await waitForTmuxContent(sessionBId, DISTINCT_TEXT, 15_000);
    const paneAPaneContent = await captureTmuxPane(sessionAId);
    expect(paneAPaneContent).not.toContain(DISTINCT_TEXT);

    // --- D5: divider drag coalesces resize frames ---
    const separator = page.locator('[role="separator"]');
    await expect(separator).toHaveCount(1);
    const sepBox = await separator.boundingBox();
    if (!sepBox) throw new Error("separator has no bounding box");
    const boxABefore = await paneA.boundingBox();
    if (!boxABefore) throw new Error("pane A has no bounding box");

    // Sanity: the listener is actually wired (each pane's connect-time
    // resize, plus the two session assignments, guarantee this is nonzero
    // by now) — so a later `toBe(0)`/`toBeGreaterThan` failure means an
    // actual coalescing bug, not a dead WS listener.
    expect(
      resizeFrameCount.value,
      "no resize frames observed at all — WS listener not wired",
    ).toBeGreaterThan(0);

    const startX = sepBox.x + sepBox.width / 2;
    const startY = sepBox.y + sepBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    const beforeMove = resizeFrameCount.value;
    // Several incremental moves, like a real drag.
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(startX + i * 25, startY, { steps: 3 });
      await page.waitForTimeout(30);
    }
    // Zero resize frames sent while the pointer is still down and moving.
    expect(resizeFrameCount.value).toBe(beforeMove);
    await page.mouse.up();
    // Let the drag-end rAF flush (fit() + sendResize()) land.
    await page.waitForTimeout(600);
    // At least one resize frame after pointerup — D5's actual guarantee,
    // NOT exactly one (see file header comment).
    expect(resizeFrameCount.value).toBeGreaterThan(beforeMove);

    // Both panes visibly reflowed.
    const boxAAfter = await paneA.boundingBox();
    if (!boxAAfter) throw new Error("pane A has no bounding box after drag");
    expect(Math.abs(boxAAfter.width - boxABefore.width)).toBeGreaterThan(50);

    // --- Close pane B: downgrades cols-2 -> single (D10) ---
    await paneB.locator('button[aria-label="Close pane"]').click();
    await expect(page.locator('[data-testid="terminal-pane"]')).toHaveCount(0);
    // The surviving pane (session A) is still cleanly, singly attached.
    // Poll rather than sleep-then-check: per the FE decisions doc, a
    // layout-mode change remounts the affected xterm(s) (different tree
    // shape, D10 bare-fragment vs. chrome-wrapped), so closing pane B tears
    // down and re-attaches A's pty — a fixed sleep would race that.
    await expect
      .poll(() => tmuxListClients(sessionAId), { timeout: 15_000 })
      .toBe(1);
  });
});
