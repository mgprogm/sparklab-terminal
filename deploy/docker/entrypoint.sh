#!/usr/bin/env bash
#
# Container entrypoint. Prepares the /data volume so ALL mutable state lands on
# it, then hands off (exec) to the CMD (pm2-runtime).
#
# Most state files honor an env override (SERVERS_FILE / PUSH_SUBSCRIPTIONS_FILE
# / PUSH_SETTINGS_FILE / AGENT_HISTORY_DIR — set in pm2.config.cjs). The one
# exception is the gateway's session metadata (apps/terminal-gateway/data/
# sessions.json), whose path is hardcoded — so we symlink that directory onto
# the volume here.
set -euo pipefail

DATA_DIR="${SPARKLAB_DATA_DIR:-/data}"
GATEWAY_DATA_LINK="/app/apps/terminal-gateway/data"

mkdir -p "${DATA_DIR}/gateway" "${DATA_DIR}/agent-history"

# Redirect the hardcoded gateway session-metadata dir onto the volume. Replace
# any dir baked into the image (there shouldn't be one; data/ is .dockerignored).
if [ ! -L "${GATEWAY_DATA_LINK}" ]; then
  rm -rf "${GATEWAY_DATA_LINK}"
  ln -sfn "${DATA_DIR}/gateway" "${GATEWAY_DATA_LINK}"
fi

# SSH multiplexing (multi-server) writes ControlPath sockets under $TMPDIR;
# make sure it exists and is writable for the runtime user.
mkdir -p "${TMPDIR:-/tmp}/gw-ssh-cm" || true

exec "$@"
