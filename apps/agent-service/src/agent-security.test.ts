import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedWebSocketOrigin } from "./agent-security.js";

const allowed = new Set(["https://term.example.com"]);

test("production origin validation rejects missing and foreign origins", () => {
  assert.equal(isAllowedWebSocketOrigin(undefined, allowed, false), false);
  assert.equal(
    isAllowedWebSocketOrigin("https://evil.example", allowed, false),
    false,
  );
  assert.equal(
    isAllowedWebSocketOrigin("https://term.example.com", allowed, false),
    true,
  );
});

test("missing Origin is allowed only in explicit development posture", () => {
  assert.equal(isAllowedWebSocketOrigin(undefined, allowed, true), true);
});
