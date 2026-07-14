/**
 * Gate 1: Gateway smoke + acceptance + acceptance:multi still PASS.
 *
 * These are run directly as Node scripts (not through Playwright) since they
 * are standalone test scripts that manage their own tmux sessions.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = path.resolve(
  __dirname,
  "../../..",
  "apps/terminal-gateway",
);

test.describe("Gate 1: Gateway test scripts", () => {
  test("smoke test passes", async () => {
    const { stdout, stderr } = await execFileAsync(
      "node",
      ["test/smoke-pty-tmux.js"],
      { cwd: GATEWAY_DIR, timeout: 30_000 },
    );
    const output = stdout + stderr;
    expect(output).toContain("PASS");
  });

  test("acceptance test passes", async () => {
    const { stdout, stderr } = await execFileAsync(
      "node",
      ["test/acceptance-survive-disconnect.js"],
      { cwd: GATEWAY_DIR, timeout: 60_000 },
    );
    const output = stdout + stderr;
    expect(output).toContain("PASS");
  });

  test("acceptance:multi test passes", async () => {
    const { stdout, stderr } = await execFileAsync(
      "node",
      ["test/acceptance-multi-session.js"],
      { cwd: GATEWAY_DIR, timeout: 60_000 },
    );
    const output = stdout + stderr;
    expect(output).toContain("PASS");
  });
});
