/**
 * Schema round-trip tests for @sparklab/shared-types/terminal.
 *
 * Every test payload here mirrors the REAL shapes produced by
 * apps/terminal-gateway/src/server.js. If the server format changes, these
 * tests should break before any runtime UI does.
 */
import { describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ListSessionsResponseSchema,
  SessionInfoSchema,
  WsClientMessageSchema,
  WsErrorSchema,
  WsExitSchema,
  WsPingSchema,
  WsPongSchema,
  WsResizeSchema,
  WsServerMessageSchema,
} from "./terminal";

// ---------------------------------------------------------------------------
// REST: POST /api/sessions — request body
// ---------------------------------------------------------------------------

describe("CreateSessionRequestSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    const result = CreateSessionRequestSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts name only", () => {
    const result = CreateSessionRequestSchema.parse({ name: "my-session" });
    expect(result).toEqual({ name: "my-session" });
  });

  it("accepts name + cwd", () => {
    const result = CreateSessionRequestSchema.parse({
      name: "dev",
      cwd: "/home/user",
    });
    expect(result).toEqual({ name: "dev", cwd: "/home/user" });
  });

  it("rejects name as number", () => {
    expect(() => CreateSessionRequestSchema.parse({ name: 42 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// REST: POST /api/sessions — response body (201)
// ---------------------------------------------------------------------------

describe("CreateSessionResponseSchema", () => {
  it("parses a real gateway response", () => {
    // Mirrors: sendJson(res, 201, { id, name, createdAt }) in server.js
    const payload = {
      id: "web-550e8400-e29b-41d4-a716-446655440000",
      name: "my-session",
      createdAt: 1720900000000,
    };
    const result = CreateSessionResponseSchema.parse(payload);
    expect(result).toEqual(payload);
  });

  it("rejects missing createdAt", () => {
    expect(() =>
      CreateSessionResponseSchema.parse({
        id: "web-abc",
        name: "x",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// REST: GET /api/sessions — response body (200)
// ---------------------------------------------------------------------------

describe("SessionInfoSchema", () => {
  it("parses a real session entry", () => {
    // Mirrors the object pushed in listSessions() in server.js.
    const payload = {
      id: "web-550e8400-e29b-41d4-a716-446655440000",
      name: "my-session",
      createdAt: 1720900000000,
      tags: [],
      currentCommand: "bash",
      attached: false,
    };
    const result = SessionInfoSchema.parse(payload);
    expect(result).toEqual(payload);
  });

  it("accepts null createdAt (tmux may lack it)", () => {
    const payload = {
      id: "web-abc",
      name: "web-abc",
      createdAt: null,
      tags: [],
      currentCommand: "",
      attached: true,
    };
    expect(SessionInfoSchema.parse(payload)).toEqual(payload);
  });

  it("rejects missing id", () => {
    expect(() =>
      SessionInfoSchema.parse({
        name: "x",
        createdAt: 0,
        tags: [],
        currentCommand: "",
        attached: false,
      }),
    ).toThrow();
  });
});

describe("ListSessionsResponseSchema", () => {
  it("parses an array of sessions", () => {
    const payload = [
      {
        id: "web-a",
        name: "alpha",
        createdAt: 1720900000000,
        tags: [],
        currentCommand: "vim",
        attached: true,
      },
      {
        id: "web-b",
        name: "beta",
        createdAt: null,
        tags: [],
        currentCommand: "",
        attached: false,
      },
    ];
    const result = ListSessionsResponseSchema.parse(payload);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("web-a");
  });

  it("parses empty array", () => {
    expect(ListSessionsResponseSchema.parse([])).toEqual([]);
  });

  it("rejects non-array", () => {
    expect(() => ListSessionsResponseSchema.parse({ sessions: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// REST: error responses
// ---------------------------------------------------------------------------

describe("ApiErrorSchema", () => {
  it("parses a gateway error", () => {
    // Mirrors: sendJson(res, 4xx, { error: '...' }) in server.js
    const result = ApiErrorSchema.parse({ error: "session not found" });
    expect(result.error).toBe("session not found");
  });
});

// ---------------------------------------------------------------------------
// WebSocket: client -> server
// ---------------------------------------------------------------------------

describe("WsResizeSchema", () => {
  it("parses a resize message", () => {
    // Mirrors: msg.type === 'resize' check in ws.on('message') handler
    const payload = { type: "resize", cols: 120, rows: 40 };
    const result = WsResizeSchema.parse(payload);
    expect(result).toEqual(payload);
  });
});

describe("WsPingSchema", () => {
  it("parses a ping", () => {
    expect(WsPingSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
  });
});

describe("WsClientMessageSchema (discriminated union)", () => {
  it("resolves resize", () => {
    const msg = WsClientMessageSchema.parse({
      type: "resize",
      cols: 80,
      rows: 24,
    });
    expect(msg.type).toBe("resize");
    if (msg.type === "resize") {
      expect(msg.cols).toBe(80);
    }
  });

  it("resolves ping", () => {
    expect(WsClientMessageSchema.parse({ type: "ping" }).type).toBe("ping");
  });

  it("rejects unknown type", () => {
    expect(() => WsClientMessageSchema.parse({ type: "unknown" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// WebSocket: server -> client
// ---------------------------------------------------------------------------

describe("WsExitSchema", () => {
  it("parses an exit message", () => {
    // Mirrors: ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
    const result = WsExitSchema.parse({ type: "exit", code: 0 });
    expect(result).toEqual({ type: "exit", code: 0 });
  });
});

describe("WsPongSchema", () => {
  it("parses a pong", () => {
    expect(WsPongSchema.parse({ type: "pong" })).toEqual({ type: "pong" });
  });
});

describe("WsErrorSchema", () => {
  it("parses an error frame", () => {
    // Mirrors: ws.send(JSON.stringify({ type: 'error', message: '...' }))
    const result = WsErrorSchema.parse({
      type: "error",
      message: 'session "web-abc" does not exist',
    });
    expect(result.message).toBe('session "web-abc" does not exist');
  });
});

describe("WsServerMessageSchema (discriminated union)", () => {
  it("resolves exit", () => {
    const msg = WsServerMessageSchema.parse({ type: "exit", code: 1 });
    expect(msg.type).toBe("exit");
  });

  it("resolves pong", () => {
    expect(WsServerMessageSchema.parse({ type: "pong" }).type).toBe("pong");
  });

  it("resolves error", () => {
    const msg = WsServerMessageSchema.parse({
      type: "error",
      message: "bad",
    });
    expect(msg.type).toBe("error");
  });

  it("rejects unknown type", () => {
    expect(() => WsServerMessageSchema.parse({ type: "heartbeat" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Round-trip: JSON.stringify → JSON.parse → schema.parse
// ---------------------------------------------------------------------------

describe("round-trip serialization", () => {
  it("CreateSessionResponse survives JSON round-trip", () => {
    const original = {
      id: "web-123",
      name: "test",
      createdAt: Date.now(),
    };
    const roundTripped = JSON.parse(JSON.stringify(original)) as unknown;
    expect(CreateSessionResponseSchema.parse(roundTripped)).toEqual(original);
  });

  it("SessionInfo survives JSON round-trip with null createdAt", () => {
    const original = {
      id: "web-xyz",
      name: "web-xyz",
      createdAt: null,
      tags: ["tag-a"],
      currentCommand: "node",
      attached: true,
    };
    const roundTripped = JSON.parse(JSON.stringify(original)) as unknown;
    expect(SessionInfoSchema.parse(roundTripped)).toEqual(original);
  });

  it("WsServerMessage (error) survives round-trip", () => {
    const original = { type: "error" as const, message: "gone" };
    const roundTripped = JSON.parse(JSON.stringify(original)) as unknown;
    expect(WsServerMessageSchema.parse(roundTripped)).toEqual(original);
  });
});
