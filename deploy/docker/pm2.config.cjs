/**
 * pm2 ecosystem for the ALL-IN-ONE Docker image.
 *
 * Supervises the four Node processes inside one container:
 *   prod-gateway  :3107  (loopback)      — REST + /attach WS, owns tmux
 *   prod-agent    :3109  (loopback)      — Agent Chat loop (tsx)
 *   prod-terminal :3100  (loopback)      — Next.js `next start`
 *   prod-proxy    :3110  (0.0.0.0)       — single-origin reverse proxy (exposed)
 *
 * Why pm2 in a container: it lets us restart the gateway process WITHOUT killing
 * tmux (they are separate process trees; the gateway only ATTACHES), preserving
 * the project's "jobs survive a gateway restart" invariant inside the container.
 *
 * Config vs the native ecosystem.config.cjs (repo root): no loclx tunnel; the
 * proxy binds 0.0.0.0 (so the published port reaches it); all state-file paths
 * are redirected onto the /data volume via env overrides; secrets/auth come from
 * the CONTAINER env (docker compose env_file / -e), which pm2 propagates to each
 * child — no per-app .env is required (one may still be bind-mounted if desired,
 * hence the harmless `--env-file-if-exists=.env`).
 */
const path = require("node:path");

const root = "/app";
const DATA_DIR = process.env.SPARKLAB_DATA_DIR || "/data";

const TERMINAL_PORT = Number(process.env.TERMINAL_PORT || 3100);
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 3107);
const AGENT_PORT = Number(process.env.AGENT_PORT || 3109);
const PROXY_PORT = Number(process.env.PROXY_PORT || 3110);

// The single public origin the stack is served on. For a plain `docker compose
// up` this is the local proxy; for a real deployment set PUBLIC_ORIGIN to the
// external URL (and rebuild the image so the frontend bakes the same origin).
const PROXY_ORIGIN = `http://localhost:${PROXY_PORT}`;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || PROXY_ORIGIN;

// Origins the gateway/agent accept for CSRF/CSWSH: the public origin + the local
// proxy (so same-host http://localhost:3110 keeps working behind a tunnel/TLS).
const ALLOWED_ORIGINS = [...new Set([PUBLIC_ORIGIN, PROXY_ORIGIN])].join(",");

// Set TRUST_PROXY=1 when an EXTERNAL TLS terminator (Caddy/nginx/ingress) fronts
// the container over https — it marks the session cookie Secure and honors
// X-Forwarded-*. Leave unset for plain-http localhost, or the cookie won't be
// sent and login breaks.
const TRUST_PROXY = process.env.TRUST_PROXY || "";

// State files → /data volume. sessions.json has no env knob; entrypoint.sh
// symlinks apps/terminal-gateway/data onto the volume instead.
const stateEnv = {
  SERVERS_FILE: path.join(DATA_DIR, "servers.json"),
  PUSH_SUBSCRIPTIONS_FILE: path.join(DATA_DIR, "push-subscriptions.json"),
  PUSH_SETTINGS_FILE: path.join(DATA_DIR, "push-settings.json"),
};

// The agent HARD-REQUIRES Azure OpenAI config at boot (it exits FATAL without
// AZURE_OPENAI_ENDPOINT). So only supervise it when configured — otherwise it
// would crash-loop under pm2. When absent, Agent Chat is simply unavailable and
// the terminal stack runs untouched.
const AGENT_ENABLED = Boolean((process.env.AZURE_OPENAI_ENDPOINT || "").trim());

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
      ...(TRUST_PROXY ? { TRUST_PROXY } : {}),
      ...stateEnv,
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
    // Single-origin reverse proxy — the ONLY process bound to 0.0.0.0 so the
    // published container port reaches it. /attach,/api → gateway; /agent →
    // agent; else → terminal.
    name: "prod-proxy",
    cwd: root,
    script: "prod-proxy.cjs",
    interpreter: "node",
    env: {
      PROXY_PORT: String(PROXY_PORT),
      PROXY_HOST: "0.0.0.0",
      TERMINAL_PORT: String(TERMINAL_PORT),
      GATEWAY_PORT: String(GATEWAY_PORT),
      AGENT_PORT: String(AGENT_PORT),
    },
  },
];

// Agent Chat — supervised only when Azure OpenAI is configured (see above).
if (AGENT_ENABLED) {
  apps.push({
    name: "prod-agent",
    cwd: path.join(root, "apps/agent-service"),
    script: "src/index.ts",
    interpreter: path.join(root, "apps/agent-service/node_modules/.bin/tsx"),
    interpreter_args: "--env-file-if-exists=.env",
    env: {
      AGENT_PORT: String(AGENT_PORT),
      GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
      ALLOWED_ORIGINS,
      AGENT_HISTORY_DIR: path.join(DATA_DIR, "agent-history"),
    },
  });
}

module.exports = { apps };
