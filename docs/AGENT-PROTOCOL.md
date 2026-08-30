# Agent Chat protocol

The **agent service** (`apps/agent-service`, default port 3009) runs a custom
tool-calling loop over Azure OpenAI GPT-5.6 deployments and lets the
user drive their terminals from a chat panel. It is a **fourth independent
lifetime** alongside browser / gateway / tmux: it can crash or restart without
touching any attached pty, because it operates terminals **only** through the
gateway REST API — never tmux directly.

```
Browser chat panel ──WS /agent (JSON)──► agent-service ──REST──► gateway ──► tmux
```

## Configuration (`.env`, gitignored)

| Var                                           | Purpose                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`                       | Azure AI Foundry resource endpoint                                                                                              |
| `AZURE_OPENAI_API_KEY`                        | secret — never committed                                                                                                        |
| `AZURE_OPENAI_API_VERSION`                    | pinned, default `2025-04-01-preview`                                                                                            |
| `GPT56SOL_DEPLOYMENT`                         | model deployment name (`gpt-5.6-sol`)                                                                                           |
| `GPT56TERRA_DEPLOYMENT`                       | optional deployment; enables `gpt-5.6-terra` in the composer                                                                    |
| `GPT56LUNA_DEPLOYMENT`                        | optional deployment; enables `gpt-5.6-luna` in the composer                                                                     |
| `ARK_API_KEY`                                 | optional; enables the BytePlus Ark models (`deepseek-v4-pro-byteplus`, `deepseek-v32-byteplus`, `glm-byteplus`) in the composer |
| `ARK_BASE_URL`                                | optional Ark base URL (default `https://ark.ap-southeast.bytepluses.com`)                                                       |
| `ARK_DEEPSEEK_DEPLOYMENT`                     | optional Ark id for `deepseek-v4-pro-byteplus` (default `deepseek-v4-pro-260425`)                                               |
| `ARK_DEEPSEEK_V32_DEPLOYMENT`                 | optional Ark id for `deepseek-v32-byteplus` (default `deepseek-v3-2-251201`)                                                    |
| `ARK_GLM_DEPLOYMENT`                          | optional Ark id for `glm-byteplus` (default `glm-4-7-251222`)                                                                   |
| `AGENT_PORT`                                  | listen port (default 3009)                                                                                                      |
| `GATEWAY_URL`                                 | gateway base URL (loopback in prod)                                                                                             |
| `ALLOWED_ORIGINS`                             | browser origins allowed to open `/agent`                                                                                        |
| `GATEWAY_AUTH_USER` / `GATEWAY_AUTH_PASSWORD` | gateway login (omit in open mode)                                                                                               |
| `BROWSER_USE_PROJECT`                         | trusted local Browser Use checkout; unset disables browser tools                                                                |
| `BROWSER_USE_HEADLESS`                        | run the isolated browser headless (default `true`)                                                                              |
| `BROWSER_USE_EXECUTABLE_PATH`                 | optional explicit sandboxed Chromium executable                                                                                 |

The service fails fast at startup if any required Azure var is missing.
The composer sends an allowlisted public model id and reasoning effort for each
turn; the service maps it to a private deployment name and only advertises
models configured on that service. Most models run on Azure OpenAI; the
optional `*-byteplus` ids (`deepseek-v4-pro-byteplus`, `deepseek-v32-byteplus`,
`glm-byteplus`) route to BytePlus Ark instead (OpenAI-compatible REST, Bearer
auth, no `reasoning_effort` — the composer hides the effort control for any
`-byteplus` model; DeepSeek also gets `thinking` disabled). A first-turn empty
reply surfaces an `error` frame rather than silently ending the turn.

Each WebSocket includes `terminalSessionId` in its query string. With no other
chat selector, the service resumes the newest chat linked to that terminal. An
explicit `resumeChatId` resumes a selected history row, while `newChat=1`
creates another chat for the same terminal.

## Auth

On WS upgrade the service mirrors the gateway's posture:

