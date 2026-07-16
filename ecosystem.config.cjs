/**
 * PM2 ecosystem for the *local production* stack (non-dev ports).
 *
 *   Dev  : app 3002 · gateway 3007 · agent 3009   (pnpm dev)
 *   Prod : app 3100 · gateway 3107 · agent 3109 · proxy 3110   (this file)
 *
 * A single-origin reverse proxy (prod-proxy.cjs, port 3110) fronts all three
 * services, so ONE origin serves everything. That keeps the `gw_session` cookie
 * first-party across the gateway AND the agent — separate per-service origins
 * break the agent's cookie auth.
 *
 * ── Switching local ↔ tunnel ────────────────────────────────────────────────
 * The public endpoint is configured in the ROOT `.env` (see `.env.example`), so
 * flipping between local and the loclx tunnel is a one-line change:
 *
 *   PUBLIC_ORIGIN=http://localhost:3110        # local, same machine only
 *   PUBLIC_ORIGIN=https://sparklab.ap.loclx.io # public tunnel
 *   TUNNEL_ENABLED=true|false                  # include the prod-tunnel app?
 *
 * After editing `.env`:  ./build-prod.sh  &&  pm2 restart ecosystem.config.cjs --update-env
 * (the frontend bakes PUBLIC_ORIGIN at build time — build-prod.sh reads the same .env).
 *
 * Secrets/auth (Azure key, GATEWAY_AUTH_*) still come from each package's
 * gitignored .env, loaded via `--env-file-if-exists=.env`. The `env` blocks
 * below only override ports + origins; Node/tsx give shell env precedence over
 * the .env file, so dev's .env values are effectively overridden here.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;

// Minimal .env reader (no dependency). Reads root .env then .env.local (override).
function loadRootEnv() {
  const out = {};
  for (const name of [".env", ".env.local"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trimStart().startsWith("#")) continue;
      out[m[1]] = m[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
  return out;
}
const ENV = loadRootEnv();

const TERMINAL_PORT = 3100;
const GATEWAY_PORT = 3107;
const AGENT_PORT = 3109;
const PROXY_PORT = 3110;

const PROXY_ORIGIN = `http://localhost:${PROXY_PORT}`;
// The single public origin the stack is served on (default: the local proxy).
const PUBLIC_ORIGIN = ENV.PUBLIC_ORIGIN || PROXY_ORIGIN;

// loclx tunnel config (root .env). Skip the tunnel app entirely when disabled.
const LOCLX_BIN = "/snap/bin/loclx";
const TUNNEL_ENABLED =
  String(ENV.TUNNEL_ENABLED || "false").toLowerCase() === "true";
const TUNNEL_SUBDOMAIN = ENV.TUNNEL_SUBDOMAIN || "sparklab";
const TUNNEL_REGION = ENV.TUNNEL_REGION || "ap";

// Origins the gateway/agent accept: the public origin + the local proxy (so
// same-machine http://localhost:3110 works even in tunnel mode). Deduped.
const ALLOWED_ORIGINS = [...new Set([PUBLIC_ORIGIN, PROXY_ORIGIN])].join(",");

const apps = [
  {
    name: "prod-gateway",
    cwd: path.join(root, "apps/terminal-gateway"),
    script: "src/server.js",
    interpreter: "node",
    interpreter_args: "--env-file-if-exists=.env",
    env: {
      PORT: String(GATEWAY_PORT),
      HOST: "127.0.0.1",
      ALLOWED_ORIGINS,
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
      ALLOWED_ORIGINS,
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
  {
    // Single-origin reverse proxy: /attach,/api → gateway; /agent → agent;
    // else → terminal. Lets one origin/tunnel serve the whole stack.
    name: "prod-proxy",
    cwd: root,
    script: "prod-proxy.cjs",
    interpreter: "node",
    env: {
      PROXY_PORT: String(PROXY_PORT),
      TERMINAL_PORT: String(TERMINAL_PORT),
      GATEWAY_PORT: String(GATEWAY_PORT),
      AGENT_PORT: String(AGENT_PORT),
    },
  },
];

// LocalXpose tunnel (snap binary — run directly, interpreter "none"). Points at
// the proxy, NOT the terminal. Included only when TUNNEL_ENABLED=true in .env.
// loclx auth comes from its own config (`loclx account login` / LOCLX_ACCESS_TOKEN).
if (TUNNEL_ENABLED) {
  apps.push({
    name: "prod-tunnel",
    script: LOCLX_BIN,
    interpreter: "none",
    args: `tunnel http --to 127.0.0.1:${PROXY_PORT} --subdomain ${TUNNEL_SUBDOMAIN} --region ${TUNNEL_REGION}`,
    autorestart: true,
  });
}

module.exports = { apps };
