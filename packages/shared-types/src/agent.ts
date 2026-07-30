/**
 * Zod schemas for the Agent Chat feature (Phase 1: contracts + gateway).
 *
 * Two surfaces are described here:
 *
 * 1. **Agent REST endpoints** on the gateway, next to the session CRUD:
 *    - `GET  /api/sessions/:id/screen?history=N` — plain-text screen capture
 *      (no ANSI) plus cursor/size/mode metadata, for feeding an LLM.
 *    - `POST /api/sessions/:id/keys` — inject literal text (never executes)
 *      or whitelisted named keys into a session.
 *
 * 2. **Agent chat WebSocket protocol** — JSON text frames, discriminated on
 *    `type`, mirroring the style of the terminal control messages in
 *    `terminal.ts`. There are no binary frames on the chat socket.
 *
 * Derived from apps/terminal-gateway/src/server.js — every field name and type
 * matches the actual JSON the gateway sends/receives. Do not invent fields.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// REST: GET /api/sessions/:id/screen  (plain-text screen capture + metadata)
// ---------------------------------------------------------------------------

/** Response body for GET /api/sessions/:id/screen (200 OK). */
export const ScreenResponseSchema = z.object({
  /** Plain-text pane contents (no ANSI escapes), wrapped lines joined.
   * Includes up to `history` lines of scrollback above the visible screen. */
  screen: z.string(),
  /** Cursor position within the visible pane (0-based, x=col, y=row). */
  cursor: z.object({ x: z.number().int(), y: z.number().int() }),
  /** Pane dimensions in character cells. */
  size: z.object({ cols: z.number().int(), rows: z.number().int() }),
  /** True when the pane is in the alternate screen (vim, htop, less, …). */
  altScreen: z.boolean(),
  /** The command currently running in the pane (e.g. "bash", "vim"). */
  currentCommand: z.string(),
});
export type ScreenResponse = z.infer<typeof ScreenResponseSchema>;

// ---------------------------------------------------------------------------
// REST: POST /api/sessions/:id/keys  (inject text or named keys)
// ---------------------------------------------------------------------------

/**
 * Named keys accepted by the `keys` variant of POST /api/sessions/:id/keys.
 * tmux key names — this exact whitelist is duplicated as a plain JS Set in
 * the gateway (which stays dependency-free). Keep the two in sync.
 */
export const AgentNamedKeySchema = z.enum([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "BSpace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "DC",
  "C-c",
  "C-d",
  "C-z",
  "C-l",
  "C-u",
  "C-r",
]);
export type AgentNamedKey = z.infer<typeof AgentNamedKeySchema>;

/**
 * Request body for POST /api/sessions/:id/keys. Exactly one of two shapes:
 * - `{ text }` — typed literally into the session; NEVER executes (no
 *   implicit Enter; multiline text goes through bracketed paste).
 * - `{ keys }` — whitelisted named keys (`AgentNamedKeySchema`), sent in order.
 */
export const SendKeysRequestSchema = z.union([
  z.object({ text: z.string().min(1).max(10000) }),
  z.object({ keys: z.array(AgentNamedKeySchema).min(1).max(32) }),
]);
export type SendKeysRequest = z.infer<typeof SendKeysRequestSchema>;

// ---------------------------------------------------------------------------
// Agent chat WebSocket: client -> server JSON text frames
// ---------------------------------------------------------------------------

/** User sends a chat message to the agent. */
export const AgentUserMessageSchema = z.object({
  type: z.literal("user_message"),
  /** The user's message text. */
  text: z.string(),
  /** Terminal session the user is currently viewing, if any. */
  activeSessionId: z.string().optional(),
});
export type AgentUserMessage = z.infer<typeof AgentUserMessageSchema>;

/** How the user answered an approval request. */
export const AgentApprovalBehaviorSchema = z.enum([
  "allow",
  "allow_always",
  "deny",
]);
export type AgentApprovalBehavior = z.infer<typeof AgentApprovalBehaviorSchema>;

