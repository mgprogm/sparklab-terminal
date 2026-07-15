#!/usr/bin/env bash
#
# Run a *local production* build of the web terminal on non-dev ports.
#
#   Dev  : app 3002 · gateway 3007 · agent 3009   (pnpm dev)
#   Prod : app 3100 · gateway 3107 · agent 3109   (this script)
#
# Fully isolated from dev: the Next.js app builds into ".next-prod" and all
# port/origin env is overridden inline, so your existing .env files and the
# dev server are untouched. Auth reuses the credentials already in
# apps/terminal-gateway/.env (loaded by each package's start script).
#
# Usage:
#   ./run-prod-local.sh              # build the app, then start all three
#   ./run-prod-local.sh --no-build   # skip the build, just (re)start
#
set -euo pipefail
cd "$(dirname "$0")"

# ---- Local production ports (+100 offset from dev) --------------------------
TERMINAL_PORT=3100
GATEWAY_PORT=3107
AGENT_PORT=3109

GATEWAY_PUBLIC="http://localhost:${GATEWAY_PORT}"
AGENT_PUBLIC="http://localhost:${AGENT_PORT}"
TERMINAL_ORIGIN="http://localhost:${TERMINAL_PORT}"

# Isolated build output so a prod build never clobbers dev's .next
export NEXT_DIST_DIR=.next-prod

# ---- Build the frontend (public URLs are inlined at build time) -------------
if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> Building terminal app (prod, dist=${NEXT_DIST_DIR}) ..."
  NEXT_PUBLIC_GATEWAY_URL="${GATEWAY_PUBLIC}" \
  NEXT_PUBLIC_AGENT_URL="${AGENT_PUBLIC}" \
    pnpm --filter @sparklab/terminal build
fi

# ---- Start the three loopback services --------------------------------------
pids=()
cleanup() { echo; echo "==> Stopping local prod ..."; kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "==> Gateway  → :${GATEWAY_PORT}"
PORT="${GATEWAY_PORT}" HOST=127.0.0.1 \
ALLOWED_ORIGINS="${TERMINAL_ORIGIN},${GATEWAY_PUBLIC}" \
  pnpm --filter @sparklab/terminal-gateway start &
pids+=($!)

echo "==> Agent    → :${AGENT_PORT}"
AGENT_PORT="${AGENT_PORT}" GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}" \
ALLOWED_ORIGINS="${TERMINAL_ORIGIN}" \
  pnpm --filter @sparklab/agent-service start &
pids+=($!)

echo "==> App      → :${TERMINAL_PORT}"
PORT="${TERMINAL_PORT}" NEXT_DIST_DIR="${NEXT_DIST_DIR}" \
  pnpm --filter @sparklab/terminal start &
pids+=($!)

echo
echo "Local production is up:"
echo "  App      ${TERMINAL_ORIGIN}"
echo "  Gateway  ${GATEWAY_PUBLIC}"
echo "  Agent    ${AGENT_PUBLIC}"
echo "  Login    admin / (password from apps/terminal-gateway/.env)"
echo
echo "Press Ctrl+C to stop all three."
wait
