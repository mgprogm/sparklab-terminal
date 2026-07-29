import assert from "node:assert/strict";
import test from "node:test";
import { serializeBrowserState } from "./browser-state.js";

test("browser state stays valid and retains as many indexed elements as fit", () => {
  const state = {
    url: "https://example.com/",
    title: "Example",
    viewport: { width: 1280, height: 720 },
    interactive_elements: Array.from({ length: 100 }, (_, index) => ({
      index,
      tag: "a",
      text: `Link ${index} ${"x".repeat(100)}`,
      href: `https://example.com/${index}`,
    })),
  };
  const serialized = serializeBrowserState(state, 2_000);
  const parsed = JSON.parse(serialized) as {
    interactive_elements: Array<{ index: number }>;
    truncated: { interactive_elements: number };
  };

  assert.ok(serialized.length <= 2_000);
  assert.ok(parsed.interactive_elements.length > 0);
  assert.equal(parsed.interactive_elements[0]?.index, 0);
  assert.equal(
    parsed.interactive_elements.length + parsed.truncated.interactive_elements,
    100,
  );
});

test("browser state ignores unexpected upstream fields", () => {
  const serialized = serializeBrowserState({
    url: "https://example.com/",
    title: "Example",
    unexpected: "x".repeat(100_000),
    interactive_elements: [],
  });

  assert.doesNotMatch(serialized, /unexpected/);
  assert.ok(serialized.length < 1_000);
});
