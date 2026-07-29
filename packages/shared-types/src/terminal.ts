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
  /** Last captured job exit code from the shell hook's `@web_last_exit`
   *  (bash/zsh, gateway-created sessions only). Null/absent when unknown
   *  (other shell, pre-existing session, or consumed after a notification). */
  exitCode: z.number().int().nullable().optional(),
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
// REST: POST /api/sessions/:id/codex  (run the Codex CLI as an agent tool)
// ---------------------------------------------------------------------------
//
// Runs `codex exec` NON-INTERACTIVELY on the session's server, rooted at the
// session's current working directory (via `-C <cwd>`). The sandbox is caller-
// selected but clamped to the two safe modes below — danger-full-access and the
// `--dangerously-bypass-*` flags are never reachable through this contract, and
// Codex is given no network or out-of-cwd access. Invocation is approval-gated
// in the agent (a write tool), so this contract carries no auth of its own
// beyond the standard cookie + Origin guard applied to every POST.

/** Codex sandbox policy. "read-only" can only read/analyze; "workspace-write"
 *  may additionally modify files WITHIN the session cwd (never elsewhere). */
export const CodexSandboxModeSchema = z.enum(["read-only", "workspace-write"]);
export type CodexSandboxMode = z.infer<typeof CodexSandboxModeSchema>;

/** Request body for POST /api/sessions/:id/codex. */
export const CodexRunRequestSchema = z.object({
  /** The task/instruction handed to Codex (piped via stdin, never argv). */
  prompt: z.string().min(1).max(16384),
  /** Sandbox policy; the gateway defaults to "read-only" when omitted. */
  mode: CodexSandboxModeSchema.optional(),
});
export type CodexRunRequest = z.infer<typeof CodexRunRequestSchema>;

/** Response body for POST /api/sessions/:id/codex (200 OK). Returned even when
 *  Codex exits non-zero, so the agent can see what happened; transport-level
 *  failures (not installed -> 503, timeout -> 504) use error status codes. */
export const CodexRunResponseSchema = z.object({
  /** The sandbox policy Codex actually ran under. */
  mode: CodexSandboxModeSchema,
  /** The resolved session cwd Codex was rooted at. */
  cwd: z.string(),
  /** Codex's process exit code (0 on success; null if it couldn't be captured). */
  exitCode: z.number().int().nullable(),
  /** Combined stdout+stderr, capped (see `truncated`). */
  output: z.string(),
  /** True when `output` was cut to the output cap. */
  truncated: z.boolean(),
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: z.number().int(),
});
export type CodexRunResponse = z.infer<typeof CodexRunResponseSchema>;

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

// ---------------------------------------------------------------------------
// REST: Kanban /api/kanban/*
// ---------------------------------------------------------------------------
// A gateway-owned, multi-board task tracker. State lives in a data/kanban.json
// sidecar (see apps/terminal-gateway/src/kanban.js). Ordering authority is
// Column.cardIds[] ONLY — cards carry no columnId/order (a derived `columnId`
// is added to GET responses for consumer convenience but never persisted).
// Every board carries a monotonic `rev` for optimistic concurrency (see D3 in
// docs/KANBAN-PLAN.md); a `move` with a stale rev is rejected 409.

/** A single Kanban card. Persisted shape carries no column/order — position is
 *  determined solely by the enclosing Column.cardIds[]. */
export const KanbanCardSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(512),
  description: z.string().max(8192).default(""),
  tags: z.array(z.string().min(1).max(64)).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Derived on GET (the id of the column currently holding this card). Never
   *  persisted — Column.cardIds is the source of truth. */
  columnId: z.string().optional(),
});
export type KanbanCard = z.infer<typeof KanbanCardSchema>;

/** A board column. `cardIds` is the ordered, authoritative card sequence. */
export const KanbanColumnSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  cardIds: z.array(z.string()),
});
export type KanbanColumn = z.infer<typeof KanbanColumnSchema>;

