/**
 * Gate 9: a scheduled Agent Chat action.
 *
 * The UI talks to a deterministic WebSocket agent fixture; approval and the
 * timer itself remain real. The fixture posts to the real gateway, which must
 * persist the action and send Enter to the real tmux session at its due time.
 */
import { expect, test } from "@playwright/test";

import {
  GATEWAY_URL,
  createSession,
  deleteSession,
  waitForConnected,
  waitForShellReady,
  waitForTmuxContent,
} from "../helpers";

test.describe("Gate 9: scheduled terminal action", () => {
  let sessionId: string;
  let tmuxSessionId: string;

  test.beforeAll(async () => {
    const session = await createSession("scheduled-action-e2e");
    sessionId = session.id;
    tmuxSessionId = sessionId.includes("/")
      ? sessionId.slice(sessionId.indexOf("/") + 1)
      : sessionId;
    await waitForShellReady(tmuxSessionId);
  });

  test.afterAll(async () => {
    await deleteSession(sessionId).catch(() => {});
  });

  test("requires approval, then presses Enter at the scheduled time", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByText("scheduled-action-e2e", { exact: true }).click();
    await waitForConnected(page);

    // Enter is the scheduled action. Leave this literal text pending in the
    // shell so the test can prove the timer, rather than the test harness,
    // executed it.
    const typed = await fetch(
      `${GATEWAY_URL}/api/sessions/${encodeURIComponent(sessionId)}/keys`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "echo scheduled-action-fired" }),
      },
    );
    expect(typed.status).toBe(204);

    await page.getByRole("button", { name: /Open agent chat/ }).click();
    const composer = page.getByPlaceholder("Ask the agent…");
    await expect(composer).toBeEnabled();
    await composer.fill("Schedule Enter for this terminal shortly.");
    await page.getByRole("button", { name: "Send" }).click();

    const approval = page.getByRole("group", { name: "Approval needed" });
    await expect(approval).toContainText("schedule in");
    await expect(approval).toContainText("⏎");
    await expect(approval).toContainText(
      "Scheduled terminal actions are approved one at a time.",
    );
    await expect(approval.getByText("Auto-approve")).toHaveCount(0);
    await approval.getByRole("button", { name: "Approve ⏎" }).click();

    await expect(page.getByText("Enter has been scheduled.")).toBeVisible();
    await expect(page.getByText("⌨ approved", { exact: true })).toBeVisible();
    await waitForTmuxContent(tmuxSessionId, "scheduled-action-fired");
  });
});
