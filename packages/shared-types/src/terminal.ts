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
// Multi-server ("Connected Servers"): qualified session ids
// ---------------------------------------------------------------------------
//
// Session identity is (serverId, tmuxName). On the wire it is the QUALIFIED id
// `<serverId>/web-<uuid>` — REST path params, WS `?session=`, the frontend
// `activeSessionId`/`?session=` deep-link, and row equality all use this one
// string. The tmux name itself stays `web-<uuid>` (globally unique; validated
// against ID_RE on the gateway).
//
// Backward-compat rule: a bare `web-<uuid>` with NO `<serverId>/` prefix means
// `serverId = "local"`. `parseSessionRef` tolerates the bare form (old
// bookmarks, single-server clients); `formatSessionRef` always emits the
// canonical qualified form so the target host is self-describing everywhere.
//
// The gateway is plain dependency-free JS and CANNOT import this module at
// runtime (same reason it duplicates AGENT_NAMED_KEYS): it re-implements this
// exact split/join in `server.js`. THIS is the canonical reference — keep the
// two in sync.

/** The pre-registered default server. A bare, unqualified id resolves here. */
export const LOCAL_SERVER_ID = "local";

/** A session reference split into its server and tmux-name parts. */
export interface SessionRef {
  /** Registry server id (e.g. "local", "build01"). */
  serverId: string;
  /** The tmux session name (`web-<uuid>`). */
  tmuxName: string;
}

/**
 * Parse a session reference into (serverId, tmuxName).
 *
 * Splits on the FIRST "/": everything before is the serverId, everything after
 * is the tmux name. A ref with no "/" is a bare tmux name → serverId "local".
 * Does not validate either part (the gateway checks serverId against the
 * registry and tmuxName against ID_RE).
 */
export function parseSessionRef(ref: string): SessionRef {
  const slash = ref.indexOf("/");
  if (slash < 0) return { serverId: LOCAL_SERVER_ID, tmuxName: ref };
  return {
    serverId: ref.slice(0, slash) || LOCAL_SERVER_ID,
    tmuxName: ref.slice(slash + 1),
  };
}

/** Format (serverId, tmuxName) into the canonical qualified id. Always
 *  qualified — even for "local" — so the target host is never implicit. */
export function formatSessionRef(serverId: string, tmuxName: string): string {
  return `${serverId || LOCAL_SERVER_ID}/${tmuxName}`;
}

/** Normalize any accepted ref (bare or qualified) to the canonical qualified
 *  form. Use on the frontend to compare a URL/persisted id against the list. */
export function normalizeSessionRef(ref: string): string {
  const { serverId, tmuxName } = parseSessionRef(ref);
  return formatSessionRef(serverId, tmuxName);
}

// ---------------------------------------------------------------------------
// REST: POST /api/sessions  (create a new session)
// ---------------------------------------------------------------------------