/** A full board with its columns and cards. Returned by GET /api/kanban/boards/:id. */
export const KanbanBoardSchema = z.object({
  id: z.string(),
  /** The project name. */
  name: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(64)),
  /** Monotonic revision; bumped on every mutation of this board (optimistic concurrency). */
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  columns: z.array(KanbanColumnSchema),
  cards: z.array(KanbanCardSchema),
});
export type KanbanBoard = z.infer<typeof KanbanBoardSchema>;

/** Lightweight board row for the list view (no cards/columns payload). */
export const KanbanBoardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  columnCount: z.number().int(),
  cardCount: z.number().int(),
});
export type KanbanBoardSummary = z.infer<typeof KanbanBoardSummarySchema>;

/** Response body for GET /api/kanban/boards (200 OK). */
export const KanbanListResponseSchema = z.object({
  boards: z.array(KanbanBoardSummarySchema),
});
export type KanbanListResponse = z.infer<typeof KanbanListResponseSchema>;

/** Request body for POST /api/kanban/boards (create a board). `columns` is
 *  optional; when omitted the gateway seeds Backlog/To Do/In Progress/Done. */
export const CreateBoardRequestSchema = z.object({
  name: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(64)).default([]),
  columns: z.array(z.string().min(1).max(128)).optional(),
});
export type CreateBoardRequest = z.infer<typeof CreateBoardRequestSchema>;

/** Request body for PATCH /api/kanban/boards/:boardId. */
export const UpdateBoardRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    tags: z.array(z.string().min(1).max(64)).optional(),
  })
  .refine((b) => b.name !== undefined || b.tags !== undefined, {
    message: "at least one of name/tags is required",
  });
export type UpdateBoardRequest = z.infer<typeof UpdateBoardRequestSchema>;

/** Request body for POST /api/kanban/boards/:boardId/cards. Defaults to the
 *  first column when columnId is omitted. */
export const CreateCardRequestSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(8192).default(""),
  tags: z.array(z.string().min(1).max(64)).default([]),
  columnId: z.string().optional(),
});
export type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;

/** Request body for PATCH /api/kanban/cards/:cardId. `boardId` locates the card. */
export const UpdateCardRequestSchema = z
  .object({
    boardId: z.string(),
    title: z.string().min(1).max(512).optional(),
    description: z.string().max(8192).optional(),
    tags: z.array(z.string().min(1).max(64)).optional(),
  })
  .refine(
    (c) =>
      c.title !== undefined ||
      c.description !== undefined ||
      c.tags !== undefined,
    { message: "at least one of title/description/tags is required" },
  );
export type UpdateCardRequest = z.infer<typeof UpdateCardRequestSchema>;

/** Request body for POST /api/kanban/cards/:cardId/move. `rev` is the board
 *  revision the client observed; a mismatch is rejected 409 (stale). */
export const MoveCardRequestSchema = z.object({
  boardId: z.string(),
  toColumnId: z.string(),
  toIndex: z.number().int().min(0),
  rev: z.number().int(),
});
export type MoveCardRequest = z.infer<typeof MoveCardRequestSchema>;

// ---------------------------------------------------------------------------
// REST: Project-management tool /api/pm/*
// ---------------------------------------------------------------------------
// A Kanban-first PM suite (docs/PM-TOOL-PLAN.md), a separate artifact from
// Kanban. State in data/pm.json (src/pm.js). Like Kanban: Column.taskIds[] is
// the sole ordering/status authority (a task's `columnId`/`status` are derived
// on GET, never persisted); per-project `rev` for optimistic concurrency on
// move. Additions: task fields (assignee/priority/labels/dates), sprints
// (orthogonal to columns; backlog = sprintId null), and a per-project
// dependency DAG (dependsOn; a cycle is rejected 400).

export const PmPrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
export type PmPriority = z.infer<typeof PmPrioritySchema>;

