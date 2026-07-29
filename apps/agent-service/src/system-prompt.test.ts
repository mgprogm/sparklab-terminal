import assert from "node:assert/strict";
import test from "node:test";

import { systemPrompt } from "./system-prompt.js";

test("live agent-active lease overrides stale handoff history", () => {
  const prompt = systemPrompt(undefined, "agent_active");

  assert.match(prompt, /live state is authoritative/);
  assert.match(prompt, /No human handoff is active/);
  assert.match(prompt, /Never tell the user to select Done or Cancel/);
});

test("an active handoff tells the agent to reopen missing controls", () => {
  const prompt = systemPrompt(undefined, "human_active");

  assert.match(prompt, /call browser_request_handoff to reopen/);
});
