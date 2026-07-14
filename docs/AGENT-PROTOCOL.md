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

| Var                                           | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `AZURE_OPENAI_ENDPOINT`                       | Azure AI Foundry resource endpoint       |
| `AZURE_OPENAI_API_KEY`                        | secret — never committed                 |
| `AZURE_OPENAI_API_VERSION`                    | pinned, default `2025-04-01-preview`     |
| `GPT56SOL_DEPLOYMENT`                         | model deployment name (`gpt-5.6-sol`)    |
| `AGENT_PORT`                                  | listen port (default 3009)               |
| `GATEWAY_URL`                                 | gateway base URL (loopback in prod)      |
| `ALLOWED_ORIGINS`                             | browser origins allowed to open `/agent` |
| `GATEWAY_AUTH_USER` / `GATEWAY_AUTH_PASSWORD` | gateway login (omit in open mode)        |

The service fails fast at startup if any required Azure var is missing.

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

| type                | fields                     | meaning                                                       |
| ------------------- | -------------------------- | ------------------------------------------------------------- |
| `user_message`      | `text`, `activeSessionId?` | a chat turn; `activeSessionId` resolves "this terminal"       |
| `approval_response` | `requestId`, `behavior`    | answer a pending approval (`allow` / `allow_always` / `deny`) |
| `interrupt`         | —                          | abort the current turn (Stop button)                          |
| `ping`              | —                          | heartbeat                                                     |
| `list_chats`        | —                          | request the past-chat list for the history modal              |
| `delete_chat`       | `chatId`                   | delete a past chat; server replies with a fresh `chat_list`   |

### Server → client

| type                | fields                                                   | meaning                                                    |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `chat_started`      | `chatId`                                                 | keys the JSONL history; pass as `?resumeChatId=` to resume |
| `chat_history`      | `chatId`, `entries[]`                                    | resumed transcript (user/assistant/tool); client REPLACES  |
| `chat_list`         | `chats[]` (`id`,`title`,`updatedAt`,`messageCount`)      | past-chat list (reply to `list_chats`/`delete_chat`)       |
| `assistant_delta`   | `text`                                                   | streamed token chunk                                       |
| `assistant_message` | `text`                                                   | finalized assistant segment                                |
| `tool_use`          | `callId`, `tool`, `sessionId?`, `summary`, `input`       | a tool is being invoked                                    |
| `tool_result`       | `callId`, `tool`, `ok`, `summary?`                       | tool finished                                              |
| `approval_request`  | `requestId`, `tool`, `sessionId?`, `summary`, `input`    | a write awaits approval                                    |
| `status`            | `state` (`idle`/`thinking`/`acting`/`awaiting_approval`) | coarse activity                                            |
| `error`             | `message`                                                | channel error                                              |
| `pong`              | —                                                        | heartbeat reply                                            |

## Tools

The model's entire capability surface (no built-in shell). Reads run
immediately; writes pause the loop at the approval gate.

| Tool             | Kind      | Backing                                               |
| ---------------- | --------- | ----------------------------------------------------- |
| `list_sessions`  | read      | `GET /api/sessions`                                   |
| `read_screen`    | read      | `GET /api/sessions/:id/screen`                        |
| `wait_idle`      | read      | polls `/screen` until a shell prompt / quiescence     |
| `type_text`      | **write** | `POST /api/sessions/:id/keys {text}` — never executes |
| `press_keys`     | **write** | `POST …/keys {keys}` (whitelist)                      |
| `run_command`    | **write** | type + Enter + `wait_idle` (one approval)             |
| `create_session` | **write** | `POST /api/sessions`                                  |

There is no `kill_session` — destroying a session stays a human-only action in
the UI (the gateway's single `DELETE` call site).

## Safety

- **Approval by default** for every write, via the loop's dispatcher gate. A
  120s no-answer timeout resolves to `deny`. `allow_always` scopes to
  tool+session for the current chat only (not persisted).
- **Bounded turns:** max 24 model calls and 10 write executions per user
  message; `interrupt` aborts the in-flight Azure request via `AbortController`.
- **Persistence:** one JSONL file per chat under `apps/agent-service/data/`
  (gitignored) records the full message history for resume.

## Conversation history

Every chat is a durable JSONL file, so past conversations are browsable and
resumable from the panel's "Chat options" (⋮) menu → **History**.

- **List** (`list_chats` → `chat_list`): metadata is DERIVED from each file —
  title from the first user message, `updatedAt` from the file mtime,
  `messageCount` from the line count. There is no sidecar or database.
- **Resume / load:** switching to a past chat is a reconnect with
  `?resumeChatId=<id>`; on connect the service replays the reconstructed
  transcript via `chat_history`, which the client uses to **replace** its view.
  Because that frame also fires on any transient reconnect (the JSONL is the
  source of truth), the client always replaces — never appends. The browser
  persists the active `chatId`, so a page reload resumes the same conversation.
- **New chat:** reconnect with no `resumeChatId`; the service mints a fresh id
  and the previous chat stays in history.
- **Delete** (`delete_chat`): removes the JSONL file and returns a fresh
  `chat_list`; deleting the active chat drops the UI to a new chat. (Deleting a
  _session_ is still human-only — there is no `kill_session`.)
- The transcript replayed to the browser is reconstructed server-side from the
  stored OpenAI messages, so the raw model message format never reaches the
  client. Approval prompts aren't persisted, so a resumed transcript shows the
  writes as tool rows (denied writes render as error-state rows).