/** Issue type — drives the card glyph, hierarchy validation, and filtering.
 *  Hierarchy (§5.6): Epic → Story/Task/Bug → Subtask (max depth 3). */
export const PmIssueTypeSchema = z.enum([
  "epic",
  "story",
  "task",
  "bug",
  "subtask",
]);
export type PmIssueType = z.infer<typeof PmIssueTypeSchema>;

/** A task. Persisted shape carries no status/order — position/status come from
 *  the enclosing Column.taskIds[]. `columnId` and `key` are derived on GET. */
export const PmTaskSchema = z.object({
  id: z.string(),
  /** Per-project issue number (with project.key ⇒ derived key "PAY-43"). */
  number: z.number().int(),
  title: z.string().min(1).max(512),
  description: z.string().max(8192).default(""),
  /** Issue type; hierarchy edges validated against §5.6. */
  type: PmIssueTypeSchema.default("task"),
  assignee: z.string().max(128).nullable().default(null),
  /** Creating actor (advisory, P2); auto-added to watchers. */
  reporter: z.string().nullable().default(null),
  priority: PmPrioritySchema.nullable().default(null),
  labels: z.array(z.string().min(1).max(64)).default([]),
  /** Epoch ms (day-level), nullable — drives the Gantt view. */
  startDate: z.number().nullable().default(null),
  dueDate: z.number().nullable().default(null),
  /** Owning sprint, or null for the product backlog (orthogonal to columns). */
  sprintId: z.string().nullable().default(null),
  /** Parent task id (containment edge, same project) — hierarchy, not scheduling. */
  parentId: z.string().nullable().default(null),
  /** Actors watching this task (reporter/assignee/commenters). */
  watchers: z.array(z.string()).default([]),
  /** Ids of other tasks in THIS project this task depends on (a DAG). */
  dependsOn: z.array(z.string()).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Derived on GET (the column currently holding this task); never persisted. */
  columnId: z.string().nullable().optional(),
  /** Derived on GET (project.key + "-" + number, e.g. "PAY-43"); never persisted. */
  key: z.string().optional(),
});
export type PmTask = z.infer<typeof PmTaskSchema>;

/** A status column. `taskIds` is the ordered, authoritative task sequence. */
export const PmColumnSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  taskIds: z.array(z.string()),
  /** Per-column WIP limit (int ≥1) or null = unlimited (enforcement Phase 2). */
  wipLimit: z.number().int().min(1).nullable().default(null),
  /** Allowed destination column ids, or null = any (enforcement Phase 2). */
  transitions: z.array(z.string()).nullable().default(null),
});
export type PmColumn = z.infer<typeof PmColumnSchema>;

/** A sprint / iteration. Orthogonal to columns. */
export const PmSprintSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128),
  startDate: z.number().nullable().default(null),
  endDate: z.number().nullable().default(null),
});
export type PmSprint = z.infer<typeof PmSprintSchema>;

/** A full project. Returned by GET /api/pm/projects/:id. */
export const PmProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  /** Unique project key (^[A-Z][A-Z0-9]{1,9}$) — the prefix of issue keys. */
  key: z.string(),
  /** Monotonic per-project issue-number counter. */
  seq: z.number().int(),
  tags: z.array(z.string().min(1).max(64)),
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  columns: z.array(PmColumnSchema),
  sprints: z.array(PmSprintSchema),
  tasks: z.array(PmTaskSchema),
});
export type PmProject = z.infer<typeof PmProjectSchema>;

/** Lightweight project row for the list view. */
export const PmProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  tags: z.array(z.string()),
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
  columnCount: z.number().int(),
  taskCount: z.number().int(),
  sprintCount: z.number().int(),
});
export type PmProjectSummary = z.infer<typeof PmProjectSummarySchema>;

