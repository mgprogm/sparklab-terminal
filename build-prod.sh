#!/usr/bin/env bash
#
# Build the terminal frontend for the local-production stack, baking in the
# PUBLIC_ORIGIN from the root .env (see .env.example). The frontend inlines the
# gateway/agent URLs at build time, so this must be re-run whenever you change
# PUBLIC_ORIGIN (switch local ↔ tunnel) or frontend code.
#
#   ./build-prod.sh
#   pm2 restart ecosystem.config.cjs --update-env   # then apply
#
set -euo pipefail
cd "$(dirname "$0")"

# Load root .env (PUBLIC_ORIGIN, TUNNEL_*). .env.local overrides .env.
set -a
[ -f .env ] && . ./.env
[ -f .env.local ] && . ./.env.local
set +a

PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost:3110}"
echo "==> Building terminal app (dist=.next-prod) for PUBLIC_ORIGIN=${PUBLIC_ORIGIN}"

# Single origin: gateway AND agent are reached through the proxy at PUBLIC_ORIGIN.
NEXT_DIST_DIR=.next-prod \
NEXT_PUBLIC_GATEWAY_URL="${PUBLIC_ORIGIN}" \
NEXT_PUBLIC_AGENT_URL="${PUBLIC_ORIGIN}" \
  pnpm --filter @sparklab/terminal build

echo "==> Done. Apply with: pm2 restart ecosystem.config.cjs --update-env"
