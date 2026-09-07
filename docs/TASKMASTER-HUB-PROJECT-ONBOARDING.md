# Task Master Hub — project onboarding manual

Step-by-step procedure for putting a project (any project, on any server the
gateway can reach) onto a running Task Master Hub, so its agents can read/
claim/update tasks through the Hub instead of hand-editing
`.taskmaster/tasks/tasks.json`. Written from the live procedure actually run
against four real projects (2026-09-06): `claude-web-terminal` (local, the
Hub's own host), `tipitaka-app` and `aureuspool-trade` (local, sibling
sparklab boxes), and `project-gendash-system` / `bzbs-ai-help-center`
(remote, over SSH to Buzzebees-Workstation). Every command below was
actually run and its output verified — this is not a design doc, see
`docs/TASKMASTER-HUB-PLAN.md` for that.

For the wider "what is the Hub, what does each tool do" picture, read
`docs/TASKMASTER-HUB-PLAN.md` (design) and `docs/TASKMASTER-HUB-OPERATIONS.md`
(the runtime claim protocol) first. This doc is the checklist for adding one
more project.

## Prerequisites

- A running Hub gateway, reachable from wherever the project's Claude Code
  session will run:
  - Same machine as the gateway → `http://127.0.0.1:<gateway port>` (e.g.
    `:3107` for local-prod).
  - A different machine → the gateway's public origin (this repo tunnels one
    at `https://sparklab.ap.loclx.io`).
- The gateway's scoped bearer token (`TASKMASTER_HUB_API_TOKEN`, falls back
  to `GATEWAY_API_TOKEN`) — read it from the gateway's `.env` or an already-
  registered `taskmaster-hub` MCP entry's `env` block.
- If the project lives on a **remote** server, that server must already be a
  registered gateway server (`apps/terminal-gateway/servers.json`, or
  `GET /api/servers`) — the Hub execs `task-master` through the gateway's
  existing SSH exec seam, keyed by `serverId`.
- A real `task-master` binary reachable on that server is strongly
  recommended (see "binaryMode" below) — global `npm install -g
task-master-ai`, under whatever node the target user actually uses (nvm,
  system node, etc).

## Step 1 — `task-master init` + a zero-key AI provider

Run inside the project directory (locally, or over ssh for a remote host):

```bash
task-master init -y --name "<project-name>"
task-master models --set-main sonnet --claude-code
task-master models --set-fallback opus --claude-code
```

`--claude-code` is a zero-key provider — task-master shells to whichever
`claude` CLI is already logged in on that host, same trust model as this
repo's own `run_codex` tool. Only reach for a paid provider if no CLI is
available. If the host has no global `task-master` binary yet, run the same
commands via `npx -p task-master-ai@latest task-master <args>` instead (see
"npx" pitfall below for the exact flag form — `npx -y task-master-ai@latest
task-master` is wrong and silently runs the MCP server instead of the CLI).

This creates `.taskmaster/` (config, empty task list, templates) and writes
`.gitignore` entries — expect `git status` to show `.gitignore` modified and
`.taskmaster/`, `.env.example` untracked afterward; review before committing.

## Step 2 — register the `taskmaster-hub` MCP server for this project

Two patterns, pick based on the host:

### 2a. Local project, or any host without an existing MCP-wrapper convention

`claude mcp add`, local scope (keys the registration to this exact directory
path in `~/.claude.json`):

```bash
claude mcp add taskmaster-hub \
  -e TASKMASTER_HUB_API_TOKEN=<token> \
  -e TASKMASTER_HUB_BASE_URL=http://127.0.0.1:3107 \
  -e TASKMASTER_HUB_ACTOR=<project>-worker \
  -e TASKMASTER_HUB_ROLE=Developer \
  -e TASKMASTER_HUB_NAME="Claude Code (<project>)" \
  -- node /abs/path/to/claude-web-terminal/tools/taskmaster-hub-mcp/server.mjs
```

**Flag-order pitfall (hit live, 2026-09-06):** every `-e KEY=VALUE` MUST come
**before** the `--` separator. Anything after `--` is the literal command
line handed to the child process — `-e` flags placed after `--` get passed
as bare argv to `node` (which ignores them), and the server starts with an
**empty env**, silently unauthenticated. `claude mcp list` will still show
"✔ Connected" in this broken state (it only checks the stdio handshake, not
whether the server can actually reach the gateway) — this is a false
positive, always confirm with the smoke test in Step 3 too. If you suspect
this happened: `claude mcp remove taskmaster-hub` then re-add with the
correct order, and check with:

