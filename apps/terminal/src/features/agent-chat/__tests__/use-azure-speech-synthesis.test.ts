import { describe, expect, it } from "vitest";

import { toSpeakableText } from "../use-azure-speech-synthesis";

describe("toSpeakableText", () => {
  it("keeps prose while removing Markdown syntax and code blocks", () => {
    expect(
      toSpeakableText(
        "## Update\n\nRead [the guide](https://example.test).\n\n```ts\nsecret();\n```\n\n- Use `safe` text.",
      ),
    ).toBe("Update\n\nRead the guide.\n\nUse safe text.");
  });

  it("bounds overly long model output before it reaches Azure Speech", () => {
    expect(toSpeakableText("x".repeat(12_001))).toHaveLength(12_000);
  });
});
