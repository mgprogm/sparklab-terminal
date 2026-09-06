# Task Master agent setup

How to prepare a `claude-task-master` project so a terminal AI coding CLI —
**Claude Code**, **Codex CLI**, **OpenCode**, **Pi**, and tools like them —
not just the Task Master Hub artifact's web UI (see
`docs/TASKMASTER-HUB-PLAN.md`) — can read and update its task list directly
from a terminal. Written so an agent working in a project can follow it to
prepare that project itself, without a human doing the setup by hand.

The Claude Code and Codex CLI commands and results below were verified live
against this repository (`claude-web-terminal`, `task-master-ai@0.43.1`) on
2026-09-05. The **OpenCode** and **Pi** rows were added 2026-09-06 from each
tool's own CLI/config surface (`opencode@1.18.27`,
`@earendil-works/pi-coding-agent`) and are **not yet run end-to-end** against
this repo's Hub — treat them as documented, not verified, until someone does.
Re-verify the compatibility table in §4 if any CLI's version has moved on.

**Which tools support MCP at all:**

| CLI         | MCP support                                                                        | If no MCP, how it reaches Task Master |
| ----------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| Claude Code | Yes (interactive **and** `claude -p`)                                              | —                                     |
| Codex CLI   | Interactive `codex` only — **not** `codex exec`                                    | Hub REST or `task-master` CLI (§4)    |
| OpenCode    | Yes (`opencode mcp add`, stdio or remote)                                          | —                                     |
| Pi          | **No built-in MCP** (deliberate — extend via a TS extension / third-party package) | Hub REST or `task-master` CLI (§4)    |

## 0. Two independent relationships — set up both, or half of it silently doesn't work

- **The agent as consumer.** Claude Code / Codex reads and drives the task
  list from a terminal ("what's next", "mark this done") without leaving the
  CLI. This is an **MCP server registration** — you're giving the CLI a tool.
  → `claude mcp add` / `codex mcp add` (§2).
- **The agent as engine.** When a human (or an agent) runs `task-master
add-task`/`expand`/`parse-prd`, something has to generate the content.
  That's a **model provider setting** on task-master itself — point it at a
  login you already have so no separate API key is needed. → `task-master
models --set-main ... --claude-code` (§1).

These are unrelated switches. Registering the MCP server without configuring
a provider still leaves `add-task` failing on a missing API key; configuring
a provider without registering the MCP server still leaves the CLI unable to
see the task list at all.

For an MCP-less CLI (**Pi**, scripted **`codex exec`**, the in-app
`run_codex`) relationship 1 (the engine) still applies unchanged — it's a
setting on `task-master` itself, not on the CLI — but relationship 2 becomes
"call the Hub REST API or run the `task-master` CLI directly" (§4) instead of
an MCP registration. Skip §2/§3 for those tools.

## 1. Point task-master's own AI at something free

Run inside the target project, once it has a `.taskmaster/` directory
(`task-master init` if it doesn't yet):

```bash
task-master models --set-main sonnet --claude-code
task-master models --set-fallback opus --claude-code
# or, to make Codex the engine instead:
task-master models --set-main gpt-5-codex --codex-cli
```

Zero-key providers (`claude-code`, `codex-cli`) cost nothing extra and need
no API key — they shell out to whichever CLI is already logged in on this
host, the same trust model this repo's own `run_codex` tool and `codex-cli`
Agent Chat provider already use. Only reach for a paid provider (`anthropic`,
`openai`, …) if neither CLI is available on the target host.

## 2. Register the MCP server with each CLI

Each command below is run from inside the target project directory.

**Claude Code** — `local` scope keys the registration to this exact path;
Claude Code loads it automatically whenever you're in this directory, in
both interactive and `-p`/print sessions:

```bash
claude mcp add taskmaster-ai -e TASK_MASTER_TOOLS=standard -- npx -y task-master-ai
```

**Codex CLI** — `codex mcp add` has no per-project scope; it always writes to
the global `~/.codex/config.toml`. That's fine — the spawned server still
only ever sees whichever project you happened to launch `codex` from:

```bash
codex mcp add taskmaster-ai --env TASK_MASTER_TOOLS=standard -- npx -y task-master-ai
```

**OpenCode** — `opencode mcp add` writes to `~/.config/opencode/opencode.json`
(global) unless you run it against a project that has its own `opencode.json`
(project scope). Local stdio server, same shape as the others:

```bash
opencode mcp add taskmaster-ai --env TASK_MASTER_TOOLS=standard -- npx -y task-master-ai
```

**Pi** — no step here. Pi ships no built-in MCP client; use §4's REST / CLI
path. (If you add MCP to Pi via a third-party extension, register the same
`npx -y task-master-ai` stdio command however that extension expects it.)

`TASK_MASTER_TOOLS` controls how many tools load (`core` 7, `standard` ~14,
`all` 36+, or a comma-separated list) — see the README table in the
`claude-task-master` project itself. `standard` is a reasonable default: it
adds task creation/expansion on top of the `core` read/status tools without
pulling in every dependency/tag/research tool.

### 2b. Or register the Task Master **Hub** MCP instead

`task-master-ai`'s MCP drives a local `.taskmaster/` directly and knows
nothing about the Hub's project registry or the multi-agent claim layer. If
this repo's Task Master Hub is running and you want the CLI to **onboard a
project into it and coordinate through claims**, register
`tools/taskmaster-hub-mcp/server.mjs` instead (or in addition):

```bash
claude mcp add taskmaster-hub -- node /abs/tools/taskmaster-hub-mcp/server.mjs \
  -e TASKMASTER_HUB_API_TOKEN=<gateway bearer> \
  -e TASKMASTER_HUB_BASE_URL=<gateway/proxy URL> \
  -e TASKMASTER_HUB_ACTOR=<stable-worker-id>   # its own ownerChannel (Phase C)
```

It exposes `taskmaster_hub_init` (register the current project + get the
claim protocol) plus `_claim` / `_update_progress` / `_release` / `_next` /
`_set_status` / … over the gateway's `/api/taskmaster/*` REST — a thin bearer
client, no cookie. Set `TASKMASTER_HUB_ACTOR` to a distinct value per worker
so each one's claims are channel-isolated (an invalid value fails the server
at startup rather than silently sharing a channel). Full reference:
`tools/taskmaster-hub-mcp/README.md` and `docs/TASKMASTER-HUB-MCP-PLAN.md`.