```bash
python3 -c "
import json
d = json.load(open('$HOME/.claude.json'))
print(json.dumps(d['projects']['<abs project path>']['mcpServers']['taskmaster-hub'], indent=2))
"
```

`env` should be non-empty.

Give each project its own `TASKMASTER_HUB_ACTOR` (matching `^[\w.@:-]{1,64}$`)
so its claims live on a distinct auth channel — never share one across
projects/workers.

### 2b. Remote host with an existing project-scope `.mcp.json` + wrapper-script convention

Some hosts (e.g. Buzzebees-Workstation) already register other MCP servers
(`pm`) via a `~/.local/bin/sparklab-<name>` wrapper that sources a
`~/.config/sparklab/<name>.env` file and execs node, referenced from the
project's own `.mcp.json` (project-scope, shared with the repo — check
whether it's gitignored before assuming it's private). Mirror that
convention instead of `claude mcp add --scope local`, so all the host's MCP
registrations look the same:

```bash
# 1. Copy the server file once per host (sha256 verify):
ssh <host> 'mkdir -p ~/.local/lib/sparklab-taskmaster-hub-mcp && cat > ~/.local/lib/sparklab-taskmaster-hub-mcp/server.mjs' \
  < tools/taskmaster-hub-mcp/server.mjs

# 2. Per project: its own env file (values single-quoted — the wrapper
#    `source`s this as a shell script, and TASKMASTER_HUB_NAME contains
#    spaces/parens that break an unquoted `source` with a syntax error):
cat > ~/.config/sparklab/taskmaster-hub-mcp-<project>.env <<'EOF'
TASKMASTER_HUB_API_TOKEN='<token>'
TASKMASTER_HUB_BASE_URL='https://sparklab.ap.loclx.io'
TASKMASTER_HUB_ACTOR='<project>-worker'
TASKMASTER_HUB_ROLE='Developer'
TASKMASTER_HUB_NAME='Claude Code (<project>)'
EOF

# 3. A wrapper per project (the copied server.mjs is shared, one per host,
#    since it has no per-project state):
cat > ~/.local/bin/sparklab-taskmaster-hub-mcp-<project> <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set -a
source "$HOME/.config/sparklab/taskmaster-hub-mcp-<project>.env"
set +a
exec /path/to/node "$HOME/.local/lib/sparklab-taskmaster-hub-mcp/server.mjs"
EOF
chmod +x ~/.local/bin/sparklab-taskmaster-hub-mcp-<project>

# 4. Register it in the project's own .mcp.json (create if absent):
python3 -c "
import json, os
p = '.mcp.json'
d = json.load(open(p)) if os.path.exists(p) else {}
d.setdefault('mcpServers', {})['taskmaster-hub'] = {
    'type': 'stdio',
    'command': '$HOME/.local/bin/sparklab-taskmaster-hub-mcp-<project>',
    'args': [], 'env': {}
}
json.dump(d, open(p, 'w'), indent=2)
"
```

**Project-scope `.mcp.json` needs a one-time human trust approval.**
`claude mcp list` will show `⏸ Pending approval (run \`claude\` to approve)`until someone opens`claude`interactively in that directory once and
accepts the project's MCP servers. This is expected — note it in the
project's`AGENTS.md`so the next agent/human isn't confused by tools that
list but silently can't be called (same caveat as`docs/TASKMASTER-AGENT-SETUP.md` §5 for any project-scope MCP entry).

## Step 3 — register the project with the Hub (`taskmaster_hub_init`)

Either call the `taskmaster_hub_init` MCP tool (if you already have a
session with this MCP loaded — even one registered for a _different_
project, since the tool takes an explicit `path`), or hit the REST route
directly:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<project-name>","serverId":"<local|registered-server-id>","path":"/abs/project/path"}' \
  https://<gateway-origin>/api/taskmaster/projects
