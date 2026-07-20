import { describe, expect, it } from "vitest";

import {
  AgentBrowserClosedSchema,
  AgentBrowserViewSchema,
  AgentWsServerMessageSchema,
  MAX_BROWSER_SCREENSHOT_BASE64_LENGTH,
  AgentWsClientMessageSchema,
} from "./agent";

describe("terminal-linked chat frames", () => {
  it("accepts terminal-scoped history requests and chat ownership", () => {
    expect(AgentWsClientMessageSchema.parse({ type: "list_chats" })).toEqual({
      type: "list_chats",
    });
    expect(
      AgentWsServerMessageSchema.parse({
        type: "chat_started",
        chatId: "chat-a",
        terminalSessionId: "local/web-a",
      }),
    ).toMatchObject({ terminalSessionId: "local/web-a" });
  });
});

const view = {
  type: "browser_view" as const,
  browserId: "browser-1",
  revision: 3,
  url: "https://example.com/docs",
  title: "Example docs",
  viewport: { width: 1280, height: 720 },
  screenshot: { mediaType: "image/png" as const, data: "aGVsbG8=" },
};

describe("browser agent frames", () => {
  it("accepts bounded browser views and closure frames in the server union", () => {
    expect(AgentWsServerMessageSchema.parse(view)).toEqual(view);
    expect(
      AgentWsServerMessageSchema.parse({
        type: "browser_closed",
        browserId: "browser-1",
        revision: 4,
      }),
    ).toEqual({ type: "browser_closed", browserId: "browser-1", revision: 4 });
  });

  it("rejects unsafe URLs, invalid media, dimensions, revisions, and base64", () => {
    expect(() =>
      AgentBrowserViewSchema.parse({ ...view, url: "file:///etc/passwd" }),
    ).toThrow();
    expect(() =>
      AgentBrowserViewSchema.parse({
        ...view,
        url: "https://user:secret@example.com/",
      }),
    ).toThrow();
    expect(() =>
      AgentBrowserViewSchema.parse({
        ...view,
        screenshot: { mediaType: "image/svg+xml", data: "PHN2Zz4=" },
      }),
    ).toThrow();
    expect(() =>
      AgentBrowserViewSchema.parse({
        ...view,
        viewport: { width: 0, height: 720 },
      }),
    ).toThrow();
    expect(() =>
      AgentBrowserClosedSchema.parse({
        type: "browser_closed",
        browserId: "browser-1",
        revision: -1,
      }),
    ).toThrow();
    expect(() =>
      AgentBrowserViewSchema.parse({
        ...view,
        screenshot: { mediaType: "image/png", data: "not base64!" },
      }),
    ).toThrow();
  });

  it("rejects screenshots larger than the wire limit", () => {
    expect(() =>
      AgentBrowserViewSchema.parse({
        ...view,
        screenshot: {
          mediaType: "image/webp",
          data: "A".repeat(MAX_BROWSER_SCREENSHOT_BASE64_LENGTH + 4),
        },
      }),
    ).toThrow();
    // At the encoded cap, no padding decodes to one byte over 2 MiB.
    expect(() =>
      AgentBrowserViewSchema.parse({
        ...view,
        screenshot: {
          mediaType: "image/webp",
          data: "A".repeat(MAX_BROWSER_SCREENSHOT_BASE64_LENGTH),
        },
      }),
    ).toThrow();
  });
});