/** User answers a pending `approval_request`. */
export const AgentApprovalResponseSchema = z.object({
  type: z.literal("approval_response"),
  /** Matches the `requestId` of the `approval_request` being answered. */
  requestId: z.string(),
  behavior: AgentApprovalBehaviorSchema,
});
export type AgentApprovalResponse = z.infer<typeof AgentApprovalResponseSchema>;

/** User interrupts the agent's current turn. */
export const AgentInterruptSchema = z.object({
  type: z.literal("interrupt"),
});
export type AgentInterrupt = z.infer<typeof AgentInterruptSchema>;

/** Client heartbeat ping. */
export const AgentPingSchema = z.object({
  type: z.literal("ping"),
});
export type AgentPing = z.infer<typeof AgentPingSchema>;

/** User asks for the list of past chats (to populate the history modal). */
export const AgentListChatsSchema = z.object({
  type: z.literal("list_chats"),
});
export type AgentListChats = z.infer<typeof AgentListChatsSchema>;

/** User deletes a past chat by id. The server replies with a fresh chat_list. */
export const AgentDeleteChatSchema = z.object({
  type: z.literal("delete_chat"),
  chatId: z.string(),
});
export type AgentDeleteChat = z.infer<typeof AgentDeleteChatSchema>;

const HandoffIdSchema = z.string().uuid();

/** Request manual control of an already-running isolated browser. */
export const BrowserHandoffRequestSchema = z
  .object({
    type: z.literal("browser_handoff_request"),
    browserId: z.string().min(1).max(128),
  })
  .strict();
export type BrowserHandoffRequest = z.infer<typeof BrowserHandoffRequestSchema>;

/** Return the unchanged browser session to the agent. */
export const BrowserHandoffFinishSchema = z
  .object({
    type: z.literal("browser_handoff_finish"),
    handoffId: HandoffIdSchema,
  })
  .strict();
export type BrowserHandoffFinish = z.infer<typeof BrowserHandoffFinishSchema>;

/** Destroy the complete isolated browser session. */
export const BrowserHandoffCancelSchema = z
  .object({
    type: z.literal("browser_handoff_cancel"),
    handoffId: HandoffIdSchema,
  })
  .strict();
export type BrowserHandoffCancel = z.infer<typeof BrowserHandoffCancelSchema>;

/** Discriminated union of all client -> server agent chat messages. */
export const AgentWsClientMessageSchema = z.discriminatedUnion("type", [
  AgentUserMessageSchema,
  AgentApprovalResponseSchema,
  AgentInterruptSchema,
  AgentPingSchema,
  AgentListChatsSchema,
  AgentDeleteChatSchema,
  BrowserHandoffRequestSchema,
  BrowserHandoffFinishSchema,
  BrowserHandoffCancelSchema,
]);
export type AgentWsClientMessage = z.infer<typeof AgentWsClientMessageSchema>;

// ---------------------------------------------------------------------------
// Agent chat WebSocket: server -> client JSON text frames
// ---------------------------------------------------------------------------

/** Server acknowledges a chat and reports its id. */
export const AgentChatStartedSchema = z.object({
  type: z.literal("chat_started"),
  chatId: z.string(),
  /** Terminal session that owns this conversation. */
  terminalSessionId: z.string().min(1),
});
export type AgentChatStarted = z.infer<typeof AgentChatStartedSchema>;

/** Incremental chunk of the assistant's in-progress reply. */
export const AgentAssistantDeltaSchema = z.object({
  type: z.literal("assistant_delta"),
  text: z.string(),
});
export type AgentAssistantDelta = z.infer<typeof AgentAssistantDeltaSchema>;

/** Complete assistant reply (final text; supersedes accumulated deltas). */
export const AgentAssistantMessageSchema = z.object({
  type: z.literal("assistant_message"),
  text: z.string(),
});
export type AgentAssistantMessage = z.infer<typeof AgentAssistantMessageSchema>;