```

The response's `binaryMode` tells you whether registration found a real
`task-master` binary (`"binary"`) or not (`"core-only-npx"` — **see the
errata note below, this mode is far more limited than its name suggests**).
If you install the binary _after_ registering, re-probe by deleting and
re-creating the project (there is no PATCH-to-reprobe route):

```bash
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" https://<origin>/api/taskmaster/projects/<id>
curl -s -X POST ... # same POST as above — new id, name preserved
```

**Smoke-test quirk (hit live, 2026-09-06):** piping a `tools/call` JSON-RPC
message to the MCP server's stdin and reading stdout immediately often shows
only the `initialize` response — the process can exit (stdin EOF) before the
async gateway round-trip for `tools/call` finishes writing its response.
Always add `notifications/initialized` after `initialize` and a few seconds
of `sleep` after the last request before closing stdin, or just verify via a
plain `curl GET /api/taskmaster/projects` afterward instead of trusting the
piped stdout.

## Step 4 — verify end-to-end

```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://<origin>/api/taskmaster/projects" | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "https://<origin>/api/taskmaster/projects/<id>/overview"
curl -s -H "Authorization: Bearer $TOKEN" "https://<origin>/api/taskmaster/projects/<id>/tasks"
```

A fresh project should return `{"tasks":[],"metadata":{"total":0,...}}` — not
an error. If `overview`/`tasks` 503 with `"task-master CLI is not installed
on this server"` on a **remote** project where you know the binary IS
installed, see the SSH-PATH errata below.

## Step 5 — write/append an `AGENTS.md` snippet

`taskmaster_hub_init`'s response includes an `agentsMdSnippet` field (it
does **not** write any file itself). If the project already has a real
`AGENTS.md`, append a `## Task Master Hub` section rather than overwriting
it. Include the project id, the claim protocol, the tool list, and — for a
project-scope `.mcp.json` registration — the one-time trust-approval note
from Step 2b.

---

## Errata against `docs/TASKMASTER-HUB-PLAN.md`

Two things the design doc describes that do **not** match the shipped code
as of 2026-09-06 (`apps/terminal-gateway/src/server.js`) — found while
onboarding the first-ever **remote** (SSH) project, which is also the first
time these paths were actually exercised:

1. **There is no npx fallback.** §1e/D5 of the plan describe
   `"core-only-npx"` binaryMode as meaning core-family commands
   (`list`/`show`/`next`/`set-status`) run via an `npx -p
task-master-ai@<pinned> task-master ...` fallback when no real binary is
   installed. The actual code never does this: `TASKMASTER_COMMAND`
   (`server.js`, just above `runTaskmasterCore`) is a single global argv
   prefix, defaulting to the literal `["task-master"]`, used identically for
   every route regardless of `binaryMode`. `"core-only-npx"` only means "the
   legacy-family write routes (`add-task`/`expand`/`add-dependency`/
   `use-tag`) are gated to 503" — it does **not** mean the core-family reads
   get an npx fallback. Without a real `task-master` binary resolvable on
   that server, **every route except `claim`/`update-progress`/`release`**
   (which are pure gateway-sidecar operations, never touching the CLI) 503s
   with `"task-master CLI is not installed on this server"`. Practical
   upshot: for any project you actually want to read tasks from through the
   Hub, install a real binary — don't rely on "core-only-npx" as a working
   partial mode.

2. **Non-interactive SSH doesn't source `~/.bashrc`, so an nvm-managed
   `task-master` was invisible even once installed.** `serverCmdArgv`/
   `serverCmd` ran a plain `ssh host "cd <path> && task-master ..."`, which
   sshd executes as a non-interactive, non-login shell — bash does not read
   `~/.bashrc` in that mode, and that's exactly where a typical nvm install
   adds its bin dir to `PATH`. Fixed 2026-09-06: `serverCmdArgv`/`serverCmd`
   gained an opt-in `interactiveShell` option, used by the three Task Master
   call sites (`runTaskmasterCore`, `runTaskmasterLegacy`, the `--version`
   binaryMode probe), that wraps the remote command as `bash -ic '<cmd>'`
   instead — an _interactive_ bash (even non-login) does source `~/.bashrc`.
   Verified against a real nvm-managed host. Harmless side effect: `bash -ic`
   prints job-control warnings to stderr (`cannot set terminal process
group`, `no job control in this shell`) — these don't reach stdout, so
   they don't corrupt the JSON responses core-family routes parse. This
   fix is opt-in per call site — `fs`/`git`/`codex` routes through
   `serverCmd` are unaffected, still run the plain non-interactive form.

Neither of these needed a design change to the Hub's model — just a code fix
(#2, already applied) and a documentation correction (#1, this note; the
plan's original npx-fallback intent was apparently never implemented rather
than deliberately dropped — worth a real decision if it's still wanted, see
`docs/TASKMASTER-HUB-PLAN.md` §8 backlog).

