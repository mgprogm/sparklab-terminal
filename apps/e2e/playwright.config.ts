import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Ports for test isolation (avoid clashing with dev).
const GATEWAY_PORT = 3907;
const NEXT_PORT = 3902;

// Resolve paths relative to this config file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const GATEWAY_DIR = path.resolve(REPO_ROOT, "apps/terminal-gateway");
const TERMINAL_DIR = path.resolve(REPO_ROOT, "apps/terminal");

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false, // serial — specs share one gateway + tmux server
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${NEXT_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `PORT=${GATEWAY_PORT} node src/server.js`,
      port: GATEWAY_PORT,
      reuseExistingServer: false,
      timeout: 15_000,
      cwd: GATEWAY_DIR,
    },
    {
      // Start the pre-built Next.js app. The E2E test target must be built
      // with NEXT_PUBLIC_GATEWAY_URL pointing at the test gateway BEFORE
      // running Playwright. The rewrite destination is also set via the env var
      // at start time (rewrites read the var at config load, not at build).
      // NEXT_DIST_DIR isolates the e2e build in .next-e2e: a concurrently
      // running `next dev` rewrites .next and corrupts the prod manifest
      // ("routesManifest.dataRoutes is not iterable" at next start).
      command: `NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_GATEWAY_URL=http://localhost:${GATEWAY_PORT} npx next start -p ${NEXT_PORT}`,
      port: NEXT_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      cwd: TERMINAL_DIR,
    },
  ],
  outputDir: "./test-results",
  reporter: [["html", { open: "never" }]],
});