/** Response body for GET /api/pm/projects (200 OK). */
export const PmListResponseSchema = z.object({
  projects: z.array(PmProjectSummarySchema),
});
export type PmListResponse = z.infer<typeof PmListResponseSchema>;

/** Request body for POST /api/pm/projects. Omitting columns seeds the defaults. */
export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  /** Optional explicit project key; derived from name when omitted. */
  key: z.string().min(2).max(10).optional(),
  tags: z.array(z.string().min(1).max(64)).default([]),
  columns: z.array(z.string().min(1).max(128)).optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** Request body for PATCH /api/pm/projects/:id. */
export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    key: z.string().min(2).max(10).optional(),
    tags: z.array(z.string().min(1).max(64)).optional(),
  })
  .refine(
    (b) => b.name !== undefined || b.tags !== undefined || b.key !== undefined,
    { message: "at least one of name/key/tags is required" },
  );
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

/** Request body for POST /api/pm/projects/:id/tasks. */
export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1).max(512),
  description: z.string().max(8192).default(""),
  type: PmIssueTypeSchema.optional(),
  assignee: z.string().max(128).optional(),
  reporter: z.string().optional(),
  priority: PmPrioritySchema.optional(),
  labels: z.array(z.string().min(1).max(64)).default([]),
  startDate: z.number().nullable().optional(),
  dueDate: z.number().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  columnId: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/** Request body for PATCH /api/pm/tasks/:id. `projectId` locates the task. */
export const UpdateTaskRequestSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(512).optional(),
  description: z.string().max(8192).optional(),
  type: PmIssueTypeSchema.optional(),
  assignee: z.string().max(128).nullable().optional(),
  reporter: z.string().nullable().optional(),
  priority: PmPrioritySchema.nullable().optional(),
  labels: z.array(z.string().min(1).max(64)).optional(),
  startDate: z.number().nullable().optional(),
  dueDate: z.number().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

/** Request body for POST /api/pm/tasks/:id/move (rev-guarded — D3). */
export const MoveTaskRequestSchema = z.object({
  projectId: z.string(),
  toColumnId: z.string(),
  toIndex: z.number().int().min(0),
  rev: z.number().int(),
});
export type MoveTaskRequest = z.infer<typeof MoveTaskRequestSchema>;

/** Request body for POST /api/pm/projects/:id/columns. */
export const CreateColumnRequestSchema = z.object({
  name: z.string().min(1).max(128),
  index: z.number().int().min(0).optional(),
  wipLimit: z.number().int().min(1).nullable().optional(),
  transitions: z.array(z.string()).nullable().optional(),
});
export type CreateColumnRequest = z.infer<typeof CreateColumnRequestSchema>;

/** Request body for PATCH /api/pm/columns/:colId. */
export const UpdateColumnRequestSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(128).optional(),
  wipLimit: z.number().int().min(1).nullable().optional(),
  transitions: z.array(z.string()).nullable().optional(),
});
export type UpdateColumnRequest = z.infer<typeof UpdateColumnRequestSchema>;

/** Request body for POST /api/pm/columns/:colId/move (rev-guarded). */
export const MoveColumnRequestSchema = z.object({
  projectId: z.string(),
  toIndex: z.number().int().min(0),
  rev: z.number().int(),
});
export type MoveColumnRequest = z.infer<typeof MoveColumnRequestSchema>;

/** Request body for POST /api/pm/projects/:id/sprints. */
export const CreateSprintRequestSchema = z.object({
  name: z.string().min(1).max(128),
  startDate: z.number().nullable().optional(),
  endDate: z.number().nullable().optional(),
});
export type CreateSprintRequest = z.infer<typeof CreateSprintRequestSchema>;

/** Request body for PATCH /api/pm/sprints/:id. */
export const UpdateSprintRequestSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(128).optional(),
  startDate: z.number().nullable().optional(),
  endDate: z.number().nullable().optional(),
});
export type UpdateSprintRequest = z.infer<typeof UpdateSprintRequestSchema>;