1. **Origin allowlist** _before_ the handshake (an absent `Origin`, e.g. a
   non-browser client, is allowed — same as the gateway's `/attach`).
2. **Cookie auth** _after_ the handshake: the browser's `Cookie` is proxied to
   the gateway's `GET /api/auth/me`; a non-200 closes the socket with code
   **4001** (contractual "do not reconnect"). In gateway open mode, `me`
   returns 200 and the socket is accepted.

The service itself logs in to the gateway with `GATEWAY_AUTH_USER` /
`GATEWAY_AUTH_PASSWORD` (skipped in open mode) and reuses the `gw_session`
cookie, re-logging in on a 401.

## WebSocket messages

JSON **text** frames only — there are no binary frames on `/agent` (that split
is reserved for the terminal's `/attach`). Schemas live in
`@sparklab/shared-types` (`agent.ts`): `AgentWsClientMessageSchema` /
`AgentWsServerMessageSchema`.

### Client → server

| type                | fields                     | meaning                                                        |
| ------------------- | -------------------------- | -------------------------------------------------------------- |
| `user_message`      | `text`, `activeSessionId?` | a chat turn; `activeSessionId` resolves "this terminal"        |
| `approval_response` | `requestId`, `behavior`    | answer a pending approval (`allow` / `allow_always` / `deny`)  |
| `interrupt`         | —                          | abort the current turn (Stop button)                           |
| `ping`              | —                          | heartbeat                                                      |
| `list_chats`        | —                          | request history (the service scopes it to the socket terminal) |
| `delete_chat`       | `chatId`                   | delete a past chat; server replies with a fresh `chat_list`    |

### Server → client

| type                | fields                                                                  | meaning                                                    |
| ------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| `chat_started`      | `chatId`, `terminalSessionId`                                           | identifies the chat and its owning terminal                |
| `chat_history`      | `chatId`, `entries[]`                                                   | resumed transcript (user/assistant/tool); client REPLACES  |
| `chat_list`         | `chats[]` (`id`,`title`,`updatedAt`,`messageCount`,`terminalSessionId`) | terminal-scoped past-chat list                             |
| `assistant_delta`   | `text`                                                                  | streamed token chunk                                       |
| `assistant_message` | `text`                                                                  | finalized assistant segment                                |
| `tool_use`          | `callId`, `tool`, `sessionId?`, `summary`, `input`                      | a tool is being invoked                                    |
| `tool_result`       | `callId`, `tool`, `ok`, `summary?`                                      | tool finished                                              |
| `approval_request`  | `requestId`, `tool`, `sessionId?`, `summary`, `input`                   | a write awaits approval                                    |
| `status`            | `state` (`idle`/`thinking`/`acting`/`awaiting_approval`)                | coarse activity                                            |
| `error`             | `message`                                                               | channel error                                              |
| `pong`              | —                                                                       | heartbeat reply                                            |
| `browser_view`      | `browserId`, `revision`, `url`, `title`, `viewport`, `screenshot`       | bounded ephemeral browser snapshot                         |
| `browser_closed`    | `browserId`, `revision`                                                 | discard the matching browser view                          |
| `computer_view`     | `computerId`, `revision`, `viewport`, `status`, `screenshot`            | bounded ephemeral desktop snapshot (never in chat history) |
| `computer_closed`   | `computerId`, `revision`                                                | close tombstone; a later `computer_view` cannot reopen     |

## Tools

The model's entire capability surface (no built-in shell). Reads run
immediately; writes pause the loop at the approval gate.

| Tool                                | Kind      | Backing                                                                           |
| ----------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `list_sessions`                     | read      | `GET /api/sessions`                                                               |
| `read_screen`                       | read      | `GET /api/sessions/:id/screen`                                                    |
| `wait_idle`                         | read      | polls `/screen` until a shell prompt / quiescence                                 |
| `type_text`                         | **write** | `POST /api/sessions/:id/keys {text}` — never executes                             |
| `press_keys`                        | **write** | `POST …/keys {keys}` (whitelist)                                                  |
| `schedule_terminal_action`          | **write** | `POST /api/terminal-actions` — one-time persisted named-key action                |
| `schedule_terminal_input`           | **write** | `POST /api/terminal-actions` — one-time encrypted literal text + named-key action |
| `start_autonomous_terminal_monitor` | **write** | persisted deterministic screen-triggered text/key/command automation              |
| `list_scheduled_terminal_actions`   | read      | `GET /api/terminal-actions`                                                       |
| `cancel_scheduled_terminal_action`  | **write** | `DELETE /api/terminal-actions/:id`                                                |
| `run_command`                       | **write** | type + Enter + `wait_idle` (one approval)                                         |
| `create_session`                    | **write** | `POST /api/sessions`                                                              |
| `run_codex`                         | **write** | `POST …/codex` — `codex exec` in the session cwd                                  |
| `browser_observe`                   | read      | Browser Use MCP page state + bounded snapshot                                     |
| `browser_list_tabs`                 | read      | Browser Use MCP tab list                                                          |
| `browser_act`                       | **write** | one structured navigate/click/type/scroll/tab action                              |
| `browser_capture`                   | **write** | capture viewport + save through session-scoped gateway `fs/upload`                |
| `browser_request_handoff`           | **write** | offer the live isolated browser for private human authentication                  |
| `computer_observe`                  | read      | disposable-desktop viewport + `snapshotId` + window inventory + bounded snapshot  |
| `computer_act`                      | **write** | one desktop input action (`click`/`type_text`/`press_key`/`scroll`) at screen x,y |
| `kanban_list`                       | read      | `GET /api/kanban/boards`                                                          |
| `kanban_get`                        | read      | `GET /api/kanban/boards/:id`                                                      |
| `kanban_create`                     | **write** | `POST /api/kanban/boards`                                                         |
| `kanban_add_card`                   | **write** | `POST /api/kanban/boards/:id/cards`                                               |
| `kanban_update_card`                | **write** | `PATCH /api/kanban/cards/:id`                                                     |
| `kanban_move`                       | **write** | `POST /api/kanban/cards/:id/move` (auto-manages `rev`, retries 409)               |
| `kanban_delete`                     | **write** | `DELETE /api/kanban/boards/:id` — board delete (one-time approval)                |

Kanban tools drive the gateway's `/api/kanban/*` board API (design:
[`KANBAN-PLAN.md`](./KANBAN-PLAN.md)). Approval tiers (D9): reads run
immediately; the routine writes (`kanban_create`, `kanban_add_card`,
`kanban_update_card`, `kanban_move`) are approvable **allow-always**;
`kanban_delete` (destroying a whole board) is in `ONE_TIME_TOOLS`, so it is
re-approved on **every** call like `run_codex` / `browser_act`. `kanban_move`
fetches the board's current `rev` itself and retries once on a `409`, so the
model never manages revisions. There is deliberately **no card-delete tool** —
deleting individual cards stays a human action in the board UI.

| `pm_list_projects` | read | `GET /api/pm/projects` |
| `pm_get_project` | read | `GET /api/pm/projects/:id` |
| `pm_get_tree` | read | `GET /api/pm/projects/:id/tree` — Epic→Story→Subtask forest |
| `pm_create_project` | **write** | `POST /api/pm/projects` |
| `pm_add_task` | **write** | `POST /api/pm/projects/:id/tasks` (+ `type`, `parent_id`) |
| `pm_update_task` | **write** | `PATCH /api/pm/tasks/:id` (fields + `type`/`parent_id`/`dependsOn`; cycle/hierarchy→error) |
| `pm_move_task` | **write** | `POST /api/pm/tasks/:id/move` (auto-manages `rev`, retries **409 only**) |
| `pm_add_sprint` | **write** | `POST /api/pm/projects/:id/sprints` |
| `pm_delete_project` | **write** | `DELETE /api/pm/projects/:id` — project delete (one-time approval) |
| `pm_add_column` | **write** | `POST /api/pm/projects/:id/columns` |
| `pm_update_column` | **write** | `PATCH /api/pm/columns/:colId` (name/`wip_limit`/`transitions`) |
| `pm_move_column` | **write** | `POST /api/pm/columns/:colId/move` (auto-manages `rev`, retries 409) |
| `pm_delete_column` | **write** | `DELETE /api/pm/columns/:colId` — can strand/relocate many tasks (one-time approval) |
| `pm_add_comment` | **write** | `POST /api/pm/tasks/:id/comments` |
| `pm_list_comments` | read | `GET /api/pm/tasks/:id/comments` |
| `pm_list_activity` | read | `GET /api/pm/projects/:id/activity` |
| `pm_watch_task` / `pm_unwatch_task` | **write** | `POST /api/pm/tasks/:id/watch`\|`unwatch` (idempotent) |
| `pm_list_attachments` | read | `GET /api/pm/tasks/:id/attachments` |
| `notes_list` | read | `GET /api/notes/notebooks` |
| `notes_get_notebook` | read | `GET /api/notes/notebooks/:id` |
| `notes_get_page` | read | `GET /api/notes/notebooks/:id/pages/:pageId` |
| `notes_search` | read | `GET /api/notes/search?q=&limit=` |
| `notes_create_notebook` | **write** | `POST /api/notes/notebooks` — seeds one section "Notes" + one "Untitled page" |
| `notes_create_section` | **write** | `POST /api/notes/notebooks/:id/sections` |
| `notes_create_page` | **write** | `POST /api/notes/notebooks/:id/pages` (`section_id` for top-level, or `parent_id` for a subpage) |
| `notes_append_to_page` | **write** | `POST /api/notes/pages/:id/append` — additive, no `rev` to manage |
| `notes_move_page` | **write** | `POST /api/notes/pages/:id/move` (auto-manages the **notebook** `rev`, retries once on 409) |
| `notes_update_page` | **write** | `PATCH /api/notes/pages/:id` — blind title/body/tags replace (one-time approval, **never retried** on 409) |
| `notes_delete_page` | **write** | `DELETE /api/notes/pages/:id` — `mode` "orphan" (default) \| "cascade" (one-time approval) |
| `notes_delete_section` | **write** | `DELETE /api/notes/sections/:id` — `mode` "block" (default) \| "cascade" (one-time approval) |
| `notes_delete_notebook` | **write** | `DELETE /api/notes/notebooks/:id` — irreversible (one-time approval) |

The PM tools drive the project-management artifact's `/api/pm/*` API (design:
[`PM-TOOL-PLAN.md`](./PM-TOOL-PLAN.md), extended by
[`PM-ARTIFACT-ENHANCEMENTS-PLAN.md`](./PM-ARTIFACT-ENHANCEMENTS-PLAN.md)) — a
separate artifact from Kanban, same approval model: reads auto; routine writes
allow-always; `pm_delete_project` and `pm_delete_column` are in `ONE_TIME_TOOLS`
(re-approved every call — both can destroy or relocate many tasks at once).
`pm_update_task` sets task fields, type/hierarchy, and dependencies (a
dependency cycle or a hierarchy-matrix violation — e.g. a Subtask without a
parent, an Epic with a parent — comes back as a gateway 400/422, surfaced as an
error string, never silently applied). `pm_move_task` distinguishes its two
failure modes: a **409** `stale` revision is retried automatically, exactly
once; a **422** (`wip_exceeded` or `transition_forbidden` — the destination
column is at its WIP limit, or isn't in the source column's allowed
transitions) is a hard rejection the tool **never retries** — it surfaces
immediately as an error string for the model to re-plan around. There is
**no `pm_delete_task`** tool — task deletion stays human-only in the UI.
Attachment **upload** and all notification management are deliberately
**not** exposed as agent tools (binary upload and notification triage stay
human actions in the artifact UI); `pm_list_attachments` (metadata only) is
the one read exposed for attachments.