3. **`task-master init -y` does not create `.taskmaster/tasks/tasks.json`.**
   This CLI version only scaffolds `config.json`/`state.json`/`templates/`/
   empty `tasks/`/`docs/`/`reports/` dirs on init — `tasks.json` itself is
   meant to come from a follow-up `parse-prd` (or the first `add-task`, except
   `add-task` itself hard-requires the file to already exist: `B.existsSync(n)
|| (error, exit)` in the installed package, no auto-create). Read-family
   routes (`list`/`show`/`next`/`overview`) tolerate the missing file and
   return empty results; every write route (`add-task`/`update-task`/`expand`/
   `add-dependency`) fails, and — because of errata #4 below — failed with
   the same misleading "task-master CLI is not installed" message, making it
   look like a binary/PATH problem when the real cause was just a missing
   file. **Fix at onboarding time (Step 1, not yet automated):** after
   `task-master init -y`, seed the canonical empty skeleton yourself —

   ```json
   {
     "master": {
       "tasks": [],
       "metadata": {
         "version": "1.0.0",
         "lastModified": "<iso timestamp>",
         "taskCount": 0,
         "completedCount": 0,
         "tags": ["master"]
       }
     }
   }
   ```

   at `.taskmaster/tasks/tasks.json`. This is not "hand-editing task content"
   (no task data is fabricated) — it's completing what `init` itself should
   have done, and matches the exact shape a real project's tasks.json uses
   (verified against this repo's own `.taskmaster/tasks/tasks.json`). All
   four projects onboarded on 2026-09-06 (`tipitaka-app`, `aureuspool-trade`,
   `project-gendash-system`, `bzbs-ai-help-center`) were missing this and
   were fixed retroactively 2026-09-07.

4. **A second, more serious real bug, found chasing #3: `serverCmd`'s `cwd`
   option leaked into the LOCAL `execFileAsync` call for a REMOTE (ssh)
   server, causing every legacy-family (`add-task` etc.) call against ANY
   ssh-registered project to fail instantly with the exact same misleading
   "task-master CLI is not installed" message** — regardless of whether the
   binary was actually installed. `runTaskmasterLegacy` passes `{cwd:
projectPath, ...}` to `serverCmd`; the old `serverCmd` spread that whole
   `opts` object (cwd included) straight into `execFileAsync(a[0], a.slice(1),
{...opts})` where `a[0]` is `"ssh"` — a LOCAL command. Node's own
   `execFile`/`spawn` validates `options.cwd` by trying to chdir the local
   child process into it _before_ spawning; since the remote project path
   (e.g. `/home/workspace/...`) doesn't exist on the gateway host, this threw
   a real `ENOENT` in under half a second, which `isTaskmasterUnavailableError`
   then misclassified exactly like a missing binary — a completely different
   root cause hiding behind an identical error message. This is why manually
   reproducing the exact same command over ssh (even with the exact same
   `ControlPath`/`ControlMaster` options the gateway uses) always succeeded:
   a manual ssh invocation never routes `cwd` through `execFileAsync` at all,
   so the bug only manifests through the gateway's own code path. It was
   never triggered before because `project-gendash-system`/
   `bzbs-ai-help-center` (2026-09-06) were the first-ever remote/SSH Task
   Master Hub projects — every prior legacy-family call had been against
   `serverId: "local"`, where passing `cwd` to `execFileAsync` is correct.
   **Fixed 2026-09-07:** `serverCmd` now destructures `cwd`/`interactiveShell`
   out of `opts` before spreading the rest, and only re-adds `cwd` to the
   `execFileAsync` options when `server.type === "local"` — for a remote
   server it's already baked into the ssh command string by `serverCmdArgv`
   and must not be repeated. Verified live: `add-task` now succeeds end-to-end
   against both remote projects (~70-105s wall time per call — see the timing
   note below). **Diagnostic technique that found it:** when a "not installed"
   error reproduces instantly (well under a second) but a manual reproduction
   of the apparent command succeeds, suspect the error is being thrown before
   the real command ever runs — check for something in the call path that
   could fail synchronously against local, not remote, state.

5. **Timing note (not a bug, but worth planning around):** `add-task` against
   the zero-key `claude-code` provider took 70-105+ seconds per call in
   practice, some individual attempts sent 700K+ input tokens for a
   single-line prompt and ran past `TASKMASTER_TIMEOUT_MS`'s 120s default
   entirely (`{"error":"task-master timed out after 120000 ms","code":
"outcome_unknown"}` — per D11, the CLI may have already written state
   before the timeout fired, so the caller must re-fetch rather than blindly
   retry). Pushing many tasks in a row (e.g. a 32-task dev-plan import) at
   this per-call latency is a real, un-optimized cost — plan for it, and
   prefer surfacing partial progress over silently retrying a timed-out call.