/** Agent is invoking a tool. */
export const AgentToolUseSchema = z.object({
  type: z.literal("tool_use"),
  /** Correlates with the matching `tool_result`. */
  callId: z.string(),
  /** Tool name. */
  tool: z.string(),
  /** Terminal session the tool targets, if any. */
  sessionId: z.string().optional(),
  /** Human-readable one-line description of the call. */
  summary: z.string(),
  /** Raw tool input (tool-specific shape; not schema'd here). */
  input: z.unknown(),
});
export type AgentToolUse = z.infer<typeof AgentToolUseSchema>;

/** Result of a completed tool call. */
export const AgentToolResultSchema = z.object({
  type: z.literal("tool_result"),
  /** Matches the `callId` of the corresponding `tool_use`. */
  callId: z.string(),
  tool: z.string(),
  /** Whether the tool call succeeded. */
  ok: z.boolean(),
  /** Human-readable one-line description of the outcome. */
  summary: z.string().optional(),
});
export type AgentToolResult = z.infer<typeof AgentToolResultSchema>;

/** Agent asks the user to approve a tool call before it runs. */
export const AgentApprovalRequestSchema = z.object({
  type: z.literal("approval_request"),
  /** Id the client echoes back in its `approval_response`. */
  requestId: z.string(),
  tool: z.string(),
  /** Terminal session the tool targets, if any. */
  sessionId: z.string().optional(),
  /** Human-readable one-line description of what will run. */
  summary: z.string(),
  /** Raw tool input (tool-specific shape; not schema'd here). */
  input: z.unknown(),
});
export type AgentApprovalRequest = z.infer<typeof AgentApprovalRequestSchema>;

/** Coarse agent activity state, for status indicators. */
export const AgentStatusStateSchema = z.enum([
  "idle",
  "thinking",
  "acting",
  "awaiting_approval",
]);
export type AgentStatusState = z.infer<typeof AgentStatusStateSchema>;

