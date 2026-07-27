import { describe, expect, it } from "vitest";

import {
  AgentBrowserClosedSchema,
  AgentBrowserViewSchema,
  AgentWsServerMessageSchema,
  MAX_BROWSER_SCREENSHOT_BASE64_LENGTH,
  AgentWsClientMessageSchema,
  BrowserHandoffAuthSchema,
  BrowserHandoffInputSchema,
} from "./agent";

describe("browser handoff contracts", () => {
  it("keeps agent control frames strict", () => {
    expect(
      AgentWsClientMessageSchema.parse({
        type: "browser_handoff_request",
        browserId: "browser-1",
      }),
    ).toMatchObject({ browserId: "browser-1" });
    expect(() =>
      AgentWsClientMessageSchema.parse({
        type: "browser_handoff_request",
        browserId: "browser-1",
        cdp: "ws://forbidden",
      }),
    ).toThrow();
  });

  it("allows only bounded input and never raw CDP or clipboard", () => {
    expect(
      BrowserHandoffInputSchema.parse({
        type: "pointer",
        action: "down",
        x: 1280,
        y: 720,
        button: "left",
        buttons: ["left"],
        clickCount: 2,
      }),
    ).toMatchObject({ type: "pointer" });
    expect(() =>
      BrowserHandoffInputSchema.parse({
        type: "cdp",
        method: "Network.getAllCookies",
      }),
    ).toThrow();
    expect(() =>
      BrowserHandoffInputSchema.parse({ type: "clipboard", text: "secret" }),
    ).toThrow();
    expect(() =>
      BrowserHandoffInputSchema.parse({
        type: "pointer",
        action: "down",
        x: 10,
        y: 10,
        clickCount: 4,
      }),
    ).toThrow();
    expect(() =>
      BrowserHandoffInputSchema.parse({
        type: "resize",
        width: 1281,
        height: 720,
      }),
    ).toThrow();
  });

  it("requires the one-time bearer token in a strict first frame", () => {
    const valid = {
      type: "auth",
      handoffId: "123e4567-e89b-12d3-a456-426614174000",
      token: "a".repeat(43),
    };
    expect(BrowserHandoffAuthSchema.parse(valid)).toEqual(valid);
    expect(() =>
      BrowserHandoffAuthSchema.parse({ ...valid, chatId: "other" }),
    ).toThrow();
  });
});

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
