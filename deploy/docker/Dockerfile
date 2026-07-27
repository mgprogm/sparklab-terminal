# syntax=docker/dockerfile:1
#
# Sparklab Terminal — all-in-one image.
#
# Faithful to the project's core invariant ("jobs survive a gateway restart"):
# tmux + all four Node processes (gateway, agent, terminal, single-origin proxy)
# live in ONE container, supervised by pm2. pm2 can restart the gateway process
# WITHOUT killing tmux (tmux is a separate process tree the gateway only
# ATTACHES to), so the survive-gateway-restart property holds inside the
# container. A restart of the *whole container* is a fresh start (tmux dies with
# it) — that is the one honest limitation of the containerized form; see
# docs/DOCKER.md.
#
# Two stages: `builder` compiles the workspace (incl. native node-pty) and bakes
# the Next.js frontend; `runtime` is a slim Debian with tmux + ssh + pm2.
#
# The frontend bakes its gateway/agent origin at BUILD time (Next.js
# NEXT_PUBLIC_*), so PUBLIC_ORIGIN is a build ARG. Default targets the local
# proxy for `docker compose up`; rebuild with --build-arg PUBLIC_ORIGIN=https://…
# to deploy behind a real domain (same limitation as the native build).

# ─────────────────────────────── builder ───────────────────────────────
FROM node:24-bookworm AS builder

# python3 for node-gyp (node-pty native build); build-essential ships in the
# full node image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Install with the full source present. node-pty is compiled here against the
# image toolchain, so the resulting binary runs on the matching runtime stage.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

# Bake the frontend. PUBLIC_ORIGIN is the single origin the whole stack is
# served on; it is inlined into the client bundle (WS/REST target) at build time.
ARG PUBLIC_ORIGIN=http://localhost:3110
ENV NEXT_DIST_DIR=.next-prod
RUN NEXT_PUBLIC_GATEWAY_URL="${PUBLIC_ORIGIN}" \
    NEXT_PUBLIC_AGENT_URL="${PUBLIC_ORIGIN}" \
    pnpm --filter @sparklab/terminal build

# ─────────────────────────── runtime system base ───────────────────────────
FROM node:24-bookworm-slim AS runtime-system

# tmux — the process owner (the whole point). openssh-client — multi-server
# (SSH + remote tmux). procps — pm2/tmux housekeeping. tini — PID 1 reaping.
# git — footer git-status feature runs `git` in session cwds.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      tmux openssh-client ca-certificates procps tini git bash \
  && rm -rf /var/lib/apt/lists/*

# pm2 as the in-container supervisor (not a workspace dependency — installed here
# only). pm2-runtime keeps the container in the foreground and forwards signals.
RUN npm install -g pm2@6 && npm cache clean --force

ENV NODE_ENV=production
ENV NEXT_DIST_DIR=.next-prod
ENV SPARKLAB_DATA_DIR=/data

# ───────────────────── optional browser/WebRTC runtime ─────────────────────
# This target installs the native capture/codec/ICE runtime without bloating
# the default terminal image. System packages stay cacheable when app code
# changes. The finished target is selected by compose.browser.yml.
FROM ghcr.io/astral-sh/uv:0.11.14 AS uv-runtime

FROM runtime-system AS browser-system

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
      chromium xvfb ffmpeg gosu fonts-liberation \
      python3 python3-gi \
      gir1.2-gstreamer-1.0 \
      gir1.2-gst-plugins-base-1.0 \
      gir1.2-gst-plugins-bad-1.0 \
      gstreamer1.0-tools \
      gstreamer1.0-x \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-libav \
      gstreamer1.0-nice \
      libnice10 \
  && rm -rf /var/lib/apt/lists/*

# Debian keeps Chromium's setuid sandbox in a separate recommended package;
# install it explicitly because this image intentionally uses --no-install-recommends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium-sandbox \
  && rm -rf /var/lib/apt/lists/*

COPY --from=uv-runtime /uv /uvx /usr/local/bin/
COPY deploy/docker/verify-browser-runtime.sh /usr/local/bin/verify-browser-runtime
RUN chmod +x /usr/local/bin/verify-browser-runtime \
  && verify-browser-runtime

ENV BROWSER_DOCKER_RUNTIME=1
ENV BROWSER_USE_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

# ───────────────────────────── default runtime ─────────────────────────────
FROM runtime-system AS runtime

WORKDIR /app
COPY --from=builder /app /app
COPY deploy/docker/pm2.config.cjs /app/deploy/docker/pm2.config.cjs
COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME ["/data"]
EXPOSE 3110
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["pm2-runtime", "start", "/app/deploy/docker/pm2.config.cjs"]

# ─────────────────────── browser/WebRTC final image ────────────────────────
FROM browser-system AS browser-runtime

WORKDIR /app
COPY --from=builder /app /app
COPY deploy/docker/pm2.config.cjs /app/deploy/docker/pm2.config.cjs
COPY deploy/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /data/gateway /data/agent-history /tmp/gw-ssh-cm \
  && rm -rf /app/apps/terminal-gateway/data \
  && ln -s /data/gateway /app/apps/terminal-gateway/data \
  && chown -R node:node /data /tmp/gw-ssh-cm

VOLUME ["/data"]
EXPOSE 3110
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["pm2-runtime", "start", "/app/deploy/docker/pm2.config.cjs"]