## 3. Confirm each actually connected

```bash
claude mcp list
# taskmaster-ai: npx -y task-master-ai - ✔ Connected

codex mcp get taskmaster-ai
# taskmaster-ai
#   enabled: true
#   transport: stdio
#   command: npx
#   args: -y task-master-ai

opencode mcp list
# taskmaster-ai  <status>
```

(Nothing to confirm for Pi — it has no MCP list.)

## 4. What actually works, once it's registered — verified, not assumed

Registration succeeding is not the same as the model being able to call the
tool. Do not skip this check when preparing a new host or a new CLI version.

| Tool        | Mode                                      | Sees the taskmaster MCP tools?                                                                                                     |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `claude` (interactive)                    | Yes                                                                                                                                |
| Claude Code | `claude -p` (scripted / non-interactive)  | **Yes** — confirmed: listed all 14 tools for the `standard` tier on request                                                        |
| Codex CLI   | `codex` (interactive)                     | Expected, not separately verified here (not scriptable to test the same way)                                                       |
| Codex CLI   | `codex exec` (scripted / non-interactive) | **No** — confirmed twice: "No MCP server tools are currently exposed in this session," despite `codex mcp list` showing it enabled |
| OpenCode    | `opencode` (interactive) / `opencode run` | Expected (OpenCode loads configured MCP servers in both) — **documented, not yet run against this Hub**                            |
| Pi          | `pi` / `pi -p`                            | **No** — Pi has no built-in MCP client by design; REST / `task-master` CLI only                                                    |

**This matters more than it looks.** This repo's own `run_codex` tool and its
`codex-cli` Agent Chat provider (`docs/AGENT-PROTOCOL.md`) both work by
shelling to `codex exec` — so a Codex-CLI-backed agent running _inside this
app_ cannot reach task-master through this MCP registration either, no
matter how it's configured. That path only reaches a genuinely interactive
`codex` session at a real terminal. The same is true of **Pi** in every mode.
**For any scripted/non-interactive or MCP-less agent (`codex exec`, `pi`,
`pi -p`, the in-app `run_codex`) to be task-aware, it must call the Task
Master Hub's own REST API (`/api/taskmaster/*`, see
`docs/TASKMASTER-HUB-PLAN.md` §4) or the `task-master` CLI directly — never
MCP.** The claim/progress/release routes and their behaviour (409 on a held
task, 403 on a cross-auth-channel mutation, TTL auto-expiry) are documented
in `docs/TASKMASTER-HUB-OPERATIONS.md` §"Multiple agent tools on one
backlog".

## 5. One more gate: listing a tool ≠ being allowed to call it

Claude Code asked to actually _call_ `mcp__taskmaster-ai__get_tasks`
non-interactively replied:

> I don't have permission to call this yet — you'll need to approve it when
> prompted, or grant it in settings.

Listing available tools doesn't require approval; using one does. For a
human at the terminal this is just the normal first-use prompt. For a fully
unattended script, either pre-allow the specific tools in
`.claude/settings.json` (see the `fewer-permission-prompts` skill for the
scan-and-allowlist workflow), or run once interactively and approve "always"
so the choice is remembered.

## See also

- `docs/TASKMASTER-HUB-OPERATIONS.md` — the runtime protocol: the five-step
  claim workflow, and §"Multiple agent tools on one backlog" (per-tool
  identity labels, 409/403/TTL semantics, handoff).
- `AGENTS.md` (repo root) §"Task Master Hub workflow" — the one-paragraph
  version every CLI that reads `AGENTS.md` (Claude Code, Codex, OpenCode, Pi)
  picks up automatically.
- `docs/TASKMASTER-HUB-PLAN.md` — the Hub artifact's own design record (D1-D12,
  the §1e CLI verification spike); §4 documents the REST routes an agent
  should call directly when MCP isn't reachable (§4 above).
- `docs/PM-MCP-REMOTE-SETUP.md` — the equivalent setup for the PM tool's MCP
  server, which (unlike task-master's) is this repo's own code and talks over
  a remote HTTPS gateway rather than local stdio.
