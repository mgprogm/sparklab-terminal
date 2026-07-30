import assert from "node:assert/strict";
import test from "node:test";

process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";

const { browserUseConfig } = await import("./browser-runtime.js");

test("Browser Use permits literal public IPs while the safe proxy owns policy", () => {
  const profileId = "profile-1";
  const generated = browserUseConfig(profileId, "http://127.0.0.1:9222");

  assert.equal(generated.browser_profile[profileId]?.block_ip_addresses, false);
  assert.equal(generated.browser_profile[profileId]?.disable_security, false);
  assert.equal(generated.browser_profile[profileId]?.accept_downloads, false);
});