The Notes tools drive the gateway's `/api/notes/*` OneNote-style note tool
(design: [`NOTES-TOOL-PLAN.md`](./NOTES-TOOL-PLAN.md)) — a separate artifact
from Kanban/PM. Approval tiers (D9) are **deliberately inverted** from the
naive "writes allow-always, deletes one-time" reading, because the risk runs
the other way for notes: reads are auto; the additive/structural writes
(`notes_create_notebook`, `notes_create_section`, `notes_create_page`,
`notes_append_to_page`, `notes_move_page`) are approvable **allow-always**;
`notes_update_page` (a blind full title/body/tags replace) is in
`ONE_TIME_TOOLS` — re-approved on **every** call, because an allow-always
overwrite could silently destroy pages of human writing, whereas
`notes_append_to_page` is server-atomic and additive so it **cannot clobber**
and carries no `rev`. The three deletes (`notes_delete_page`,
`notes_delete_section`, `notes_delete_notebook`) are also one-time. Two
**independent** revisions gate concurrency: `notes_move_page` manages the
**notebook** (structural) `rev` itself and retries once on a `409` — safe,
because a move is a re-derived splice, mirroring `kanban_move`/`pm_move_task`.
`notes_update_page` manages the **page** (body) `rev` itself but **never
retries** a `409` — a body `PATCH` is a blind overwrite, so a stale write is
surfaced back to the model as an error (naming the current server page)
instead of silently discarding whatever the other writer just saved.
**`notes_delete_page` is a deliberate divergence (D10)** from Kanban/PM's "no
card/task-delete tool" precedent — a notebook accretes many disposable pages
and routing every one through a human is disproportionate friction; it is
mitigated by the one-time approval, a `mode:"orphan"` default (children are
promoted, not cascaded), and the store's orphan-`.md` sweep leaving an
accidental delete recoverable until the next `load()`.

