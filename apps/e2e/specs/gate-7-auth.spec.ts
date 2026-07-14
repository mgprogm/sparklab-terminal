/**
 * Gate 7: Auth enforcement — "unauthenticated is rejected".
 *
 * The harness's global gateway runs in open mode (no GATEWAY_AUTH_TOKEN), so
 * this spec swaps it for an AUTHED gateway on the same port (3907) using the
 * shared orphan-safe spawn helpers in helpers.ts. Same port matters: the
 * Next.js app's /api rewrite destination and its baked NEXT_PUBLIC_GATEWAY_URL
 * both point at 3907.
 *
 * Asserts, against the authed gateway:
 *   a. REST /api/sessions without a cookie -> 401.
 *   b. Login with wrong token -> 401 x5, then 429 with Retry-After on the 6th.
 *   c. /attach upgrade with a disallowed Origin -> refused pre-handshake (403).
 *   d. /attach with allowed Origin but no cookie -> handshake completes, JSON
 *      error frame, close code 4001 (the contractual no-reconnect code).
 *   e. UI journey: login screen shows, wrong token shows inline error, right
 *      token lands in the terminal shell, a browser keystroke echoes into the
 *      tmux pane, and a reload stays logged in (cookie persists).
 *
 * afterAll restores an open-mode gateway on 3907 — the alphabetically-later
 * strictmode-check.spec.ts depends on it.
 */
import { test, expect } from "@playwright/test";
import WebSocket from "ws";

import {
  GATEWAY_PORT,
  GATEWAY_URL,
  killGatewayListener,
  spawnOrphanGateway,
  tmux,
  waitForConnected,
  waitForShellReady,
  waitForTmuxContent,
} from "../helpers";

const AUTH_TOKEN = "gate7-secret-token";
// The browser origin the Next.js app serves from — must be allowlisted so the
// UI journey's direct WS (ws://localhost:3907/attach) passes the origin check.
const NEXT_ORIGIN = "http://localhost:3902";

// Gateway swaps use the shared orphan-safe helpers (stdio:"ignore" +
// detached + unref + TCP readiness probe) so replacements are never tied to
// this Playwright worker's stdio or teardown.

async function restartAuthedGateway(): Promise<void> {
  await killGatewayListener();
  await spawnOrphanGateway({
    GATEWAY_AUTH_TOKEN: AUTH_TOKEN,
    ALLOWED_ORIGINS: NEXT_ORIGIN,
  });
}

// ---------- ws helpers ----------

