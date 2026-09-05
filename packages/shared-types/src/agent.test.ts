import { describe, expect, it } from "vitest";

import {
  AgentBrowserClosedSchema,
  AgentBrowserViewSchema,
  AgentUserMessageSchema,
  AgentWsServerMessageSchema,
  MAX_BROWSER_SCREENSHOT_BASE64_LENGTH,
  AgentWsClientMessageSchema,
  BrowserHandoffAuthSchema,
  BrowserHandoffInputSchema,
  BrowserHandoffPostAuthClientMessageSchema,
  BrowserHandoffServerControlSchema,
  OpenRouterCatalogModelSchema,
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

  it("bounds WebRTC signaling without making raw control APIs representable", () => {
    const negotiationId = "123e4567-e89b-12d3-a456-426614174000";
    expect(
      BrowserHandoffPostAuthClientMessageSchema.parse({
        type: "webrtc_answer",
        negotiationId,
        description: { type: "answer", sdp: "v=0\r\n" },
      }),
    ).toMatchObject({ type: "webrtc_answer" });
    expect(
      BrowserHandoffServerControlSchema.parse({
        type: "webrtc_offer",
        negotiationId,
        description: { type: "offer", sdp: "v=0\r\n" },
      }),
    ).toMatchObject({ type: "webrtc_offer" });
    expect(() =>
      BrowserHandoffPostAuthClientMessageSchema.parse({
        type: "webrtc_answer",
        negotiationId,
        description: { type: "offer", sdp: "v=0\r\n" },
      }),
    ).toThrow();
    expect(() =>
      BrowserHandoffPostAuthClientMessageSchema.parse({
        type: "webrtc_ice_candidate",
        negotiationId,
        candidate: "x".repeat(4097),
      }),
    ).toThrow();
    expect(() =>
      BrowserHandoffPostAuthClientMessageSchema.parse({
        type: "cdp",
        method: "Runtime.evaluate",
      }),
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
    expect(
      AgentWsServerMessageSchema.parse({ type: "agent_snapshot", seq: 12 }),
    ).toEqual({ type: "agent_snapshot", seq: 12 });
    expect(
      AgentWsServerMessageSchema.parse({
        type: "agent_event",
        seq: 13,
        frame: { type: "status", state: "thinking" },
      }),
    ).toMatchObject({ seq: 13 });
    expect(
      AgentWsClientMessageSchema.parse({
        type: "recovery_ack",
        behavior: "verified",
      }),
    ).toMatchObject({ behavior: "verified" });
    expect(
      AgentWsServerMessageSchema.parse({
        type: "recovery_required",
        message: "Verify state",
      }),
    ).toMatchObject({ type: "recovery_required" });
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
    expect(
      AgentWsServerMessageSchema.parse({
        type: "browser_handoff_state",
        browserId: "browser-1",
        handoffId: "123e4567-e89b-12d3-a456-426614174000",
        state: "human_active",
        expiresAt: 1_800_000_120_000,
        hardExpiresAt: 1_800_000_600_000,
      }),
    ).toMatchObject({ hardExpiresAt: 1_800_000_600_000 });
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

describe("OpenRouter dynamic catalog contracts", () => {
  it("openrouterModelId on user_message is optional and bounded", () => {
    expect(
      AgentUserMessageSchema.parse({ type: "user_message", text: "hi" }),
    ).not.toHaveProperty("openrouterModelId");
    expect(
      AgentUserMessageSchema.parse({
        type: "user_message",
        text: "hi",
        model: "openrouter-gpt-latest",
        openrouterModelId: "openai/gpt-6-astra",
      }),
    ).toMatchObject({ openrouterModelId: "openai/gpt-6-astra" });
    expect(() =>
      AgentUserMessageSchema.parse({
        type: "user_message",
        text: "hi",
        openrouterModelId: "a".repeat(201),
      }),
    ).toThrow();
    expect(() =>
      AgentUserMessageSchema.parse({
        type: "user_message",
        text: "hi",
        openrouterModelId: "",
      }),
    ).toThrow();
  });

  it("OpenRouterCatalogModelSchema accepts a model with and without reasoning", () => {
    const withReasoning = OpenRouterCatalogModelSchema.parse({
      id: "openai/gpt-6-astra",
      name: "OpenAI: GPT-6 Astra",
      contextLength: 1_050_000,
      pricing: { prompt: "0.00001", completion: "0.00005" },
      reasoning: {
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        mandatory: true,
      },
    });
    expect(withReasoning.reasoning?.mandatory).toBe(true);

    const withoutReasoning = OpenRouterCatalogModelSchema.parse({
      id: "z-ai/glm-5.2:free",
      name: "GLM 5.2 (free)",
      contextLength: 128_000,
      pricing: { prompt: "0", completion: "0" },
    });
    expect(withoutReasoning.reasoning).toBeUndefined();
  });

  it("rejects a reasoning block with an empty supportedEfforts array", () => {
    expect(() =>
      OpenRouterCatalogModelSchema.parse({
        id: "a/b",
        name: "n",
        contextLength: 1,
        pricing: { prompt: "0", completion: "0" },
        reasoning: { supportedEfforts: [], mandatory: false },
      }),
    ).toThrow();
  });

  it("openrouter_models_request / _response round-trip through the WS unions", () => {
    expect(
      AgentWsClientMessageSchema.parse({ type: "openrouter_models_request" }),
    ).toMatchObject({ type: "openrouter_models_request" });

    const response = AgentWsServerMessageSchema.parse({
      type: "openrouter_models_response",
      fetchedAt: 1_777_000_000_000,
      models: [
        {
          id: "z-ai/glm-5.2:free",
          name: "GLM 5.2 (free)",
          contextLength: 128_000,
          pricing: { prompt: "0", completion: "0" },
        },
      ],
    });
    expect(response).toMatchObject({ type: "openrouter_models_response" });

    expect(
      AgentWsServerMessageSchema.parse({
        type: "openrouter_models_response",
        fetchedAt: Date.now(),
        models: [],
      }),
    ).toMatchObject({ models: [] });
  });
});