Calling `browser_request_handoff` again while the same chat's handoff is
pending or active republishes that handoff state and reopens the Browser View.
It does not create a second browser, token, socket, cookie jar, or timeout.
Each model hop is grounded with the runtime's current control lease. That live
lease overrides stale assistant prose in chat history: the agent must not ask
for **Done** when the lease is agent-active or closed, and must reopen an
existing pending/active Browser View before referring the user to its controls.

The dedicated handoff data plane is bounded and latest-frame-wins: the broker
paces binary frames to 10 FPS, retains at most one unsent frame under
backpressure, and the client uses one active decode plus one replaceable pending
frame. Pointer movement and wheel events are coalesced before transmission;
clicks and keyboard events retain ordering.

The same authenticated `/browser-handoff` socket also carries a versioned,
strict WebRTC signaling foundation: capabilities, bounded offer/answer SDP,
trickle ICE candidates, transport state, fallback, and heartbeat. Input remains
on WebSocket. JPEG binary frames remain the default and automatic fallback;
WebRTC is not advertised until a production media provider is present. See
[`ADR-BROWSER-HANDOFF-WEBRTC.md`](./ADR-BROWSER-HANDOFF-WEBRTC.md).

The virtual mouse displays the exact bounded browser coordinates locally. The
existing handoff `activity` control adds only `inputType`; a short ✓ is shown
after CDP accepts pointer/wheel input. Coordinates and typed content are never
echoed back, logged, or persisted.

