/**
 * PM2 ecosystem for the *local production* stack (non-dev ports).
 *
 *   Dev  : app 3002 · gateway 3007 · agent 3009   (pnpm dev)
 *   Prod : app 3100 · gateway 3107 · agent 3109   (this file)
 *
 * The Next.js app must be built first (public URLs are inlined at build time):
 *
 *   NEXT_DIST_DIR=.next-prod \
 *   NEXT_PUBLIC_GATEWAY_URL=http://localhost:3107 \
 *   NEXT_PUBLIC_AGENT_URL=http://localhost:3109 \
 *     pnpm --filter @sparklab/terminal build
 *
 * Then:
 *
 *   pm2 start ecosystem.config.cjs      # start all three
 *   pm2 logs                            # tail logs
 *   pm2 restart ecosystem.config.cjs    # after a rebuild
 *   pm2 stop ecosystem.config.cjs       # stop all three
 *   pm2 delete ecosystem.config.cjs     # remove from pm2
 *
 * Secrets/auth (Azure key, GATEWAY_AUTH_*) still come from each package's
 * gitignored .env, loaded via `--env-file-if-exists=.env`. The `env` blocks
 * below only override ports + origins; Node/tsx give shell env precedence over
 * the .env file, so dev's .env values are effectively overridden here.
 */
const path = require("node:path");

const root = __dirname;

const TERMINAL_PORT = 3100;
const GATEWAY_PORT = 3107;
const AGENT_PORT = 3109;

const GATEWAY_PUBLIC = `http://localhost:${GATEWAY_PORT}`;
const AGENT_PUBLIC = `http://localhost:${AGENT_PORT}`;
const TERMINAL_ORIGIN = `http://localhost:${TERMINAL_PORT}`;

module.exports = {
  apps: [
    {
      name: "prod-gateway",
      cwd: path.join(root, "apps/terminal-gateway"),
      script: "src/server.js",
      interpreter: "node",
      interpreter_args: "--env-file-if-exists=.env",
      env: {
        PORT: String(GATEWAY_PORT),
        HOST: "127.0.0.1",
        ALLOWED_ORIGINS: `${TERMINAL_ORIGIN},${GATEWAY_PUBLIC}`,
      },
    },
    {
      name: "prod-agent",
      cwd: path.join(root, "apps/agent-service"),
      script: "src/index.ts",
      interpreter: path.join(root, "apps/agent-service/node_modules/.bin/tsx"),
      interpreter_args: "--env-file-if-exists=.env",
      env: {
        AGENT_PORT: String(AGENT_PORT),
        GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
        ALLOWED_ORIGINS: TERMINAL_ORIGIN,
      },
    },
    {
      name: "prod-terminal",
      cwd: path.join(root, "apps/terminal"),
      // Next's real JS entry (#!/usr/bin/env node). NOT node_modules/.bin/next —
      // that's a pnpm /bin/sh shim node can't parse.
      script: "node_modules/next/dist/bin/next",
      args: "start",
      interpreter: "node",
      env: {
        PORT: String(TERMINAL_PORT),
        NEXT_DIST_DIR: ".next-prod",
      },
    },
  ],
};
