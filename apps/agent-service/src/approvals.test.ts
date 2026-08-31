import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { AgentApprovalBehavior } from "@sparklab/shared-types";

// approvals.ts reads CAPS from the fail-fast service config. Supply inert test
// values before importing it; no network client is created in this suite.
process.env.AZURE_OPENAI_ENDPOINT = "https://example.invalid";
process.env.AZURE_OPENAI_API_KEY = "test-key";
process.env.GPT56SOL_DEPLOYMENT = "test-deployment";

const { ApprovalManager } = await import("./approvals.js");

test("browser approvals coerce allow_always to a one-time allow", async () => {
  const approvals = new ApprovalManager();
  let requestId = "";

  const decision = approvals.request(
    "browser_act",
    undefined,
    (id) => {
      requestId = id;
    },
    false,
  );

  assert.notEqual(requestId, "");
  approvals.resolve(requestId, "allow_always");
  assert.equal(await decision, "allow");
  assert.equal(approvals.isAutoAllowed("browser_act", undefined), false);
});

test("allow_always remains scoped to the exact terminal tool and session", async () => {
  const approvals = new ApprovalManager();
  let requestId = "";

  const decision = approvals.request("type_text", "web-one", (id) => {
    requestId = id;
  });
  approvals.resolve(requestId, "allow_always");

  assert.equal(await decision, "allow_always");
  assert.equal(approvals.isAutoAllowed("type_text", "web-one"), true);
  assert.equal(approvals.isAutoAllowed("type_text", "web-two"), false);
  assert.equal(approvals.isAutoAllowed("press_keys", "web-one"), false);
});

test("denyAll resolves every outstanding approval as denied", async () => {
  const approvals = new ApprovalManager();
  const first = approvals.request(
    "browser_act",
    undefined,
    () => undefined,
    false,
  );
  const second = approvals.request("type_text", "web-one", () => undefined);

  approvals.denyAll();

  assert.deepEqual(await Promise.all([first, second]), ["deny", "deny"]);
});

test("wasTimedOut is true only for a requestId resolved by the timeout, and only once", async () => {
  const approvals = new ApprovalManager();
  let requestId = "";
  const pending = approvals.request("type_text", "web-one", (id) => {
    requestId = id;
  });
  approvals.resolve(requestId, "deny");
  assert.equal(await pending, "deny");
  // An explicit deny is not a timeout.
  assert.equal(approvals.wasTimedOut(requestId), false);
});

test("wasTimedOut is true when the 120s approval timeout fires with no response, and false on a second read", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const approvals = new ApprovalManager();
    let requestId = "";
    const pending = approvals.request("type_text", "web-one", (id) => {
      requestId = id;
    });
    mock.timers.tick(120_000);
    assert.equal(await pending, "deny");
    assert.equal(approvals.wasTimedOut(requestId), true);
    // Consumed: a second read must not report a stale true.
    assert.equal(approvals.wasTimedOut(requestId), false);
  } finally {
    mock.timers.reset();
  }
});

test("reports the normalized approval decision", async () => {
  const approvals = new ApprovalManager();
  let requestId = "";
  let resolved: AgentApprovalBehavior | null = null;
  const pending = approvals.request(
    "browser_act",
    "web-a",
    (id) => {
      requestId = id;
    },
    false,
    (_id, behavior) => {
      resolved = behavior;
    },
  );
  approvals.resolve(requestId, "allow_always");
  assert.equal(await pending, "allow");
  assert.equal(resolved, "allow");
});