/** Open a raw WS upgrade with a given Origin; resolve with what happened. */
function attemptAttach(origin: string): Promise<{
  kind: "rejected" | "closed";
  statusCode?: number;
  closeCode?: number;
  errorFrame?: unknown;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${GATEWAY_PORT}/attach?session=web-gate7-probe`,
      { headers: { origin } },
    );
    let errorFrame: unknown;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("attach attempt timed out after 10s"));
    }, 10_000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      resolve({ kind: "rejected", statusCode: res.statusCode });
    });
    ws.on("message", (data) => {
      try {
        errorFrame = JSON.parse(data.toString("utf8"));
      } catch {
        // keystroke/binary frames are impossible here; ignore unparseable data
      }
    });
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve({ kind: "closed", closeCode: code, errorFrame });
    });
    ws.on("error", () => {
      // 'unexpected-response' or 'close' carries the assertion payload;
      // the accompanying error event alone is not a result.
    });
  });
}

// ---------- spec ----------

test.describe("Gate 7: Auth enforcement", () => {
  let sessionId: string | undefined;
  let nodeCookie: string | undefined;

  test.beforeAll(async () => {
    // Swap the open-mode webServer gateway for an authed one on the same port.
    await restartAuthedGateway();
  });

  test.afterAll(async () => {
    // Best-effort: kill the spec's tmux session via the authed API, then tmux.
    if (sessionId && nodeCookie) {
      await fetch(
        `${GATEWAY_URL}/api/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { cookie: nodeCookie },
        },
      ).catch(() => {});
    }
    if (sessionId) {
      await tmux(["kill-session", "-t", sessionId]).catch(() => {});
    }
    // Restore an OPEN-MODE gateway for the specs that run after this one.
    // NOTE: this replacement is owned by THIS worker; specs running in a
    // different worker (gate-8) must take ownership rather than reuse it,
    // because a worker's delayed teardown reaps gateways it spawned.
    await killGatewayListener();
    await spawnOrphanGateway();
  });

  test("a. REST /api/sessions without cookie is 401", async () => {
    const listRes = await fetch(`${GATEWAY_URL}/api/sessions`);
    expect(listRes.status).toBe(401);

    const createRes = await fetch(`${GATEWAY_URL}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createRes.status).toBe(401);
  });

  test("b. wrong-token login is 401, 6th attempt in a minute is 429 with Retry-After", async () => {
    const attempt = () =>
      fetch(`${GATEWAY_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "wrong-token" }),
      });

    for (let i = 1; i <= 5; i++) {
      const res = await attempt();
      expect(res.status, `attempt ${i} should be 401`).toBe(401);
    }

    const sixth = await attempt();
    expect(sixth.status).toBe(429);
    const retryAfter = Number(sixth.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  test("c. /attach upgrade with disallowed Origin is refused with 403", async () => {
    const result = await attemptAttach("http://evil.example");
    expect(result.kind).toBe("rejected");
    expect(result.statusCode).toBe(403);
  });

  test("d. /attach without cookie completes handshake, sends error frame, closes 4001", async () => {
    // Restart the authed gateway to reset the in-memory login rate-limit
    // window burned by test b (and prove auth state is process-local).
    await restartAuthedGateway();

    const result = await attemptAttach(NEXT_ORIGIN);
    expect(result.kind).toBe("closed");
    expect(result.closeCode).toBe(4001);
    expect(result.errorFrame).toEqual({
      type: "error",
      message: "unauthorized",
    });
  });

  test("e. UI journey: login screen, wrong token error, real login, echo, reload persists", async ({
    page,
  }) => {
    test.setTimeout(90_000);

    // Seed a session server-side: log in via Node fetch (no Origin header, so
    // the CSRF origin check does not apply) and create it with the cookie.
    const loginRes = await fetch(`${GATEWAY_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    expect(loginRes.status).toBe(204);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    nodeCookie = setCookie.split(";")[0];
    expect(nodeCookie).toMatch(/^gw_session=/);

    const createRes = await fetch(`${GATEWAY_URL}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: nodeCookie },
      body: JSON.stringify({ name: "gate7-auth-test" }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };
    sessionId = created.id;
    await waitForShellReady(sessionId);

    // Unauthenticated browser -> login screen.
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Access Token")).toBeVisible();

    // Wrong token -> inline error, still on the login screen.
    await page.locator("#access-token").fill("wrong-ui-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Invalid token.")).toBeVisible();

    // Correct token -> terminal shell with the seeded session listed.
    await page.locator("#access-token").fill(AUTH_TOKEN);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Access Token")).toHaveCount(0);
    await expect(page.locator(`text="gate7-auth-test"`).first()).toBeVisible();

    // Attach and prove a browser keystroke reaches the tmux session.
    await page.locator(`text="gate7-auth-test"`).first().click();
    await waitForConnected(page);
    await page.waitForTimeout(1500);
    await page
      .locator(".xterm-helper-textarea")
      .first()
      .focus()
      .catch(() => {});
    await page.keyboard.type("echo gate7_ui_ok");
    await page.keyboard.press("Enter");
    await waitForTmuxContent(sessionId, "gate7_ui_ok", 15_000);

    // Reload -> cookie persists, no login screen, straight to the shell.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`text="gate7-auth-test"`).first()).toBeVisible();
    await expect(page.getByText("Access Token")).toHaveCount(0);
  });
});