/** Request body for POST /api/sessions. All fields optional. */
export const CreateSessionRequestSchema = z.object({
  /** Display name for the session. Defaults to the generated id on the server. */
  name: z.string().optional(),
  /** Working directory for the tmux session. Must be an existing directory. */
  cwd: z.string().optional(),
  /** Organization label for grouping (1-32 chars, no "/"). */
  org: z.string().optional(),
  /** Project label within an org (1-32 chars, no "/"). Requires org. */
  project: z.string().optional(),
  /** Target server id from the registry. Absent/omitted => "local" (implicit,
   * for backward-compatible single-server clients). */
  serverId: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/** Response body for POST /api/sessions (201 Created). */
export const CreateSessionResponseSchema = z.object({
  /** Qualified session id `<serverId>/web-<uuid>` (multi-server). A pre-
   * multi-server gateway returns the bare `web-<uuid>` form; parseSessionRef
   * treats that as serverId "local". */
  id: z.string(),
  /** Display name (either caller-supplied or defaults to the id). */
  name: z.string(),
  /** Unix epoch milliseconds when the session was created. */
  createdAt: z.number(),
  /** Server the session was created on. Absent from older gateways => "local". */
  serverId: z.string().optional(),
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

// ---------------------------------------------------------------------------
// REST: GET /api/sessions  (list sessions)
// ---------------------------------------------------------------------------

/** A single session in the GET /api/sessions response array. */
export const SessionInfoSchema = z.object({
  /** Qualified session id `<serverId>/web-<uuid>` (multi-server). This is the
   * one string the frontend uses for activeSessionId, row equality, and the
   * `?session=` deep-link. A pre-multi-server gateway sends the bare
   * `web-<uuid>` form (serverId "local"); normalizeSessionRef reconciles them. */
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
  /** Count of tmux clients attached to this session. */
  attachedClients: z.number().int().optional(),
  /** Unix epoch seconds when the session was last active. The gateway sends
   * null when tmux reports no activity timestamp; older gateways omit it. */
  lastActivity: z.number().nullable().optional(),
  /** Organization label. Null when unset; optional for older-gateway compat. */
  org: z.string().nullable().optional(),
  /** Project label within an org. Null when unset; optional for older-gateway compat. */
  project: z.string().nullable().optional(),
  /** When true, the gateway suppresses "job finished" push notifications for
   *  this session (global-per-session; enforced server-side in the poll loop).
   *  Absent from older gateways => treat as false (not muted). */
  muted: z.boolean().optional(),
  /** Registry id of the server this session lives on (e.g. "local",
   * "build01"). Redundant with the serverId embedded in `id`, but provided so
   * the frontend can group without parsing. Absent from older gateways => the
   * frontend treats it as "local". */
  serverId: z.string().optional(),
  /**
   * Whether this session's server was reachable when the list was built:
   * - true  => came from a live `tmux ls` on a reachable server.
   * - false => the server was UNREACHABLE ("couldn't ask"); this is a
   *   last-known entry from the gateway's metadata sidecar, NOT proof the
   *   session died. The frontend MUST render it greyed (bg-muted-foreground),
   *   never destructive-red, and MUST NOT prune it.
   * Absent from older gateways => treat as true (reachable).
   */
  reachable: z.boolean().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/** Response body for GET /api/sessions (200 OK). */
export const ListSessionsResponseSchema = z.array(SessionInfoSchema);
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

// ---------------------------------------------------------------------------
// REST: PATCH /api/sessions/:id  (update session metadata)
// ---------------------------------------------------------------------------

/** Request body for PATCH /api/sessions/:id. All fields optional; absent =
 *  unchanged. `null` clears the field (org:null also clears project). */
export const UpdateSessionRequestSchema = z.object({
  /** New display name. */
  name: z.string().optional(),
  /** Organization label; null clears org AND project. */
  org: z.string().nullable().optional(),
  /** Project label; null clears project. Requires org on the merged result. */
  project: z.string().nullable().optional(),
  /** Mute/unmute "job finished" push notifications for this session. */
  muted: z.boolean().optional(),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

/** Response body for PATCH /api/sessions/:id (200 OK). */
export const UpdateSessionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  org: z.string().nullable(),
  project: z.string().nullable(),
  muted: z.boolean(),
});
export type UpdateSessionResponse = z.infer<typeof UpdateSessionResponseSchema>;

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

/** Response body for GET /api/sessions/:id/scrollback. */
export const ScrollbackResponseSchema = z.object({ lines: z.string() });
export type ScrollbackResponse = z.infer<typeof ScrollbackResponseSchema>;

// ---------------------------------------------------------------------------
// REST: GET /api/sessions/:id/git  (VCS summary for the mini footer)
// ---------------------------------------------------------------------------
//
// A read-only git summary of the session's current working directory. Scoped to
// the ACTIVE session only (polled by the footer) — deliberately NOT part of GET
// /api/sessions. When the cwd is not inside a git work tree the gateway returns
// just `{ isRepo: false }`; all other fields are present only when isRepo.

/** Response body for GET /api/sessions/:id/git (200 OK). Derived from
 *  `git status --porcelain=v2 --branch`. When `isRepo` is false the footer
 *  renders nothing and every other field is absent. */
export const GitStatusResponseSchema = z.object({
  /** Whether the session's cwd is inside a git work tree. */
  isRepo: z.boolean(),
  /** Current branch name. Null on a detached HEAD with no resolvable short oid,
   *  or when isRepo is false. On a detached HEAD this holds the short commit. */
  branch: z.string().nullable().optional(),
  /** True when HEAD is detached (branch holds the short oid, not a name). */
  detached: z.boolean().optional(),
  /** Commits ahead of the upstream (0 when no upstream is configured). */
  ahead: z.number().int().optional(),
  /** Commits behind the upstream (0 when no upstream is configured). */
  behind: z.number().int().optional(),
  /** Files with staged (index) changes. May overlap with `unstaged`. */
  staged: z.number().int().optional(),
  /** Files with unstaged (worktree) changes. May overlap with `staged`. */
  unstaged: z.number().int().optional(),
  /** Untracked files. */
  untracked: z.number().int().optional(),
  /** Unmerged (conflicted) files. */
  conflicted: z.number().int().optional(),
  /** Distinct changed files (each entry counted once; the buckets above may
   *  overlap, so this is <= staged + unstaged + untracked + conflicted). */
  changed: z.number().int().optional(),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;

// ---------------------------------------------------------------------------
// REST: Web Push notifications  (/api/push/*)
// ---------------------------------------------------------------------------
//
// "Your job finished" push notifications. The gateway owns push end to end
// (it already runs `tmux list-sessions`, the signal source; it is the single
// auth/session enforcement point; it owns all sidecar-JSON persistence). It
// polls session `pane_current_command` while ≥1 subscription exists and, on a
// non-shell→shell transition, sends a Web Push (RFC 8291, via the `web-push`
// lib) to every stored subscription. See docs/PUSH-NOTIFICATIONS-PLAN.md.
//
// The gateway is dependency-free JS and CANNOT import this module; the JSON it
// emits is kept in lockstep with these schemas by hand.

/** A browser PushSubscription serialized via `PushSubscription.toJSON()`. The
 *  `endpoint` is a plain URL for whatever push service the browser uses (FCM
 *  for Chrome, Mozilla autopush for Firefox, Windows/Apple for others) — kept
 *  host-agnostic on purpose. `keys` carries the ECDH public key (`p256dh`) and
 *  the auth secret used for aes128gcm payload encryption. */
export const PushSubscriptionSchema = z.object({
  /** Push service delivery URL. Opaque; never assume a host. */
  endpoint: z.string().url(),
  /** Optional expiry (epoch ms) the browser may report; usually null. */
  expirationTime: z.number().nullable().optional(),
  /** Encryption material from the browser subscription. */
  keys: z.object({
    /** Base64url-encoded P-256 ECDH public key. */
    p256dh: z.string().min(1),
    /** Base64url-encoded auth secret (16 bytes). */
    auth: z.string().min(1),
  }),
});
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;

/** Request body for POST /api/push/subscribe — the browser subscription. */
export const PushSubscribeRequestSchema = PushSubscriptionSchema;
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequestSchema>;

/** Request body for POST /api/push/unsubscribe — identify the subscription to
 *  drop by its endpoint URL (the store's dedup key). */
export const PushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
});
export type PushUnsubscribeRequest = z.infer<
  typeof PushUnsubscribeRequestSchema
>;

/** Response body for GET /api/push/vapid-public-key. When push isn't
 *  configured server-side (no VAPID keys), `configured` is false and
 *  `publicKey` is absent — the client shows the toggle disabled rather than
 *  crashing. */
export const VapidPublicKeyResponseSchema = z.object({
  /** Whether the gateway has valid VAPID keys and can send push at all. */
  configured: z.boolean(),
  /** Base64url VAPID application server public key (present iff configured). */
  publicKey: z.string().optional(),
});
export type VapidPublicKeyResponse = z.infer<
  typeof VapidPublicKeyResponseSchema
>;

/** Response body for POST /api/push/subscribe and /unsubscribe (200/201). */
export const PushSubscribeResponseSchema = z.object({
  /** True once the subscription is stored (subscribe) or after removal
   *  (unsubscribe — idempotent, true even if it wasn't present). */
  ok: z.boolean(),
  /** Current count of stored subscriptions (all devices). */
  count: z.number().int(),
});
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponseSchema>;

/** Global push preferences (single-user), stored in the gateway's
 *  push-settings.json sidecar. GET /api/push/settings returns this full shape. */
export const PushSettingsSchema = z.object({
  /** Minimum job duration (ms) before a "finished" notification fires. Jobs
   *  shorter than this are suppressed (they're rarely worth an alert, and
   *  sub-poll-interval jobs are already invisible). Default 30000. */
  minDurationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000),
  /** When true, also fire a ONE-TIME "still running" alert when a job crosses
   *  minDurationMs while still running. Default false. */
  notifyOnStart: z.boolean(),
});
export type PushSettings = z.infer<typeof PushSettingsSchema>;

/** Request body for PUT /api/push/settings — a partial patch; absent fields are
 *  unchanged. */
export const PushSettingsUpdateSchema = PushSettingsSchema.partial();
export type PushSettingsUpdate = z.infer<typeof PushSettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// File Explorer: /api/sessions/:id/fs/*
// ---------------------------------------------------------------------------
//
// The explorer browses the filesystem of the server a session lives on
// (local or ssh), keyed by the qualified session id. The gateway is
// dependency-free JS and CANNOT import this module — the JSON it emits from
// server.js is kept in lockstep with these schemas by hand. Every field here
// matches the actual JSON; invent nothing.

/** Kind of a directory entry, derived from GNU `find`'s `%y` type char:
 *  `d`->dir, `f`->file, `l`->symlink, anything else (block/char/socket/fifo)
 *  ->other. */
export const FsEntryTypeSchema = z.enum(["file", "dir", "symlink", "other"]);
export type FsEntryType = z.infer<typeof FsEntryTypeSchema>;

/** One entry in a directory listing (GET /fs/list). */
export const FsEntrySchema = z.object({
  /** Basename only (not a full path). May contain spaces/quotes/tabs. */
  name: z.string(),
  /** Entry kind. */
  type: FsEntryTypeSchema,
  /** Size in bytes (find `%s`). For directories this is the dir's own size. */
  size: z.number(),
  /** Last-modified time in Unix epoch MILLISECONDS (find `%T@` seconds * 1000,
   *  rounded). Null when find reported an unparseable timestamp. */
  mtime: z.number().nullable(),
  /** Permission bits in octal as a string (find `%m`, e.g. "755", "644"). */
  mode: z.string(),
  /** For symlinks only: the raw link target (find `%l`). Absent otherwise. */
  symlinkTarget: z.string().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

/** Response body for GET /api/sessions/:id/fs/list (200 OK). */
export const FsListResponseSchema = z.object({
  /** The absolute directory that was listed (the resolved cwd when `path` was
   *  omitted from the request). */
  path: z.string(),
  /** Directory entries (dotfiles excluded unless `showHidden` was set). */
  entries: z.array(FsEntrySchema),
  /** Present and true only when the listing was capped (5000 entries). */
  truncated: z.boolean().optional(),
});
export type FsListResponse = z.infer<typeof FsListResponseSchema>;

/** Response body for GET /api/sessions/:id/fs/read (200 OK). Text preview,
 *  capped at 256 KB. Binary files (a NUL byte in the buffer) omit `content`
 *  and set `encoding: null` — the client offers Download instead. */
export const FsReadResponseSchema = z.object({
  /** The absolute file path that was read. */
  path: z.string(),
  /** True size of the file in bytes (may exceed the returned `content`). */
  size: z.number(),
  /** Whether the file was detected as binary (a NUL byte in the read buffer). */
  binary: z.boolean(),
  /** Whether the file exceeded the 256 KB read cap (content is the first cap
   *  bytes). Always false for binary files (no content is returned). */
  truncated: z.boolean(),
  /** "utf-8" for text, `null` for binary. */
  encoding: z.enum(["utf-8"]).nullable(),
  /** The file text (first cap bytes, utf-8). Present only for non-binary
   *  files; omitted when `binary` is true. */
  content: z.string().optional(),
});
export type FsReadResponse = z.infer<typeof FsReadResponseSchema>;

// GET /api/sessions/:id/fs/download?path=<abs> — streams the raw file bytes
// with Content-Type application/octet-stream and a Content-Disposition
// attachment header. Not JSON; no schema.

/** Request body for POST /api/sessions/:id/fs/mkdir. */
export const FsMkdirRequestSchema = z.object({
  /** Absolute path of the directory to create (fails if it already exists). */
  path: z.string(),
});
export type FsMkdirRequest = z.infer<typeof FsMkdirRequestSchema>;

/** Response body for POST /api/sessions/:id/fs/mkdir (201 Created). */
export const FsMkdirResponseSchema = z.object({ path: z.string() });
export type FsMkdirResponse = z.infer<typeof FsMkdirResponseSchema>;

/** Request body for PATCH /api/sessions/:id/fs/entry (rename/move). */
export const FsRenameRequestSchema = z.object({
  /** Absolute source path. */
  from: z.string(),
  /** Absolute destination path. */
  to: z.string(),
  /** When absent/false the gateway refuses to clobber an existing `to` (409). */
  overwrite: z.boolean().optional(),
});
export type FsRenameRequest = z.infer<typeof FsRenameRequestSchema>;

/** Response body for PATCH /api/sessions/:id/fs/entry (200 OK). */
export const FsRenameResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type FsRenameResponse = z.infer<typeof FsRenameResponseSchema>;

// DELETE /api/sessions/:id/fs/entry?path=<abs>&recursive=0 — 200 OK with
// { path }. A non-empty directory requires recursive=1 (else 409).
/** Response body for DELETE /api/sessions/:id/fs/entry (200 OK). */
export const FsDeleteResponseSchema = z.object({ path: z.string() });
export type FsDeleteResponse = z.infer<typeof FsDeleteResponseSchema>;

/** Response body for POST /api/sessions/:id/fs/upload (200 OK). The request
 *  body is the RAW file bytes (not JSON); the destination is the `path` query
 *  param. Capped at 8 MB (413 past it). */
export const FsUploadResponseSchema = z.object({
  /** Absolute destination path written. */
  path: z.string(),
  /** Number of bytes written. */
  size: z.number(),
});
export type FsUploadResponse = z.infer<typeof FsUploadResponseSchema>;

// ---------------------------------------------------------------------------
// Multi-server ("Connected Servers"): server registry
// ---------------------------------------------------------------------------
//
// The registry is CONFIG, not state — it lives in a gitignored servers.json
// next to the gateway .env, NOT in tmux. SSH auth is key-based only; no
// password ever crosses this contract or is stored anywhere.

/** A registry server id. Hyphen-safe and must NOT contain "/" (it is the
 *  prefix before "/" in a qualified session id). */
export const ServerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'server id must be alphanumeric with - or _ (no "/")',
  );
export type ServerId = z.infer<typeof ServerIdSchema>;

/** How the gateway reaches a server. "local" = the gateway host's own tmux
 *  (no ssh); "ssh" = tmux run over `ssh <host>`. */
export const ServerTypeSchema = z.enum(["local", "ssh"]);
export type ServerType = z.infer<typeof ServerTypeSchema>;

/** Live reachability of a server, from a cached `ssh <host> true` probe.
 *  "local" is always "ok". "unreachable" means "couldn't ask" — never "dead". */
export const ServerReachabilitySchema = z.enum(["ok", "unreachable"]);
export type ServerReachability = z.infer<typeof ServerReachabilitySchema>;

/** How a server authenticates over SSH. `password` means a password is stored
 *  server-side (in the gitignored servers.json); the value itself is NEVER sent
 *  over the wire — only which method is in use. Absent for type "local". */
export const ServerAuthMethodSchema = z.enum(["key", "password"]);
export type ServerAuthMethod = z.infer<typeof ServerAuthMethodSchema>;

/** One entry in the GET /api/servers response. Note: `identityFile` is a path
 *  on the gateway host and is NOT a secret, but is omitted from the response by
 *  default (no edit UI in the MVP); the field is optional for forward compat.
 *  A password (when used) is stored server-side only and never appears here. */
export const ServerInfoSchema = z.object({
  /** Registry id (e.g. "local", "build01"). */
  id: ServerIdSchema,
  /** Human-readable display name shown in the sidebar group header. */
  name: z.string(),
  /** "local" (the gateway host) or "ssh" (a remote reached over ssh). */
  type: ServerTypeSchema,
  /** SSH host/ip. Absent for type "local". */
  host: z.string().optional(),
  /** SSH user. Absent for type "local"; defaults to the ssh config user. */
  user: z.string().optional(),
  /** SSH port. Absent => 22. */
  port: z.number().int().optional(),
  /** SSH identity file path on the gateway host. Usually omitted in responses. */
  identityFile: z.string().optional(),
  /** Cached reachability from the last `ssh <host> true` probe. */
  reachability: ServerReachabilitySchema,
  /** Unix epoch ms of the last reachability probe. Null if never probed. */
  lastProbeAt: z.number().nullable().optional(),
  /** Which SSH auth method this server uses ("key" | "password"). The password
   *  value itself is never sent. Absent for type "local"; optional for
   *  older-gateway compat (treat absent as "key"). */
  authMethod: ServerAuthMethodSchema.optional(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

/** Response body for GET /api/servers (200 OK). Always includes the implicit
 *  "local" server as the first entry. */
export const ListServersResponseSchema = z.array(ServerInfoSchema);
export type ListServersResponse = z.infer<typeof ListServersResponseSchema>;

/** Request body for POST /api/servers (register an ssh server). `type` is
 *  fixed to "ssh" on create — "local" is pre-registered and cannot be added.
 *  Auth is key-based by default; supply `password` for password auth. */
export const CreateServerRequestSchema = z.object({
  /** Desired registry id (unique). */
  id: ServerIdSchema,
  /** Display name. */
  name: z.string().min(1).max(64),
  /** SSH host/ip. */
  host: z.string().min(1),
  /** SSH user. Optional (falls back to ssh config). */
  user: z.string().optional(),
  /** SSH port. Optional => 22. */
  port: z.number().int().min(1).max(65535).optional(),
  /** SSH identity file path on the gateway host. Optional (key auth). */
  identityFile: z.string().optional(),
  /** SSH password. Optional. When set, the gateway uses password auth and
   *  stores this (plaintext) in the gitignored servers.json; it is never
   *  returned by any endpoint. Takes precedence over identityFile. */
  password: z.string().optional(),
});
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;

/** Response body for POST /api/servers (201 Created): the stored entry. */
export const CreateServerResponseSchema = ServerInfoSchema;
export type CreateServerResponse = z.infer<typeof CreateServerResponseSchema>;

// DELETE /api/servers/:id — 204 No Content on success. "local" cannot be
// deleted (400). No request/response body.

/** Request body for POST /api/servers/test — probe connection params WITHOUT
 *  saving (the "Test connection" button in the add-server dialog). Same shape
 *  as a create request. */
export const TestServerRequestSchema = CreateServerRequestSchema;
export type TestServerRequest = z.infer<typeof TestServerRequestSchema>;

/** Response body for POST /api/servers/test and POST /api/servers/:id/test. */
export const TestServerResponseSchema = z.object({
  /** "ok" if `ssh <host> true` succeeded, else "unreachable". */
  reachability: ServerReachabilitySchema,
  /** Human-readable failure detail when unreachable (stderr summary). */
  error: z.string().optional(),
});
export type TestServerResponse = z.infer<typeof TestServerResponseSchema>;
