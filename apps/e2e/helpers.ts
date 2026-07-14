/**
 * Shared helpers for E2E specs.
 *
 * All terminal-content assertions go through tmux (capture-pane, display,
 * list-clients, etc.) — never through xterm's canvas/DOM rendering.
 */
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const execFileAsync = promisify(execFile);

export const GATEWAY_PORT = 3907;
export const NEXT_PORT = 3902;
export const BASE_URL = `http://localhost:${NEXT_PORT}`;
export const GATEWAY_URL = `http://localhost:${GATEWAY_PORT}`;

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.resolve(HELPERS_DIR, "../..", "apps/terminal-gateway");

// ---------- gateway lifecycle helpers (gate-7 / gate-8) ----------
//
// Specs that swap the gateway must spawn replacements that are fully
// decoupled from the Playwright worker that spawned them:
// - stdio: "ignore" — piped stdio ties the child to the worker and readiness
//   parsing of stdout is then impossible after the worker rotates; readiness
//   is a TCP probe instead.
// - detached + unref — own process group, no handle keeping the worker alive.
// Even so, a worker's delayed teardown has been observed to reap gateways it
// spawned (~5s after worker rotation). Specs running in a DIFFERENT worker
// must therefore take ownership: kill the inherited listener and spawn their
// own (see gate-8), rather than probe-and-reuse.

/** True when something is accepting TCP connections on the port. */
export function isPortAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

/**
 * Kill whatever LISTENS on GATEWAY_PORT, and WAIT until the port actually
 * stops accepting. -sTCP:LISTEN is load-bearing: a bare `lsof -ti:PORT` also
 * matches CLIENT sockets — including the Playwright worker's own undici
 * keep-alive connections — and kill -9 would take the worker itself down.
 *
 * The wait is equally load-bearing: kill -9 returns before the kernel tears
 * down the victim's listen socket. Spawning a replacement in that window
 * makes it crash with EADDRINUSE while the readiness probe happily connects
 * to the DYING listener — "ready" flips to a dead port moments later
 * (observed as ECONNRESET/ECONNREFUSED on the first WS attach in gate-7d).
 */
export async function killGatewayListener(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    await execFileAsync("bash", [
      "-c",
      `lsof -ti tcp:${GATEWAY_PORT} -sTCP:LISTEN | xargs -r kill -9`,
    ]).catch(() => {});
    if (!(await isPortAccepting(GATEWAY_PORT))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `port ${GATEWAY_PORT} still accepting 10s after killing its listener`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Spawn a gateway on GATEWAY_PORT and wait until it accepts connections.
 * `extraEnv` supplies auth mode (GATEWAY_AUTH_USER + GATEWAY_AUTH_PASSWORD,
 * ALLOWED_ORIGINS); open mode otherwise (all auth vars stripped —
 * GATEWAY_AUTH_TOKEN included, since the gateway hard-fails on the legacy var).
 */
export async function spawnOrphanGateway(
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(GATEWAY_PORT),
  };
  delete env.GATEWAY_AUTH_TOKEN;
  delete env.GATEWAY_AUTH_USER;
  delete env.GATEWAY_AUTH_PASSWORD;
  delete env.GATEWAY_AUTH_PASSWORD_HASH;
  delete env.ALLOWED_ORIGINS;
  Object.assign(env, extraEnv);
  const child = spawn("node", ["src/server.js"], {
    env,
    stdio: "ignore",
    detached: true,
    cwd: GATEWAY_DIR,
  });
  child.unref();
  // A child that dies before becoming ready (EADDRINUSE against a
  // half-dead predecessor, fatal config) must fail the spec loudly — the
  // TCP probe alone can't tell "our gateway is ready" from "some other
  // listener answered". killGatewayListener() waiting for port release
  // prevents the EADDRINUSE case; this catches anything else.
  let exited: number | null = null;
  child.on("exit", (code) => {
    exited = code ?? -1;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new Error(
        `gateway on port ${GATEWAY_PORT} exited with code ${String(exited)} before accepting connections`,
      );
    }
    if (await isPortAccepting(GATEWAY_PORT)) return child.pid ?? -1;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `gateway on port ${GATEWAY_PORT} did not accept connections within 15s`,
  );
}

// ---------- tmux helpers ----------

export async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trim();
}

export async function captureTmuxPane(sessionName: string): Promise<string> {
  return tmux(["capture-pane", "-t", sessionName, "-p"]);
}

export async function tmuxWindowWidth(sessionName: string): Promise<number> {
  const out = await tmux([
    "display",
    "-t",
    sessionName,
    "-p",
    "#{window_width}",
  ]);
  return Number(out);
}

export async function tmuxWindowHeight(sessionName: string): Promise<number> {
  const out = await tmux([
    "display",
    "-t",
    sessionName,
    "-p",
    "#{window_height}",
  ]);
  return Number(out);
}

export async function tmuxListClients(sessionName: string): Promise<number> {
  try {
    const out = await tmux(["list-clients", "-t", sessionName]);
    if (!out.trim()) return 0;
    return out.trim().split("\n").length;
  } catch {
    return 0;
  }
}

export async function tmuxSendKeys(
  sessionName: string,
  keys: string,
  enter = true,
): Promise<void> {
  const args = ["send-keys", "-t", sessionName, keys];
  if (enter) args.push("Enter");
  await tmux(args);
}

// ---------- REST helpers (talk directly to gateway) ----------

export async function createSession(name?: string): Promise<{
  id: string;
  name: string;
  createdAt: number;
}> {
  const res = await fetch(`${GATEWAY_URL}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return (await res.json()) as { id: string; name: string; createdAt: number };
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`${GATEWAY_URL}/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function listSessions(): Promise<
  Array<{ id: string; name: string }>
> {
  const res = await fetch(`${GATEWAY_URL}/api/sessions`);
  return (await res.json()) as Array<{ id: string; name: string }>;
}

// ---------- Page helpers ----------

/**
 * Wait until the page's terminal connects to a session and shows
 * "connected" status.
 */
export async function waitForConnected(page: Page): Promise<void> {
  await page.waitForSelector('text="connected"', { timeout: 15_000 });
}

/**
 * Poll until a tmux capture-pane contains the expected string.
 */
export async function waitForTmuxContent(
  sessionName: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await captureTmuxPane(sessionName);
    if (content.includes(expected)) return content;
    await new Promise((r) => setTimeout(r, 500));
  }
  const final = await captureTmuxPane(sessionName);
  throw new Error(
    `Timed out waiting for "${expected}" in tmux pane. Got:\n${final}`,
  );
}

/**
 * Wait until the tmux session has a shell prompt ready ($ sign visible
 * in capture-pane). Call after creating a session to ensure the shell
 * is fully initialized before sending commands.
 */
export async function waitForShellReady(
  sessionName: string,
  timeoutMs = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await captureTmuxPane(sessionName);
    if (content.includes("$")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Continue even if no prompt detected — the shell might use a non-$ prompt
}

/**
 * Navigate to the app, select a session from the sidebar.
 * If the session isn't already the active one, clicks it.
 */
export async function selectSessionInUI(
  page: Page,
  sessionName: string,
): Promise<void> {
  // The session name appears in the sidebar
  const sessionButton = page.locator(`text="${sessionName}"`).first();
  await sessionButton.click();
}
