# Task Master agent setup

How to prepare a `claude-task-master` project so **Claude Code** and **Codex
CLI** — not just the Task Master Hub artifact's web UI (see
`docs/TASKMASTER-HUB-PLAN.md`) — can read and update its task list directly
from a terminal. Written so an agent working in a project can follow it to
prepare that project itself, without a human doing the setup by hand.

Every command and result below was verified live against this repository
(`claude-web-terminal`, `task-master-ai@0.43.1`, Claude Code and Codex CLI as
installed on this host) on 2026-09-05. Re-verify the compatibility table in
§3 if either CLI's version has moved on since.

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

Both commands are run from inside the target project directory.

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

`TASK_MASTER_TOOLS` controls how many tools load (`core` 7, `standard` ~14,
`all` 36+, or a comma-separated list) — see the README table in the
`claude-task-master` project itself. `standard` is a reasonable default: it
adds task creation/expansion on top of the `core` read/status tools without
pulling in every dependency/tag/research tool.

## 3. Confirm both actually connected

```bash
claude mcp list
# taskmaster-ai: npx -y task-master-ai - ✔ Connected

codex mcp get taskmaster-ai
# taskmaster-ai
#   enabled: true
#   transport: stdio
#   command: npx
#   args: -y task-master-ai
```

## 4. What actually works, once it's registered — verified, not assumed

Registration succeeding is not the same as the model being able to call the
tool. Do not skip this check when preparing a new host or a new CLI version.

| Tool        | Mode                                      | Sees the taskmaster MCP tools?                                                                                                     |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `claude` (interactive)                    | Yes                                                                                                                                |
| Claude Code | `claude -p` (scripted / non-interactive)  | **Yes** — confirmed: listed all 14 tools for the `standard` tier on request                                                        |
| Codex CLI   | `codex` (interactive)                     | Expected, not separately verified here (not scriptable to test the same way)                                                       |
| Codex CLI   | `codex exec` (scripted / non-interactive) | **No** — confirmed twice: "No MCP server tools are currently exposed in this session," despite `codex mcp list` showing it enabled |

**This matters more than it looks.** This repo's own `run_codex` tool and its
`codex-cli` Agent Chat provider (`docs/AGENT-PROTOCOL.md`) both work by
shelling to `codex exec` — so a Codex-CLI-backed agent running _inside this
app_ cannot reach task-master through this MCP registration either, no
matter how it's configured. That path only reaches a genuinely interactive
`codex` session at a real terminal. **For a scripted/non-interactive Codex
agent to be task-aware, it must call the Task Master Hub's own REST API
(`/api/taskmaster/*`, see `docs/TASKMASTER-HUB-PLAN.md` §4) or the
`task-master` CLI directly — never MCP.**

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

- `docs/TASKMASTER-HUB-PLAN.md` — the Hub artifact's own design record (D1-D12,
  the §1e CLI verification spike); §4 documents the REST routes an agent
  should call directly when MCP isn't reachable (§4 above).
- `docs/PM-MCP-REMOTE-SETUP.md` — the equivalent setup for the PM tool's MCP
  server, which (unlike task-master's) is this repo's own code and talks over
  a remote HTTPS gateway rather than local stdio.