// ---------------------------------------------------------------------------
// REST: PM Collaboration /api/pm/* (Phase 3 — comments/activity/attachments/watchers/notifications)
// ---------------------------------------------------------------------------

/** A comment on a task. Stored in a JSONL sidecar, not pm.json. */
export const PmCommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  author: z.string(),
  body: z.string().max(8192),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
});
export type PmComment = z.infer<typeof PmCommentSchema>;

/** Request body for POST /api/pm/tasks/:id/comments. */
export const AddCommentRequestSchema = z.object({
  body: z.string().min(1).max(8192),
});
export type AddCommentRequest = z.infer<typeof AddCommentRequestSchema>;

/** Request body for PATCH /api/pm/comments/:id. */
export const EditCommentRequestSchema = z.object({
  projectId: z.string(),
  taskId: z.string().optional(),
  body: z.string().min(1).max(8192),
});
export type EditCommentRequest = z.infer<typeof EditCommentRequestSchema>;

/** An activity / audit record. Append-only, never edited or deleted. */
export const PmActivitySchema = z.object({
  id: z.string(),
  ts: z.number(),
  actor: z.string(),
  verb: z.string(),
  target: z.object({
    type: z.string(),
    id: z.string(),
  }),
  taskId: z.string().optional(),
  summary: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type PmActivity = z.infer<typeof PmActivitySchema>;

/** Attachment metadata (the blob is served separately via GET). */
export const PmAttachmentMetaSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  filename: z.string(),
  size: z.number(),
  contentType: z.string(),
  actor: z.string(),
  createdAt: z.number(),
});
export type PmAttachmentMeta = z.infer<typeof PmAttachmentMetaSchema>;

/** An in-app notification for watchers. */
export const PmNotificationSchema = z.object({
  id: z.string(),
  recipient: z.string(),
  event: z.string(),
  taskId: z.string().nullable(),
  projectId: z.string().nullable(),
  summary: z.string(),
  createdAt: z.number(),
  readAt: z.number().nullable(),
});
export type PmNotification = z.infer<typeof PmNotificationSchema>;

/** Request body for POST /api/pm/notifications/read. */
export const MarkNotificationsReadRequestSchema = z.object({
  ids: z.array(z.string()).optional(),
  all: z.boolean().optional(),
});
export type MarkNotificationsReadRequest = z.infer<
  typeof MarkNotificationsReadRequestSchema
>;

// ---------------------------------------------------------------------------
// REST: Agentic AI Creator /api/agentic/*
// ---------------------------------------------------------------------------
// A third gateway-owned pluggable artifact (docs/AGENTIC-AI-CREATOR-PLAN.md),
// separate from Kanban and PM. State lives in a data/agentic.json sidecar
// (apps/terminal-gateway/src/agentic.js) with FOUR top-level collections:
// agents, connections, agenticAis, runs. Like Kanban/PM, mutators are fully
// synchronous (atomic read-modify-write, no mutex). `rev` guards edits on
// agents/agenticAis/connections; `runs` carry NO rev (only the gateway's own
// poll/marker/approval paths mutate them — no cross-client race). Ordering /
// structure authority is agentIds[] + workflow.edges (D8/§2). An AgenticAI
// carries a monotonic `version` bumped on every definition edit (D9); each Run
// snapshots the version + resolved config it executed with, for reproducibility.
// NOTE (iteration 1): the CRUD surface only. Run records stay empty until the
// run engine (startRun/reducer/tmux) lands in a later iteration.

/** Backend that powers an Agent (D6). */
export const AgentRuntimeProviderSchema = z.enum(["codex-cli", "claude-cli"]);
export type AgentRuntimeProvider = z.infer<typeof AgentRuntimeProviderSchema>;

/** Sandbox mode for a spawned agent-task step — clamped in code (D4). */
export const AgentSandboxModeSchema = z.enum(["read-only", "workspace-write"]);
export type AgentSandboxMode = z.infer<typeof AgentSandboxModeSchema>;

