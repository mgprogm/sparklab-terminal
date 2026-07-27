import assert from "node:assert/strict";
import test from "node:test";
import { HandoffTokenManager } from "./browser-handoff-tokens.js";

const owner = { user: "alice", chatId: "chat-1", browserId: "browser-1" };

test("handoff tokens are 256-bit, owner-bound, expiring and one-time", () => {
  const manager = new HandoffTokenManager();
  const issued = manager.issue(owner, 1_000, 10_000);
  assert.ok(Buffer.from(issued.token, "base64url").length >= 32);
  assert.equal(
    manager.consume(
      issued.handoffId,
      issued.token,
      { ...owner, chatId: "other" },
      10_001,
    ),
    false,
  );
  assert.equal(
    manager.consume(issued.handoffId, issued.token, owner, 10_001),
    true,
  );
  assert.equal(
    manager.consume(issued.handoffId, issued.token, owner, 10_002),
    false,
  );

  const expired = manager.issue(owner, 1_000, 20_000);
  assert.equal(
    manager.consume(expired.handoffId, expired.token, owner, 21_000),
    false,
  );
});

test("a wrong token cannot consume the valid token", () => {
  const manager = new HandoffTokenManager();
  const issued = manager.issue(owner, 1_000, 0);
  assert.equal(
    manager.consume(issued.handoffId, "x".repeat(43), owner, 1),
    false,
  );
  assert.equal(manager.consume(issued.handoffId, issued.token, owner, 1), true);
});
