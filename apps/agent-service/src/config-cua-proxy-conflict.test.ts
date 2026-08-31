import assert from "node:assert/strict";
import test from "node:test";

// M3.5 — CUA_PROXY_BROWSING=true is mutually exclusive with CUA_EGRESS_NETWORK
// (an --internal egress network has no route to the agent-service proxy, so
// proxied browsing would be a silent no-op). config.ts throws at module load;
// this file boots in its own process so the throwing import is isolated.
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.CUA_ENABLED = "true";
process.env.CUA_PROXY_BROWSING = "true";
process.env.CUA_EGRESS_NETWORK = "sparklab-cua-egress";

test("config load rejects CUA_PROXY_BROWSING + CUA_EGRESS_NETWORK set together (M3.5)", async () => {
  await assert.rejects(
    () => import("./config.js"),
    /CUA_PROXY_BROWSING=true is incompatible with CUA_EGRESS_NETWORK/,
  );
});
