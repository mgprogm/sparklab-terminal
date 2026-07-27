import assert from "node:assert/strict";
import test from "node:test";
import { BrowserControlLease } from "./browser-control-lease.js";

test("browser control lease enforces exclusive valid transitions", () => {
  const lease = new BrowserControlLease();
  lease.assertAgent();
  lease.requestHuman();
  assert.equal(lease.state, "pending");
  assert.throws(() => lease.assertAgent(), /browser_under_human_control/);
  assert.throws(() => lease.requestHuman(), /browser_handoff_busy/);
  lease.activateHuman();
  lease.assertHuman();
  assert.throws(() => lease.assertAgent(), /browser_under_human_control/);
  lease.returnToAgent();
  lease.assertAgent();
});

test("closed lease cannot grant either controller", () => {
  const lease = new BrowserControlLease();
  lease.close();
  assert.throws(() => lease.assertAgent(), /browser_under_human_control/);
  assert.throws(() => lease.assertHuman(), /browser_handoff_inactive/);
});
