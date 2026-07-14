/**
 * Zod schemas for the terminal gateway wire protocol.
 *
 * Derived from apps/terminal-gateway/src/server.js — every field name and type
 * matches the actual JSON the gateway sends/receives. Do not invent fields.
 *
 * ## Wire protocol overview
 *
 * The gateway uses a split frame-type convention on the WebSocket:
 * - **Binary frames** carry raw terminal I/O (pty output server->client,
 *   keystrokes client->server). These are NOT JSON and are NOT schema'd here.
 * - **Text (JSON) frames** carry control messages, described below.
 *
 * REST endpoints live under /api/sessions.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// REST: POST /api/sessions  (create a new session)
// ---------------------------------------------------------------------------

/** Request body for POST /api/sessions. All fields optional. */
export const CreateSessionRequestSchema = z.object({
  /** Display name for the session. Defaults to the generated id on the server. */
  name: z.string().optional(),
  /** Working directory for the tmux session. Must be an existing directory. */
  cwd: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/** Response body for POST /api/sessions (201 Created). */
export const CreateSessionResponseSchema = z.object({
  /** Session id, always prefixed with "web-" followed by a UUID. */
  id: z.string(),
  /** Display name (either caller-supplied or defaults to the id). */
  name: z.string(),
  /** Unix epoch milliseconds when the session was created. */
  createdAt: z.number(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

// ---------------------------------------------------------------------------
// REST: GET /api/sessions  (list sessions)
// ---------------------------------------------------------------------------

/** A single session in the GET /api/sessions response array. */
export const SessionInfoSchema = z.object({
  /** Session id (web-<uuid>). */
  id: z.string(),
  /** Human-readable display name. */
  name: z.string(),
  /**
   * Unix epoch milliseconds when created. Nullable because tmux's
   * session_created epoch may be absent or metadata may lack it.
   */
  createdAt: z.number().nullable(),
  /** User-assigned tags (currently always empty array; reserved for future). */
  tags: z.array(z.string()),
  /** The command currently running in the session's active pane. */
  currentCommand: z.string(),
  /** Whether at least one tmux client is attached to this session. */
  attached: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/** Response body for GET /api/sessions (200 OK). */
export const ListSessionsResponseSchema = z.array(SessionInfoSchema);
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

// ---------------------------------------------------------------------------
// REST: DELETE /api/sessions/:id  (kill a session)
// ---------------------------------------------------------------------------
// Success: 204 No Content (empty body).
// No request body. No response body on success.

// ---------------------------------------------------------------------------
// REST: Error responses (400, 404, 500)
// ---------------------------------------------------------------------------

/** Error response body returned by all REST endpoints on failure. */
export const ApiErrorSchema = z.object({
  error: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// WebSocket: client -> server JSON text frames
// ---------------------------------------------------------------------------

/** Client requests a terminal resize. */
export const WsResizeSchema = z.object({
  type: z.literal("resize"),
  cols: z.number(),
  rows: z.number(),
});
export type WsResize = z.infer<typeof WsResizeSchema>;

/** Client heartbeat ping. */
export const WsPingSchema = z.object({
  type: z.literal("ping"),
});
export type WsPing = z.infer<typeof WsPingSchema>;

/** Discriminated union of all client -> server control messages. */
export const WsClientMessageSchema = z.discriminatedUnion("type", [
  WsResizeSchema,
  WsPingSchema,
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

// ---------------------------------------------------------------------------
// WebSocket: server -> client JSON text frames
// ---------------------------------------------------------------------------

/** Server reports the pty/shell exited. */
export const WsExitSchema = z.object({
  type: z.literal("exit"),
  code: z.number(),
});
export type WsExit = z.infer<typeof WsExitSchema>;

/** Server heartbeat pong (response to client ping). */
export const WsPongSchema = z.object({
  type: z.literal("pong"),
});
export type WsPong = z.infer<typeof WsPongSchema>;

/** Server reports an error (e.g. invalid session id, session not found). */
export const WsErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});
export type WsError = z.infer<typeof WsErrorSchema>;

/** Discriminated union of all server -> client control messages. */
export const WsServerMessageSchema = z.discriminatedUnion("type", [
  WsExitSchema,
  WsPongSchema,
  WsErrorSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