/** Per-connection, per-tool policy for one Agent (D5). `tools` is either the
 *  literal "all" or an explicit tool-name allowlist. `policy` is the default
 *  disposition the per-run proxy applies to matching calls. */
export const AgentToolPolicySchema = z.object({
  connectionId: z.string(),
  tools: z.union([z.literal("all"), z.array(z.string().min(1).max(128))]),
  policy: z.enum(["allow", "deny", "approval"]),
});
export type AgentToolPolicy = z.infer<typeof AgentToolPolicySchema>;

/** One team member inside an Agentic AI, backed by a runtime provider. */
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(512),
  runtimeProvider: AgentRuntimeProviderSchema,
  /** Free-form label ("supervisor"/"worker"/"reviewer"); not enforced. */
  role: z.string().max(128).nullable().default(null),
  systemPrompt: z.string().max(8192).default(""),
  sandboxMode: AgentSandboxModeSchema.default("read-only"),
  toolPolicies: z.array(AgentToolPolicySchema).default([]),
  /** Optional model override; null = provider default. */
  model: z.string().max(256).nullable().default(null),
  /** Monotonic revision; bumped on every mutation (optimistic concurrency). */
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** Scoped access from an Agentic AI's agents to another artifact's MCP server. */
export const ArtifactConnectionSchema = z.object({
  id: z.string(),
  targetType: z.enum(["pm", "kanban"]),
  scope: z.enum(["fixed", "runtime-selection"]),
  /** A specific project/board id, when scope = "fixed". */
  targetId: z.string().nullable().default(null),
  createdAt: z.number(),
  /** Monotonic revision (optional — connections are POST/DELETE only, no PATCH). */
  rev: z.number().int().optional(),
});
export type ArtifactConnection = z.infer<typeof ArtifactConnectionSchema>;

/** One workflow node. DAG-shaped from day one so future node types are additive. */
export const WorkflowNodeSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["agent-task"]),
  /** The Agent that executes this node (for type = "agent-task"). */
  agentId: z.string().optional(),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

/** A directed edge between two workflow nodes. */
export const WorkflowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

/** The workflow DAG. Empty/absent is allowed (default {[],[],null}). */
export const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
  entryNodeId: z.string().nullable().default(null),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** A full Agentic AI (catalog entry). Returned by GET /api/agentic/apps/:id. */
export const AgenticAiSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(512),
  description: z.string().max(8192).default(""),
  objectiveTemplate: z.string().max(8192).default(""),
  status: z.enum(["draft", "published", "paused", "archived"]),
  orchestrationMode: z.enum(["single", "supervisor", "sequential", "parallel"]),
  /** Member agent ids; order = supervisor/pipeline order. */
  agentIds: z.array(z.string()).default([]),
  connectionIds: z.array(z.string()).default([]),
  workflow: WorkflowDefinitionSchema,
  /** Monotonic definition version, bumped on every definition edit (D9). */
  version: z.number().int(),
  /** Monotonic revision (optimistic concurrency). */
  rev: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AgenticAi = z.infer<typeof AgenticAiSchema>;

/** Lightweight catalog row for GET /api/agentic/apps. Counts derived on GET. */
export const AgenticAiSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["draft", "published", "paused", "archived"]),
  orchestrationMode: z.enum(["single", "supervisor", "sequential", "parallel"]),
  /** Derived on GET (agentIds.length); never persisted. */
  agentCount: z.number().int(),
  /** Derived on GET (connectionIds.length); never persisted. */
  connectionCount: z.number().int(),
  version: z.number().int(),
  updatedAt: z.number(),
});
export type AgenticAiSummary = z.infer<typeof AgenticAiSummarySchema>;

/** A node's current/last MCP tool-call approval record (D5, iter3). PERSISTED
 *  (unlike `logTail`) — it is the durable half of the per-run proxy's
 *  approval-mediation ledger. */
