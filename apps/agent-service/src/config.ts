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

export const config = {
  azure: {
    endpoint: required("AZURE_OPENAI_ENDPOINT"),
    apiKey: required("AZURE_OPENAI_API_KEY"),
    apiVersion: optional("AZURE_OPENAI_API_VERSION", "2025-04-01-preview"),
    deployment: required("GPT56SOL_DEPLOYMENT"),
  },
  port: Number(optional("AGENT_PORT", "3009")),
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
    user: process.env.GATEWAY_AUTH_USER?.trim() || "",
    password: process.env.GATEWAY_AUTH_PASSWORD?.trim() || "",
  },
} as const;

/** Coarse per-turn safety caps (see agent-loop). */
export const CAPS = {
  maxModelCalls: 24,
  maxWriteExecs: 10,
  approvalTimeoutMs: 120_000,
} as const;
