/**
 * Environment configuration for the agent service.
 *
 * Fail-fast at startup if a required Azure or gateway var is missing — same
 * posture as the gateway's own env validation. Secrets (the API key, the
 * gateway password) are read here and never logged.
 */

import { hostname } from "node:os";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(
      `[agent] FATAL: missing required env var ${name}. See .env.example.`,
    );
    process.exit(1);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function optionalValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function positiveInt(name: string, fallback: number, max: number): number {
  const raw = optional(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
}

function urls(name: string, allowed: ReadonlySet<string>): string[] {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length > 8) throw new Error(`${name} accepts at most 8 URLs`);
  for (const value of values) {
    const scheme = value.slice(0, value.indexOf(":"));
    if (!allowed.has(scheme) || value.length > 2048)
      throw new Error(`${name} contains an unsupported URL`);
  }
  return values;
}

const handoffTransport = optional("BROWSER_HANDOFF_TRANSPORT", "jpeg");
if (handoffTransport !== "jpeg" && handoffTransport !== "webrtc-preferred")
  throw new Error("BROWSER_HANDOFF_TRANSPORT must be jpeg or webrtc-preferred");
const stunUrls = urls("BROWSER_HANDOFF_STUN_URLS", new Set(["stun", "stuns"]));
const turnUrls = urls("BROWSER_HANDOFF_TURN_URLS", new Set(["turn", "turns"]));
const turnSecret = process.env.BROWSER_HANDOFF_TURN_SECRET?.trim() || "";
if (turnUrls.length > 0 && !turnSecret)
  throw new Error(
    "BROWSER_HANDOFF_TURN_SECRET is required when TURN URLs are configured",
  );
// Virtual Computer (CUA) — a few values need derivation before the config
// object literal.
const cuaPermissionMode = optional("CUA_DRIVER_PERMISSION_MODE", "standard");
if (cuaPermissionMode !== "standard" && cuaPermissionMode !== "bounded")
  throw new Error(
    `CUA_DRIVER_PERMISSION_MODE must be "standard" or "bounded" (got "${cuaPermissionMode}")`,
  );
// Fixed in-container path the manifest is COPYed to by test/cua-real/Dockerfile
// (M2.1). The host->container bind-mount that the earlier wiring assumed never
// existed, so the manifest is baked into the image instead.
const CUA_BAKED_MANIFEST_PATH = "/etc/cua/capability-manifest.yaml";
// In `bounded` mode a manifest is mandatory (the driver fails every call closed
// without one). Default to the image-baked path so a per-operator
// `CUA_DRIVER_PERMISSION_MODE=bounded` needs no second env var; an explicit
// CUA_CAPABILITY_MANIFEST_FILE still wins. `standard` mode leaves it unset.
const cuaCapabilityManifestFile =
  optionalValue("CUA_CAPABILITY_MANIFEST_FILE") ??
  (cuaPermissionMode === "bounded" ? CUA_BAKED_MANIFEST_PATH : undefined);
// Instance id so sweepOrphans() only removes THIS instance's containers (M2.3).
// MUST be stable across restarts for boot-time crash-orphan cleanup to work
// (a fresh random each boot would never match a crashed process's labels).
// Defaults to the host name; set CUA_INSTANCE_ID explicitly — to a stable,
// per-instance value — when running more than one agent-service on a host or
// when the host name itself is ephemeral (e.g. a containerised agent-service).
const cuaInstanceId =
  (optionalValue("CUA_INSTANCE_ID") ??
    (hostname() || "default").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48)) ||
  "default";

// Virtual Computer (CUA) — M3.5 opt-in proxied browsing. When on, the desktop
// container is given `http_proxy`/`https_proxy` + a Firefox policy pointing at a
// per-runtime SafeBrowserProxy (public-only ruleset). This is NOT a containment
// boundary — the container keeps a default route off-box and only proxy-aware
// apps honour it. See docs/VIRTUAL-COMPUTER.md "Proxied browsing".
const cuaProxyBrowsing = optional("CUA_PROXY_BROWSING", "false") === "true";
const cuaEgressNetwork = optionalValue("CUA_EGRESS_NETWORK");
if (cuaProxyBrowsing && cuaEgressNetwork)
  throw new Error(
    "CUA_PROXY_BROWSING=true is incompatible with CUA_EGRESS_NETWORK: an --internal " +
      "egress network has no route to the agent-service proxy, so proxied browsing " +
      "would be a silent no-op. Unset one — keep CUA_EGRESS_NETWORK for the hard " +
      "zero-egress guarantee, or CUA_PROXY_BROWSING for opt-in browsing.",
  );

const gatewayAuthUser = process.env.GATEWAY_AUTH_USER?.trim() || "";
const gatewayAuthPassword = process.env.GATEWAY_AUTH_PASSWORD?.trim() || "";
const allowMissingOrigin =
  optional(
    "AGENT_ALLOW_MISSING_ORIGIN",
    gatewayAuthUser || gatewayAuthPassword ? "false" : "true",
  ) === "true";

