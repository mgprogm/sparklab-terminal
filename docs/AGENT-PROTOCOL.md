# Agent Chat protocol

The **agent service** (`apps/agent-service`, default port 3009) runs a custom
tool-calling loop over an Azure OpenAI deployment (`gpt-5.6-sol`) and lets the
user drive their terminals from a chat panel. It is a **fourth independent
lifetime** alongside browser / gateway / tmux: it can crash or restart without
touching any attached pty, because it operates terminals **only** through the
gateway REST API — never tmux directly.

```
Browser chat panel ──WS /agent (JSON)──► agent-service ──REST──► gateway ──► tmux
```

## Configuration (`.env`, gitignored)

| Var                                           | Purpose                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`                       | Azure AI Foundry resource endpoint                               |
| `AZURE_OPENAI_API_KEY`                        | secret — never committed                                         |
| `AZURE_OPENAI_API_VERSION`                    | pinned, default `2025-04-01-preview`                             |
| `GPT56SOL_DEPLOYMENT`                         | model deployment name (`gpt-5.6-sol`)                            |
| `AGENT_PORT`                                  | listen port (default 3009)                                       |
| `GATEWAY_URL`                                 | gateway base URL (loopback in prod)                              |
| `ALLOWED_ORIGINS`                             | browser origins allowed to open `/agent`                         |
| `GATEWAY_AUTH_USER` / `GATEWAY_AUTH_PASSWORD` | gateway login (omit in open mode)                                |
| `BROWSER_USE_PROJECT`                         | trusted local Browser Use checkout; unset disables browser tools |
| `BROWSER_USE_HEADLESS`                        | run the isolated browser headless (default `true`)               |

The service fails fast at startup if any required Azure var is missing.

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

| type                | fields                                                                  | meaning                                                   |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `chat_started`      | `chatId`, `terminalSessionId`                                           | identifies the chat and its owning terminal               |
| `chat_history`      | `chatId`, `entries[]`                                                   | resumed transcript (user/assistant/tool); client REPLACES |
| `chat_list`         | `chats[]` (`id`,`title`,`updatedAt`,`messageCount`,`terminalSessionId`) | terminal-scoped past-chat list                            |
| `assistant_delta`   | `text`                                                                  | streamed token chunk                                      |
| `assistant_message` | `text`                                                                  | finalized assistant segment                               |
| `tool_use`          | `callId`, `tool`, `sessionId?`, `summary`, `input`                      | a tool is being invoked                                   |
| `tool_result`       | `callId`, `tool`, `ok`, `summary?`                                      | tool finished                                             |
| `approval_request`  | `requestId`, `tool`, `sessionId?`, `summary`, `input`                   | a write awaits approval                                   |
| `status`            | `state` (`idle`/`thinking`/`acting`/`awaiting_approval`)                | coarse activity                                           |
| `error`             | `message`                                                               | channel error                                             |
| `pong`              | —                                                                       | heartbeat reply                                           |
| `browser_view`      | `browserId`, `revision`, `url`, `title`, `viewport`, `screenshot`       | bounded ephemeral browser snapshot                        |
| `browser_closed`    | `browserId`, `revision`                                                 | discard the matching browser view                         |

## Tools

The model's entire capability surface (no built-in shell). Reads run
immediately; writes pause the loop at the approval gate.

| Tool                | Kind      | Backing                                               |
| ------------------- | --------- | ----------------------------------------------------- |
| `list_sessions`     | read      | `GET /api/sessions`                                   |
| `read_screen`       | read      | `GET /api/sessions/:id/screen`                        |
| `wait_idle`         | read      | polls `/screen` until a shell prompt / quiescence     |
| `type_text`         | **write** | `POST /api/sessions/:id/keys {text}` — never executes |
| `press_keys`        | **write** | `POST …/keys {keys}` (whitelist)                      |
| `run_command`       | **write** | type + Enter + `wait_idle` (one approval)             |
| `create_session`    | **write** | `POST /api/sessions`                                  |
| `browser_observe`   | read      | Browser Use MCP page state + bounded snapshot         |
| `browser_list_tabs` | read      | Browser Use MCP tab list                              |
| `browser_act`       | **write** | one structured navigate/click/type/scroll/tab action  |

There is no `kill_session` — destroying a session stays a human-only action in
the UI (the gateway's single `DELETE` call site).

## Safety

- **Approval by default** for every write, via the loop's dispatcher gate. A
  120s no-answer timeout resolves to `deny`. `allow_always` scopes to
  tool+session for the current chat only (not persisted). Browser actions are
  always one-time approvals; the server coerces a forged `allow_always` reply
  to a single `allow`.
- **Bounded turns:** max 24 model calls and 10 write executions per user
  message; `interrupt` aborts the in-flight Azure request via `AbortController`.
- **Persistence:** one JSONL file plus a small terminal-link metadata file per
  chat under `apps/agent-service/data/` (gitignored) records history and
  ownership for resume. Browser screenshots,
  page state, typed values, URL query strings, and tool results are omitted or
  redacted from durable history.
- **Browser isolation:** each chat lazily owns an ephemeral Browser Use process,
  profile/config directory, and enforcing outbound proxy. Stop/disconnect closes
  its process group and view. The proxy resolves every HTTP/CONNECT destination
  and rejects local, private, reserved, link-local, and metadata addresses.

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
