/**
 * Environment configuration for the agent service.
 *
 * Fail-fast at startup if a required Azure or gateway var is missing — same
 * posture as the gateway's own env validation. Secrets (the API key, the
 * gateway password) are read here and never logged.
 */

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
    image: optional("CUA_IMAGE", "trycua/xfce-cua:latest"),
    // Isolated docker network whose only egress route is the agent-service
    // proxy (enforced at the network layer, not via app proxy env). Empty =
    // spike default network; MUST be set for any shared deployment.
    egressNetwork: optionalValue("CUA_EGRESS_NETWORK"),
    // Default `standard` for the spike: `bounded` admits ONLY what a reviewed
    // capability manifest lists, so bounded-with-no-manifest fails every call
    // closed. Set both CUA_DRIVER_PERMISSION_MODE=bounded and
    // CUA_CAPABILITY_MANIFEST_FILE together (docs/VIRTUAL-COMPUTER.md D6 — the
    // manifest is a follow-up, required before any shared deployment).
    driverPermissionMode: optional("CUA_DRIVER_PERMISSION_MODE", "standard"),
    capabilityManifestFile: optionalValue("CUA_CAPABILITY_MANIFEST_FILE"),
    // Opt-in container hardening. `--cap-drop ALL --security-opt
    // no-new-privileges` is untested against the full XFCE image and can break
    // a sudo/gosu privilege-drop entrypoint; off until verified on first run.
    harden: optional("CUA_HARDEN", "false") === "true",
    // TODO(spike): unverified against the pinned driver in the image. The 0.15
    // action catalog names full-display capture `get_desktop_state`; older
    // LINUX.md still says `screenshot`. Override once confirmed.
    captureTool: optional("CUA_CAPTURE_TOOL", "get_desktop_state"),
    startTimeoutMs: positiveInt("CUA_START_TIMEOUT_MS", 90_000, 300_000),
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