/** Server reports the agent's current activity state. */
export const AgentStatusSchema = z.object({
  type: z.literal("status"),
  state: AgentStatusStateSchema,
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Server reports an error on the chat channel. */
export const AgentErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type AgentError = z.infer<typeof AgentErrorSchema>;

/** Server heartbeat pong (response to client ping). */
export const AgentPongSchema = z.object({
  type: z.literal("pong"),
});
export type AgentPong = z.infer<typeof AgentPongSchema>;

/** One terminal-scoped history row: display data from JSONL + durable owner. */
export const AgentChatSummarySchema = z.object({
  /** Chat id (== JSONL filename stem, resumable via ?resumeChatId=). */
  id: z.string(),
  /** Derived from the first user message; empty string if none yet. */
  title: z.string(),
  /** Last-modified time of the JSONL file, epoch milliseconds. */
  updatedAt: z.number(),
  /** Number of persisted messages (user + assistant + tool). */
  messageCount: z.number().int(),
  /** Terminal session this chat is linked to; null marks legacy history. */
  terminalSessionId: z.string().min(1).nullable(),
});
export type AgentChatSummary = z.infer<typeof AgentChatSummarySchema>;

/** Server reports the list of past chats (reply to list_chats / delete_chat). */
export const AgentChatListSchema = z.object({
  type: z.literal("chat_list"),
  chats: z.array(AgentChatSummarySchema),
});
export type AgentChatList = z.infer<typeof AgentChatListSchema>;

/**
 * One reconstructed transcript entry, replayed when a chat is resumed. The
 * server folds the stored OpenAI messages into these so the browser never sees
 * the raw model message format. `tool` entries carry the fields a live
 * `tool_use` + `tool_result` pair would have produced.
 */
export const AgentReplayEntrySchema = z.object({
  kind: z.enum(["user", "assistant", "tool"]),
  id: z.string(),
  /** user / assistant text. */
  text: z.string().optional(),
  /** tool: tool name. */
  tool: z.string().optional(),
  /** tool: session it targeted, if any. */
  sessionId: z.string().optional(),
  /** tool: one-line call summary. */
  summary: z.string().optional(),
  /** tool: raw input. */
  input: z.unknown().optional(),
  /** tool: whether the call succeeded (undefined when no result was recorded). */
  ok: z.boolean().optional(),
  /** tool: short outcome text on failure. */
  resultSummary: z.string().optional(),
});
export type AgentReplayEntry = z.infer<typeof AgentReplayEntrySchema>;

/**
 * Full transcript of a resumed chat, sent right after `chat_started` when the
 * chat has prior history. The client REPLACES its transcript with this (also
 * the correct resync on a transient reconnect — the server JSONL is truth).
 */
export const AgentChatHistorySchema = z.object({
  type: z.literal("chat_history"),
  chatId: z.string(),
  entries: z.array(AgentReplayEntrySchema),
});
export type AgentChatHistory = z.infer<typeof AgentChatHistorySchema>;

// Browser screenshots are transported only on the live WebSocket. Keep both
// their decoded size and their viewport bounded before the frontend creates an
// image URL; these frames are deliberately absent from persisted chat history.
export const MAX_BROWSER_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_BROWSER_SCREENSHOT_BASE64_LENGTH =
  Math.ceil(MAX_BROWSER_SCREENSHOT_BYTES / 3) * 4;
export const MAX_BROWSER_VIEWPORT_DIMENSION = 4096;

const BrowserIdSchema = z.string().min(1).max(128);
const BrowserRevisionSchema = z.number().int().nonnegative().safe();

export const AgentBrowserScreenshotSchema = z
  .object({
    mediaType: z.enum(["image/png", "image/webp"]),
    data: z
      .string()
      .min(1)
      .max(MAX_BROWSER_SCREENSHOT_BASE64_LENGTH)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine((value) => {
        const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
        return (value.length / 4) * 3 - padding <= MAX_BROWSER_SCREENSHOT_BYTES;
      }, "Screenshot exceeds decoded byte limit"),
  })
  .strict();
export type AgentBrowserScreenshot = z.infer<
  typeof AgentBrowserScreenshotSchema
>;

/** Latest read-only browser snapshot for the terminal overlay. */
export const AgentBrowserViewSchema = z
  .object({
    type: z.literal("browser_view"),
    browserId: BrowserIdSchema,
    revision: BrowserRevisionSchema,
    url: z
      .string()
      .max(2048)
      .url()
      .refine((value) => {
        try {
          const parsed = new URL(value);
          return (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            parsed.username === "" &&
            parsed.password === ""
          );
        } catch {
          return false;
        }
      }, "Browser URL must be HTTP(S) without embedded credentials"),
    title: z.string().max(512),
    viewport: z
      .object({
        width: z.number().int().min(1).max(MAX_BROWSER_VIEWPORT_DIMENSION),
        height: z.number().int().min(1).max(MAX_BROWSER_VIEWPORT_DIMENSION),
      })
      .strict(),
    screenshot: AgentBrowserScreenshotSchema,
  })
  .strict();
export type AgentBrowserView = z.infer<typeof AgentBrowserViewSchema>;

/** The owned browser was closed; clients discard its last ephemeral view. */
export const AgentBrowserClosedSchema = z
  .object({
    type: z.literal("browser_closed"),
    browserId: BrowserIdSchema,
    revision: BrowserRevisionSchema,
  })
  .strict();
export type AgentBrowserClosed = z.infer<typeof AgentBrowserClosedSchema>;

export const BrowserHandoffReadySchema = z
  .object({
    type: z.literal("browser_handoff_ready"),
    browserId: BrowserIdSchema,
    handoffId: HandoffIdSchema,
    token: z.string().min(43).max(128),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type BrowserHandoffReady = z.infer<typeof BrowserHandoffReadySchema>;

export const BrowserHandoffStateSchema = z
  .object({
    type: z.literal("browser_handoff_state"),
    browserId: BrowserIdSchema,
    handoffId: HandoffIdSchema.optional(),
    state: z.enum(["pending", "human_active", "agent_active", "closed"]),
    expiresAt: z.number().int().positive().safe().optional(),
    hardExpiresAt: z.number().int().positive().safe().optional(),
  })
  .strict();
export type BrowserHandoffState = z.infer<typeof BrowserHandoffStateSchema>;

// Dedicated /browser-handoff socket. Authentication is the first text frame;
// subsequent client frames are limited to these input events. There is no raw
// CDP, clipboard, file, cookie, upload, or download message in this union.
export const BrowserHandoffAuthSchema = z
  .object({
    type: z.literal("auth"),
    handoffId: HandoffIdSchema,
    token: z.string().min(43).max(128),
  })
  .strict();

export const BrowserHandoffTransportSchema = z.enum(["webrtc", "jpeg_ws"]);
export type BrowserHandoffTransport = z.infer<
  typeof BrowserHandoffTransportSchema
>;

export const BrowserHandoffVideoCodecSchema = z.enum(["VP8", "H264"]);
export type BrowserHandoffVideoCodec = z.infer<
  typeof BrowserHandoffVideoCodecSchema
>;

export const BrowserHandoffFallbackReasonSchema = z.enum([
  "client_unsupported",
  "media_provider_unavailable",
  "peer_limit",
  "negotiation_timeout",
  "ice_failed",
  "peer_failed",
  "client_requested",
]);
export type BrowserHandoffFallbackReason = z.infer<
  typeof BrowserHandoffFallbackReasonSchema
>;

/** Credentials are short-lived and delivered only after handoff authentication. */
export const BrowserHandoffIceServerSchema = z
  .object({
    urls: z.union([
      z.string().min(1).max(2048),
      z.array(z.string().min(1).max(2048)).min(1).max(4),
    ]),
    username: z.string().min(1).max(256).optional(),
    credential: z.string().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (server) => Boolean(server.username) === Boolean(server.credential),
    "ICE username and credential must be supplied together",
  );
export type BrowserHandoffIceServer = z.infer<
  typeof BrowserHandoffIceServerSchema
>;

export const BrowserHandoffCapabilitiesSchema = z
  .object({
    type: z.literal("capabilities"),
    protocolVersion: z.literal(1),
    transports: z.array(BrowserHandoffTransportSchema).min(1).max(2),
    videoCodecs: z.array(BrowserHandoffVideoCodecSchema).max(2),
    trickleIce: z.boolean(),
  })
  .strict();

const WebRtcNegotiationIdSchema = z.string().uuid();
const SessionDescriptionSchema = z
  .object({
    type: z.enum(["offer", "answer"]),
    sdp: z
      .string()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export const BrowserHandoffWebRtcAnswerSchema = z
  .object({
    type: z.literal("webrtc_answer"),
    negotiationId: WebRtcNegotiationIdSchema,
    description: SessionDescriptionSchema.refine(
      (description) => description.type === "answer",
    ),
  })
  .strict();

export const BrowserHandoffWebRtcIceCandidateSchema = z
  .object({
    type: z.literal("webrtc_ice_candidate"),
    negotiationId: WebRtcNegotiationIdSchema,
    candidate: z.string().max(4096),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(32).nullable().optional(),
    usernameFragment: z.string().max(256).optional(),
  })
  .strict();

export const BrowserHandoffFallbackRequestSchema = z
  .object({
    type: z.literal("transport_fallback"),
    negotiationId: WebRtcNegotiationIdSchema.optional(),
    reason: BrowserHandoffFallbackReasonSchema,
  })
  .strict();

export const BrowserHandoffHeartbeatSchema = z
  .object({
    type: z.literal("handoff_heartbeat"),
    sequence: z.number().int().nonnegative().safe(),
  })
  .strict();

export const BrowserHandoffTransportCapabilitiesSchema = z
  .object({
    type: z.literal("transport_capabilities"),
    protocolVersion: z.literal(1),
    preferred: BrowserHandoffTransportSchema,
    available: z.array(BrowserHandoffTransportSchema).min(1).max(2),
    videoCodecs: z.array(BrowserHandoffVideoCodecSchema).max(2),
    iceServers: z.array(BrowserHandoffIceServerSchema).max(8),
    negotiationTimeoutMs: z.number().int().min(1000).max(30_000),
  })
  .strict();

export const BrowserHandoffWebRtcOfferSchema = z
  .object({
    type: z.literal("webrtc_offer"),
    negotiationId: WebRtcNegotiationIdSchema,
    description: SessionDescriptionSchema.refine(
      (description) => description.type === "offer",
    ),
  })
  .strict();

export const BrowserHandoffTransportStateSchema = z
  .object({
    type: z.literal("transport_state"),
    transport: BrowserHandoffTransportSchema,
    state: z.enum(["negotiating", "connected", "failed", "fallback", "closed"]),
    reason: BrowserHandoffFallbackReasonSchema.optional(),
  })
  .strict();

export const BrowserHandoffHeartbeatAckSchema = z
  .object({
    type: z.literal("handoff_heartbeat_ack"),
    sequence: z.number().int().nonnegative().safe(),
  })
  .strict();

const HandoffModifierSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
export const BrowserHandoffInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("pointer"),
      action: z.enum(["move", "down", "up"]),
      x: z.number().finite().min(0).max(1280),
      y: z.number().finite().min(0).max(720),
      button: z.enum(["left", "middle", "right"]).optional(),
      buttons: z
        .array(z.enum(["left", "middle", "right"]))
        .max(3)
        .optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      x: z.number().finite().min(0).max(1280).optional(),
      y: z.number().finite().min(0).max(720).optional(),
      deltaX: z.number().finite().min(-2000).max(2000),
      deltaY: z.number().finite().min(-2000).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      action: z.enum(["down", "up"]),
      key: z.string().min(1).max(64),
      code: z.string().min(1).max(64),
      modifiers: z.array(HandoffModifierSchema).max(4),
    })
    .strict(),
  z
    .object({ type: z.literal("text"), text: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({
      type: z.literal("resize"),
      width: z.number().int().min(320).max(1280),
      height: z.number().int().min(240).max(720),
    })
    .strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);
export type BrowserHandoffAuth = z.infer<typeof BrowserHandoffAuthSchema>;
export type BrowserHandoffInput = z.infer<typeof BrowserHandoffInputSchema>;

export const BrowserHandoffPostAuthClientMessageSchema = z.union([
  BrowserHandoffInputSchema,
  BrowserHandoffCapabilitiesSchema,
  BrowserHandoffWebRtcAnswerSchema,
  BrowserHandoffWebRtcIceCandidateSchema,
  BrowserHandoffFallbackRequestSchema,
  BrowserHandoffHeartbeatSchema,
]);
export type BrowserHandoffPostAuthClientMessage = z.infer<
  typeof BrowserHandoffPostAuthClientMessageSchema
>;

export const BrowserHandoffServerControlSchema = z.union([
  BrowserHandoffTransportCapabilitiesSchema,
  BrowserHandoffWebRtcOfferSchema,
  BrowserHandoffWebRtcIceCandidateSchema,
  BrowserHandoffTransportStateSchema,
  BrowserHandoffHeartbeatAckSchema,
]);
export type BrowserHandoffServerControl = z.infer<
  typeof BrowserHandoffServerControlSchema
>;

/** Discriminated union of all server -> client agent chat messages. */
export const AgentWsServerMessageSchema = z.discriminatedUnion("type", [
  AgentChatStartedSchema,
  AgentAssistantDeltaSchema,
  AgentAssistantMessageSchema,
  AgentToolUseSchema,
  AgentToolResultSchema,
  AgentApprovalRequestSchema,
  AgentStatusSchema,
  AgentErrorSchema,
  AgentPongSchema,
  AgentChatListSchema,
  AgentChatHistorySchema,
  AgentBrowserViewSchema,
  AgentBrowserClosedSchema,
  BrowserHandoffReadySchema,
  BrowserHandoffStateSchema,
]);
export type AgentWsServerMessage = z.infer<typeof AgentWsServerMessageSchema>;