export const PendingToolCallSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  connectionId: z.string().nullable(),
  argsPreview: z.string(),
  status: z.enum(["pending", "approved", "rejected", "timed_out"]),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  reason: z.string().nullable(),
});
export type PendingToolCall = z.infer<typeof PendingToolCallSchema>;

/** One entry in a run's bounded MCP tool-call audit log (D5, iter3). */
export const ToolCallLogEntrySchema = z.object({
  id: z.string(),
  nodeId: z.string().nullable(),
  toolName: z.string(),
  connectionId: z.string().nullable(),
  targetType: z.string().nullable(),
  disposition: z.enum(["allow", "deny", "approved", "rejected", "timed_out"]),
  argsPreview: z.string(),
  at: z.number(),
});
export type ToolCallLogEntry = z.infer<typeof ToolCallLogEntrySchema>;

/** One workflow step's durable execution record (D3 — the run's position). */
export const NodeExecutionSchema = z.object({
  nodeId: z.string(),
  status: z.enum([
    "pending",
    "running",
    "waiting-approval",
    "done",
    "failed",
    "skipped",
  ]),
  /** Ties an agent-task step to its tmux job (D3 layer 1). */
  agentRunId: z.string().nullable().optional(),
  /** For parallel fan-out: the parent step whose children these are. */
  parentNodeId: z.string().nullable().optional(),
  startedAt: z.number().nullable().optional(),
  finishedAt: z.number().nullable().optional(),
  /** The node's current/last MCP tool-call approval record, if any (D5, iter3). */
  pendingToolCall: PendingToolCallSchema.nullable().optional(),
  /** Derived on GET (tailed step log); never persisted. */
  logTail: z.string().optional(),
});
export type NodeExecution = z.infer<typeof NodeExecutionSchema>;

/** One execution of an Agentic AI. Returned by GET /api/agentic/runs/:id. */
export const RunSchema = z.object({
  id: z.string(),
  agenticAiId: z.string(),
  /** Snapshot of the definition version this run executed with (D9). */
  agenticAiVersion: z.number().int(),
  /** Frozen, resolved config (agents+workflow+toolPolicies) at start time (D9). */
  resolvedConfig: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().nullable().default(null),
  objective: z.string().default(""),
  status: z.enum([
    "queued",
    "running",
    "waiting-approval",
    "completed",
    "failed",
    "cancelled",
  ]),
  /** The durable workflow ledger — this array IS the run's position (D3). */
  nodeExecutions: z.array(NodeExecutionSchema).default([]),
  /** Bounded MCP tool-call audit log (D5, iter3) — oldest entries trimmed. */
  toolCallLog: z.array(ToolCallLogEntrySchema).default([]),
  startedAt: z.number().nullable().default(null),
  finishedAt: z.number().nullable().default(null),
});
export type Run = z.infer<typeof RunSchema>;