The v1 ACK is deliberately coarse. It does not identify `move`, `down`, or
`up`, and it does not prove that a DOM element existed, received focus, or
changed state. A move ACK can produce the same ✓ as a click. The visual ACK
style expires after about 350 ms while the last label text may retain its check
mark. Operational tooling must inspect `data-acknowledged`, connection state,
known-target behavior, and frame freshness rather than interpreting the label
alone. See [`BROWSER-HANDOFF-OPERATIONS.md`](./BROWSER-HANDOFF-OPERATIONS.md).

There is no `kill_session` — destroying a session stays a human-only action in
the UI (the gateway's single `DELETE` call site).

### Virtual Computer

`computer_observe` / `computer_act` are added to the tool set **only when
`CUA_ENABLED=true`** (mirroring browser tools gated by `BROWSER_USE_PROJECT`);
with CUA unset the model never sees them, no computer frames are emitted, and
nothing else changes. They drive one per-chat disposable Linux (XFCE) desktop
container the agent owns (design + decisions:
[`VIRTUAL-COMPUTER.md`](./VIRTUAL-COMPUTER.md), plan:
[`VIRTUAL-COMPUTER-REMAINING.md`](./VIRTUAL-COMPUTER-REMAINING.md)). Approval
tiers match `browser_observe` / `browser_act`: `computer_observe` is an
auto-approved read that returns the viewport, the current `snapshotId`, and a
window inventory (`window_id`, `pid`, `title`, `app`, bounds); `computer_act`
is a write in `ONE_TIME_TOOLS`, re-approved on **every** call (no
`allow_always`, a forged one is coerced to a single allow). It performs exactly
one input — `click` / `type_text` / `press_key` / `scroll` — targeted by
screen-absolute `x,y` only (v1 has no element targeting), delivered in the
background (no window is raised or focused). `describeCall` redacts `type_text`
content on the approval card. Each `computer_observe`, and each successful
`computer_act`, publishes a `computer_view` frame (bounded screenshot,
monotonically increasing `revision`, later revisions replace earlier ones) to
the read-only `features/computer-view/` overlay; screenshots are **never**
written to chat JSONL history. `computer_closed` records a close tombstone at
its `revision` so a late `computer_view` cannot reopen the view. Teardown is
total on Stop / disconnect / shutdown.

## Safety

- **Approval by default** for every write, via the loop's dispatcher gate. A
  120s no-answer timeout resolves to `deny`. `allow_always` scopes to
  tool+session for the current chat only (not persisted). Browser actions are
  always one-time approvals; the server coerces a forged `allow_always` reply
  to a single `allow`. `schedule_terminal_action` is also always one-time: a
  delayed terminal key press must be explicitly approved at creation and can
  never inherit an earlier allow-always choice.
- **Scheduled terminal actions:** the agent may schedule only whitelisted named
  keys with `schedule_terminal_action`, or an exact single line of literal text
  followed by whitelisted named keys with `schedule_terminal_input`. Both are
  one-time approved; the latter is a deliberate delayed-input capability, so
  its approval card must show the exact text, keys, and time. `execute_at` must
  be a future, timezone-qualified ISO-8601 timestamp. Delayed text is encrypted
  in the gateway store and omitted from timer listings and durable chat history.
  The gateway persists approved one-shot actions, so they survive chat
  disconnects and agent-service restarts; the user can list or cancel pending
  actions from chat. The gateway claims an action before sending it, preferring
  a lost action after a crash over replayed terminal input. Setup and the
  security rationale are in [SCHEDULED-TERMINAL-INPUT-DESIGN.md](SCHEDULED-TERMINAL-INPUT-DESIGN.md).
- **Bounded turns:** max 24 model calls and 10 write executions per user
  message; `interrupt` aborts the in-flight Azure request via `AbortController`.
- **Persistence:** one JSONL file plus a small terminal-link metadata file per
  chat under `apps/agent-service/data/` (gitignored) records history and
  ownership for resume. Browser screenshots,
  page state, typed values, URL query strings, and tool results are omitted or
  redacted from durable history.
- **Screenshot export:** `browser_capture` requires a terminal session and an
  absolute destination path, is approved one invocation at a time, and writes
  the already-bounded PNG/WebP bytes through the gateway's session-scoped
  `fs/upload` route. The parent directory must exist; an existing file is
  overwritten. Image bytes and saved-path results are omitted from chat
  history.
- **Browser isolation:** each chat lazily owns an ephemeral Browser Use process,
  profile/config directory, and enforcing outbound proxy. Stop/disconnect closes
  its process group and view. The proxy resolves every HTTP/CONNECT destination
  and rejects local, private, reserved, link-local, and metadata addresses.
- **Codex tool:** `run_codex` runs `codex exec` **non-interactively** on the
  session's own server, rooted at the session cwd (`-C <cwd>`), via the same
  gateway `serverCmd` seam as fs/git — the gateway stays the single enforcement
  point. It is a **write tool approved on every call** (like `browser_act`; a
  forged `allow_always` is coerced to one-time), and the approval card shows the
  exact task + mode. The sandbox is **clamped** to `read-only` (default, no file
  changes) or `workspace-write` (**writes** confined to the cwd);
  `danger-full-access` and the `--dangerously-bypass-*` flags are unreachable,
  and Codex gets no network. Note the sandbox governs writes/exec, **not read
  scope** — Codex can still read files the user can read outside the cwd, so its
  output is treated like any command output (per-call approval is the control).
  The
  prompt is piped via **stdin** (never argv), output is bounded, and there are
  distinct errors for not-installed (`503 codex_unavailable`) and timeout
  (`504 codex_timeout`, `CODEX_TIMEOUT_MS`, default 180s). For local sessions,
  the agent-service forwards its already-required `AZURE_OPENAI_*` configuration
  to the Gateway in internal request headers; the Gateway exposes it only in the
  Codex child environment (never the JSON body, approval UI, argv, or logs).
  Remote sessions do not forward secrets through SSH and therefore use the
  remote host's own `CODEX_HOME`/credential. On Linux/WSL2, `workspace-write`
  additionally requires the `bubblewrap` (`bwrap`) distribution package on the
  host that runs Codex (including each remote server); Ubuntu 24.04 may also
  need the packaged AppArmor profile. Installation and verification steps are
  in [GETTING-STARTED.md](GETTING-STARTED.md#codex-workspace-write-on-linux--wsl2).

## Conversation history

Every chat is durable and belongs to one terminal session, so past conversations
are browsable and resumable from that terminal's "Chat options" (⋮) menu →
**History**.

Ownership and switching invariants:

- A chat's `terminalSessionId` is immutable. Explicit resume and delete requests
  are rejected if the chat belongs to another terminal.
- The service is authoritative. The browser's persisted terminal→chat map only
  avoids an extra lookup; a missing mapping asks the service for that terminal's
  newest chat.
- Switching terminals clears the visible transcript, target pin, browser view,
  and history list before opening the destination chat. With no focused
  terminal, no chat connection is opened and the composer remains disabled.
- The client increments a connection generation on every switch. Frames,
  connection status, and auth callbacks from older generations are ignored, so
  rapid A→B→A switching cannot replace A's state with a late frame from B.
- The service serializes initial/latest-chat resolution per terminal, preventing
  concurrent first connections from creating duplicate default chats.
- Persisted store version 0 contained one global `chatId`. Version 1 migrates it
  to a one-time legacy candidate, which is linked by the service when the first
  terminal-specific connection succeeds; all subsequent persistence is keyed by
  terminal.

- **List** (`list_chats` → `chat_list`): results are scoped to the socket's
  terminal. Display metadata is derived from JSONL; terminal ownership comes
  from the adjacent `.meta.json` file.
- **Resume / load:** switching to a past chat is a reconnect with
  `?resumeChatId=<id>`; on connect the service replays the reconstructed
  transcript via `chat_history`, which the client uses to **replace** its view.
  Because that frame also fires on any transient reconnect (the JSONL is the
  source of truth), the client always replaces — never appends. The browser
  persists the latest `chatId` per terminal, so a page reload resumes the right
  conversation.
- **Automatic terminal switch:** the client keeps a persisted
  terminal-to-latest-chat map for fast restore, while the service remains the
  source of truth and resolves the latest linked chat when no id is supplied.
- **New chat:** reconnect with `newChat=1`; the previous chat stays in that
  terminal's history.
- **Delete** (`delete_chat`): removes the JSONL and terminal-link metadata, then
  returns a fresh terminal-scoped `chat_list`; deleting the active chat drops
  the UI to a new chat. (Deleting a _session_ is still human-only — there is no
  `kill_session`.)
- The transcript replayed to the browser is reconstructed server-side from the
  stored OpenAI messages, so the raw model message format never reaches the
  client. Approval prompts aren't persisted, so a resumed transcript shows the
  writes as tool rows (denied writes render as error-state rows).

## Message rendering

Assistant messages render in two modes, switched on the streaming flag
(`apps/terminal/src/features/agent-chat/components/chat-message.tsx`):

- **While streaming** — a cheap inline formatter (backtick `code` spans +
  newline→`<br/>`) plus the pulsing block cursor. Deliberately NOT markdown:
  re-parsing on every token is costly and half-parsed markdown flickers.
- **Once the response finishes** (`streaming` goes false) — the full markdown
  renderer (`components/markdown.tsx`, `react-markdown` + `remark-gfm`) takes
  over, giving headings, lists, tables, links, blockquotes, and fenced code.
  There is no Tailwind typography plugin in the repo, so every element is styled
  by hand with the design-system theme tokens; inline `code` matches the
  streaming style exactly. Resumed transcripts arrive with `streaming: false`,
  so replayed assistant turns render as markdown too.

User messages keep the inline formatter (no markdown) by design.