export const config = {
  azure: {
    endpoint: required("AZURE_OPENAI_ENDPOINT"),
    apiKey: required("AZURE_OPENAI_API_KEY"),
    apiVersion: optional("AZURE_OPENAI_API_VERSION", "2025-04-01-preview"),
    deployments: {
      sol: required("GPT56SOL_DEPLOYMENT"),
      terra: optionalValue("GPT56TERRA_DEPLOYMENT"),
      luna: optionalValue("GPT56LUNA_DEPLOYMENT"),
    },
  },
  // BytePlus Ark — optional OpenAI-compatible provider. Its models are offered
  // in the picker only when `apiKey` is set. Each deployment id is
  // env-overridable (Ark uses dated suffixes; verify current ids in the
  // ModelArk console). DeepSeek keeps `thinking` disabled (merged into the
  // request body by resolveModel): the agent loop's SSE parser reads only
  // `delta.content`, and reasoning latency would fight the per-turn caps.
  byteplus: {
    baseUrl: optional(
      "ARK_BASE_URL",
      "https://ark.ap-southeast.bytepluses.com",
    ).replace(/\/$/, ""),
    apiKey: process.env.ARK_API_KEY?.trim() || "",
    deepseekV4Pro: optional(
      "ARK_DEEPSEEK_DEPLOYMENT",
      "deepseek-v4-pro-260425",
    ),
    deepseekV32: optional(
      "ARK_DEEPSEEK_V32_DEPLOYMENT",
      "deepseek-v3-2-251201",
    ),
    glm: optional("ARK_GLM_DEPLOYMENT", "glm-4-7-251222"),
  },
  port: Number(optional("AGENT_PORT", "3009")),
  host: optional("AGENT_HOST", "127.0.0.1"),
  gatewayUrl: optional("GATEWAY_URL", "http://127.0.0.1:3007").replace(
    /\/$/,
    "",
  ),
  allowedOrigins: new Set(
    optional(
      "ALLOWED_ORIGINS",
      "http://localhost:3000,http://localhost:3002,http://localhost:3003",
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  ),
  gatewayAuth: {
    // Optional: only sent when the gateway runs with auth enabled. When the
    // gateway is in open mode these can be blank and login is skipped.
    user: gatewayAuthUser,
    password: gatewayAuthPassword,
  },
  allowMissingOrigin,
  maxConnections: positiveInt("MAX_AGENT_CONNECTIONS", 32, 512),
  browser: {
    project: process.env.BROWSER_USE_PROJECT?.trim() || "",
    headless: optional("BROWSER_USE_HEADLESS", "true") !== "false",
    executablePath: process.env.BROWSER_USE_EXECUTABLE_PATH?.trim() || "",
    maxSessions: positiveInt("MAX_BROWSER_SESSIONS", 4, 64),
    maxConcurrentLaunches: positiveInt("MAX_BROWSER_LAUNCHES", 2, 16),
  },
  // Virtual Computer (CUA) — spike. Disabled unless CUA_ENABLED=true.
  // See docs/VIRTUAL-COMPUTER.md. v1 runtime = one disposable Docker desktop
  // per chat with `cua-driver mcp --direct` reached over `docker exec -i`.
  cua: {
    enabled: optional("CUA_ENABLED", "false") === "true",
    dockerBin: optional("CUA_DOCKER_BIN", "docker"),
    // Must carry cua-driver >= 0.22 (for `mcp --direct`). The stock
    // trycua/xfce-cua:latest pins 0.12.4 and has no `mcp --direct`, so the
    // default is the one-layer bump built from test/cua-real/:
    //   docker build -t sparklab/cua-desktop:0.22.2 apps/agent-service/test/cua-real
    image: optional("CUA_IMAGE", "sparklab/cua-desktop:0.22.2"),
    // The CUA desktop image runs XFCE as an unprivileged user on an Xvnc
    // display; the driver must join that session. `docker exec` gets
    // `-u <driverUser>` (when set) plus `-e HOME` / `-e DISPLAY`.
    driverUser: optionalValue("CUA_DRIVER_USER"), // e.g. "cua"; empty = image default
    driverHome: optional("CUA_DRIVER_HOME", "/home/cua"),
    display: optional("CUA_DISPLAY", ":1"),
    driverCmd: optional("CUA_DRIVER_CMD", "cua-driver"), // or an absolute path
    // Isolated docker network whose only egress route is the agent-service
    // proxy (enforced at the network layer, not via app proxy env). Empty =
    // spike default network; MUST be set for any shared deployment.
    egressNetwork: cuaEgressNetwork,
    // M3.5 — opt-in proxied browsing. `proxyBrowsing` starts a per-runtime
    // SafeBrowserProxy; the container is handed `http_proxy` + a Firefox policy
    // pointing at `proxyContainerHost:<port>`. `proxyBindHost` is where the
    // proxy listens on the agent-service host (default `0.0.0.0` so a container
    // on the default bridge can reach it — set `172.17.0.1` / the bridge
    // gateway IP to avoid an open relay on other interfaces).
    // `proxyContainerHost` is the name/IP the container dials; the default
    // `host.docker.internal` is auto-mapped via `--add-host=…:host-gateway`.
    // NOT a containment boundary — see docs/VIRTUAL-COMPUTER.md.
    proxyBrowsing: cuaProxyBrowsing,
    proxyBindHost: optional("CUA_PROXY_BIND_HOST", "0.0.0.0"),
    proxyContainerHost: optional(
      "CUA_PROXY_CONTAINER_HOST",
      "host.docker.internal",
    ),
    // Default `standard` (= allow). `bounded` admits ONLY what the reviewed
    // capability manifest lists; bounded-with-no-manifest fails every call
    // closed, so `capabilityManifestFile` below defaults to the image-baked
    // manifest whenever this is `bounded` (docs/VIRTUAL-COMPUTER.md D6 / M2.1).
    driverPermissionMode: cuaPermissionMode,
    // In-container path to the bounded-mode capability manifest. Auto-defaults
    // to the image-baked /etc/cua/capability-manifest.yaml under `bounded`;
    // unset under `standard`. computer-runtime.ts refuses to start `bounded`
    // with this unresolved.
    capabilityManifestFile: cuaCapabilityManifestFile,
    // Per-agent-service-instance id. sweepOrphans() filters on
    // `label=sparklab-cua-instance=<id>` so a 2nd instance (or a boot while
    // another instance has a live desktop) never `docker rm -f`s a container it
    // does not own (M2.3).
    instanceId: cuaInstanceId,
    // Process-wide caps, mirroring browser.maxSessions / maxConcurrentLaunches
    // (M2.2). N concurrent cold desktop starts on one Docker daemon is the
    // pathology maxLaunches exists for.
    maxDesktops: positiveInt("MAX_CUA_DESKTOPS", 3, 16),
    maxLaunches: positiveInt("MAX_CUA_LAUNCHES", 1, 8),
    // Opt-in container hardening. `--cap-drop ALL --security-opt
    // no-new-privileges` is untested against the full XFCE image and can break
    // a sudo/gosu privilege-drop entrypoint; off until verified on first run.
    harden: optional("CUA_HARDEN", "false") === "true",
    // In-container directory get_desktop_state writes screenshots to before the
    // runtime pulls the bytes out with `docker exec … base64` and deletes them.
    screenshotDir: optional("CUA_SCREENSHOT_DIR", "/tmp"),
    // noVNC port inside the desktop image — polled for X-session readiness
    // before the driver is spawned (trycua/xfce-cua default 6901).
    novncPort: positiveInt("CUA_NOVNC_PORT", 6901, 65_535),
    startTimeoutMs: positiveInt("CUA_START_TIMEOUT_MS", 90_000, 300_000),
    // cua-driver runs its OWN background sweep (spawn_lifecycle_maintenance in
    // cua-driver-sdk/src/runtime.rs) that unilaterally ends any driver-side
    // session idle longer than this, independent of the container/docker
    // health and independent of our own approval-timeout/idle-desktop logic.
    // Since agent-service never calls `start_session` and never passes a
    // `session` label, every observe/act call shares one implicit session —
    // so once that single session is swept, EVERY subsequent call (including
    // a fresh computer_observe) fails closed with "this session has ended;
    // call start_session explicitly to reuse its label", and there is no
    // recovery path short of a new chat (confirmed against a real container,
    // 2026-08-31: the driver's own default is 300s / 5min, checked every 30s,
    // which a slow chat's human-approval wait trivially exceeds). Set to the
    // same 8h outer bound used by the bounded-mode manifest's idle_timeout so
    // a single chat's desktop survives an entire slow session; the driver's
    // own hard ceiling is 24h.
    sessionIdleTtlSecs: positiveInt(
      "CUA_DRIVER_SESSION_IDLE_TTL_SECS",
      28_800,
      86_400,
    ),
  },
  handoff: {
    transport: handoffTransport as "jpeg" | "webrtc-preferred",
    maxConnections: positiveInt("MAX_HANDOFF_CONNECTIONS", 16, 256),
    maxPeerConnections: positiveInt("MAX_WEBRTC_PEERS", 4, 64),
    negotiationTimeoutMs: positiveInt(
      "BROWSER_HANDOFF_WEBRTC_TIMEOUT_MS",
      8_000,
      30_000,
    ),
    stunUrls,
    turnUrls,
    turnSecret,
    turnTtlSeconds: positiveInt("BROWSER_HANDOFF_TURN_TTL_SECONDS", 600, 3600),
  },
} as const;

/** Coarse per-turn safety caps (see agent-loop). */
export const CAPS = {
  maxModelCalls: 24,
  maxWriteExecs: 10,
  approvalTimeoutMs: 120_000,
  browserActionTimeoutMs: 30_000,
  computerActionTimeoutMs: 30_000,
} as const;