/** Lightweight run row for GET /api/agentic/runs (no nodeExecutions/logs). */
export const RunSummarySchema = z.object({
  id: z.string(),
  agenticAiId: z.string(),
  agenticAiVersion: z.number().int(),
  status: z.enum([
    "queued",
    "running",
    "waiting-approval",
    "completed",
    "failed",
    "cancelled",
  ]),
  objective: z.string(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** Request body for POST /api/agentic/agents. */
export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1).max(512),
  runtimeProvider: AgentRuntimeProviderSchema,
  role: z.string().max(128).optional(),
  systemPrompt: z.string().max(8192).default(""),
  sandboxMode: AgentSandboxModeSchema.default("read-only"),
  toolPolicies: z.array(AgentToolPolicySchema).optional(),
  model: z.string().max(256).nullable().optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** Request body for PATCH /api/agentic/agents/:id (partial; ≥1 field). */
export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().min(1).max(512).optional(),
    runtimeProvider: AgentRuntimeProviderSchema.optional(),
    role: z.string().max(128).nullable().optional(),
    systemPrompt: z.string().max(8192).optional(),
    sandboxMode: AgentSandboxModeSchema.optional(),
    toolPolicies: z.array(AgentToolPolicySchema).optional(),
    model: z.string().max(256).nullable().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.runtimeProvider !== undefined ||
      b.role !== undefined ||
      b.systemPrompt !== undefined ||
      b.sandboxMode !== undefined ||
      b.toolPolicies !== undefined ||
      b.model !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

/** Request body for POST /api/agentic/connections. */
export const CreateConnectionRequestSchema = z.object({
  targetType: z.enum(["pm", "kanban"]),
  scope: z.enum(["fixed", "runtime-selection"]).default("fixed"),
  targetId: z.string().nullable().optional(),
});
export type CreateConnectionRequest = z.infer<
  typeof CreateConnectionRequestSchema
>;

/** Request body for POST /api/agentic/apps (creates at version 1, draft). */
export const CreateAgenticAiRequestSchema = z.object({
  name: z.string().min(1).max(512),
  description: z.string().max(8192).optional(),
  objectiveTemplate: z.string().max(8192).optional(),
  orchestrationMode: z
    .enum(["single", "supervisor", "sequential", "parallel"])
    .default("single"),
  agentIds: z.array(z.string()).default([]),
  connectionIds: z.array(z.string()).optional(),
  workflow: WorkflowDefinitionSchema.optional(),
});
export type CreateAgenticAiRequest = z.infer<
  typeof CreateAgenticAiRequestSchema
>;

/** Request body for PATCH /api/agentic/apps/:id (partial; bumps version, D9). */
export const UpdateAgenticAiRequestSchema = z
  .object({
    name: z.string().min(1).max(512).optional(),
    description: z.string().max(8192).optional(),
    objectiveTemplate: z.string().max(8192).optional(),
    orchestrationMode: z
      .enum(["single", "supervisor", "sequential", "parallel"])
      .optional(),
    agentIds: z.array(z.string()).optional(),
    connectionIds: z.array(z.string()).optional(),
    workflow: WorkflowDefinitionSchema.optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.description !== undefined ||
      b.objectiveTemplate !== undefined ||
      b.orchestrationMode !== undefined ||
      b.agentIds !== undefined ||
      b.connectionIds !== undefined ||
      b.workflow !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateAgenticAiRequest = z.infer<
  typeof UpdateAgenticAiRequestSchema
>;

/** Request body for PATCH /api/agentic/apps/:id/status — "publish" (D8). */
export const UpdateAgenticAiStatusRequestSchema = z.object({
  status: z.enum(["draft", "published", "paused", "archived"]),
});
export type UpdateAgenticAiStatusRequest = z.infer<
  typeof UpdateAgenticAiStatusRequestSchema
>;

/** Request body for POST .../nodes/:nodeId/pending-tool-call (proxy -> gateway,
 *  D5 iter3). */
export const PendingToolCallRequestSchema = z.object({
  toolName: z.string().min(1).max(256),
  connectionId: z.string().nullable().optional(),
  argsPreview: z.string().max(1024).optional(),
});
export type PendingToolCallRequest = z.infer<
  typeof PendingToolCallRequestSchema
>;

/** Request body for POST .../nodes/:nodeId/approve (human, D5 iter3 plan §3). */
export const ApproveNodeRequestSchema = z.object({
  pendingId: z.string().optional(),
});
export type ApproveNodeRequest = z.infer<typeof ApproveNodeRequestSchema>;

/** Request body for POST .../nodes/:nodeId/reject (human, D5 iter3 plan §3). */
export const RejectNodeRequestSchema = z.object({
  pendingId: z.string().optional(),
  reason: z.string().max(2048).optional(),
});
export type RejectNodeRequest = z.infer<typeof RejectNodeRequestSchema>;
