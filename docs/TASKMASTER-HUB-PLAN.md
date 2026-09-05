# Task Master Hub (pluggable HTML artifact) — Design & Decision Record

> Status: **design only — CLI surface surveyed against a real checkout, nothing
> built yet.** Scope: a new pluggable artifact, `/api/taskmaster/*` in the
> gateway, that gives one dashboard over **multiple `claude-task-master`
> projects** (each project = one `.taskmaster/` directory on a server already
> registered in Connected Servers), and exposes the same operations as agent
> tools so Claude Code / Codex sessions running in this app's terminals and the
> Agent Chat panel both read/write the **same on-disk task data** that a human
> is looking at in the Hub.
>
> Two decisions are already locked in (user confirmed 2026-09-05):
> **(a)** lives inside claude-web-terminal as a new artifact — reuses the
> gateway/multi-server/auth/sidecar-store/sandboxed-iframe patterns already
> shipped for Kanban/PM/Notes, rather than a native `apps/hub` package inside
> claude-task-master itself; **(b)** every mutation shells out to the real
> `task-master` CLI binary — the gateway never reads or writes
> `.taskmaster/tasks/tasks.json` directly, so tm-core's own validation,
> dependency-cycle checks, and id/tag/schema logic stay the single source of
> truth (mirrors how `run_codex` never touches a repo's files itself — it
> shells out to `codex exec`).
>
> §1 is the reason this plan looks the way it does: **task-master's CLI is
> mid-migration** between a legacy `scripts/modules`-backed command family and
> a newer `@tm/core`-backed family, and the two families disagree on flags,
> JSON support, and whether `cwd` matters — none of that is documented, it was
> found by actually running the published `task-master-ai@latest` package
> against a real seeded `.taskmaster/` checkout (`~/workspaces/samples/claude-task-master`,
> tag `loop`, 18 tasks). Every claim in §1 is reproducible; commands and raw
> output are quoted verbatim so a future build session doesn't have to
> re-derive them.

---

## 0. Why file-based sync needs no new protocol

task-master has no database — `.taskmaster/tasks/tasks.json` (plus
`.taskmaster/state.json` for the active tag, `.taskmaster/config.json` for
models) **is** the state, exactly like this repo's own load-bearing rule that
tmux is the source of truth, not the gateway. That means "sync" between the
Hub UI, an agent running in a terminal pane, and a human running the raw CLI
is **not a protocol to build** — it already exists, because all three write
through the same `task-master` binary against the same files. The Hub's job is
narrower than it sounds: **(1)** poll `task-master list/show --project <path>
--json` for display, **(2)** forward mutations to the real CLI instead of
hand-rolling a second JSON writer, **(3)** aggregate that across however many
`{server, path}` pairs the user registers as "projects."

---

## 1. CLI command survey (empirical — verified 2026-09-05)

Ran via `npx -y --no-audit -p task-master-ai@latest task-master <cmd> --help`
and live invocations against the seeded checkout. Two important side notes
from getting here, worth keeping for whoever builds this:

- The published package has **three bins** — `task-master` (the CLI),
  `task-master-mcp`, and `task-master-ai` (also the MCP server — same as
  `task-master-mcp`, **not** the CLI). Plain `npx task-master-ai <args>`
  launches the **MCP stdio server** and hangs waiting on stdin — you must
  `npx -p task-master-ai@latest task-master <args>` (or `npm install -g
task-master-ai` and call `task-master` directly) to reach the CLI. A route
  that shells out must invoke the `task-master` bin explicitly, never the
  package name.
- `npm`'s new supply-chain "metavuln" advisory scan can make a cold `npx`
  install spuriously abort with `ECOMPROMISED — Lock compromised` (an
  `AbortSignal` timeout in `libnpmexec`'s `with-lock.js`, not an actual
  compromise) when the dependency tree is large, as task-master's is (Ark/AI
  SDK providers, OpenTelemetry, etc.). `--no-audit` avoids it. If the gateway
  ever shells to a bare `npx task-master-ai@latest ...` fallback (see D9),
  it must pass `--no-audit` or this will look like an intermittent hang.

### 1a. Two command families that don't agree with each other

|                                                                                                                                                                                                                                                                                                                                                                                        | `--project <path>` (no cwd needed) | JSON output     | Flag name                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------- | ----------------------------------------------------------------------- |
| **tm-core-backed** (`list`, `show`, `next`, `set-status`)                                                                                                                                                                                                                                                                                                                              | ✅ yes                             | ✅ yes          | `-f/--format text\|json` (`list`/`show` also take a `--json` shorthand) |
| **legacy `scripts/modules`-backed** (`add-task`, `expand`, `update-task`, `update-subtask`, `update`, `add-dependency`, `remove-dependency`, `move`, `parse-prd`, `add-subtask`, `remove-subtask`, `clear-subtasks`, `tags *`, `complexity-report`, `analyze-complexity`, `research`, `remove-task`, `validate-dependencies`, `fix-dependencies`, `sync-readme`, `generate`, `models`) | ❌ no `--project` flag at all      | ❌ no JSON mode | boxen/chalk styled text only, to a TTY-shaped box                       |

Consequence: the Hub cannot pass one uniform invocation shape. It needs a
small **per-command capability table** (§3) baked into the gateway route, not
a generic `task-master <cmd> --json --project <path>` wrapper.

**Correction (§1e, Phase 0 spike) — do not trust the paragraph originally
here.** The first draft of this doc claimed `--file <absolute path>` makes a
legacy command cwd-independent. That's false: `--file` only relocates where
`tasks.json` is read/written. Project-root discovery — and therefore which
`.taskmaster/config.json` (and thus which AI provider) gets used — still
follows the **real process `cwd`**, regardless of `--file`. See §1e for the
live reproduction. Every legacy-family command needs real `cwd = project
path`, full stop; there is no `fileFlag` shortcut.

### 1b. `--tag` support is also inconsistent — real correctness risk

`list`, `next`, `add-task`, `expand`, `update-task`, `add-dependency`,
`move`, `parse-prd`, `complexity-report` all take an explicit `--tag <tag>`.
**`show` and `set-status` do not** — both are `--project`-aware (tm-core
family) yet still fall back to whatever tag `.taskmaster/state.json`'s
`currentTag` says for that project, which is **shared mutable state**
(`tags use <name>` changes it for every future command against that project,
including ones issued by a human running the raw CLI outside the Hub). A
multi-tag Hub that lets a viewer pick "workstream: backlog" and then calls
`set-status` expecting it to land in that tag would silently mutate whatever
tag happens to be currently active instead — a correctness bug, not a
cosmetic one.

**Decision for v1: the Hub operates on each project's current tag only.**
Switching tags is exposed as one explicit action (`tags use <name>`,
single-writer, confirmed in the UI) rather than a per-request parameter.
Multi-tag-at-once views are out of scope until every command in the surface
is re-verified for `--tag` support (tracked in §8). **Verified in §1e:** `tags
use <name>` is the real, correct subcommand for version `0.43.1` (exit 0 +
`[SUCCESS]` on success, exit 1 + `[ERROR] Tag "…" does not exist` on failure,
and `.taskmaster/state.json`'s `currentTag` updates immediately and reliably)
— an external doc lookup during the Codex review disputed this against a
`use-tag` form from a different/newer upstream doc; our own live `--help` and
live invocation against the exact version we're building against settle it in
favor of `tags use`.

### 1c. `success`/exit-code semantics are not uniform — verified failure case

```
$ task-master set-status --id=99999 --status=done --project <seeded checkout>
exit code: 1
stdout:  ╭───────────────────────────────────╮
         │   ✅ Successfully updated 0 tasks   │
         ╰───────────────────────────────────╯
stderr:  Failed to update task 99999:
         Failed to update task status for 99999

$ task-master set-status --id=99999 --status=done --format json
exit code: 1
stdout: {"success": true, "updatedTasks": [], "storageType": "file"}
stderr: {"success":false,"error":"Failed to update task status for 99999","taskId":"99999","timestamp":"…"}
```

Two findings that must become explicit gateway logic, not assumptions:

- The styled text mode prints a **success-shaped box even on total failure**
  ("Successfully updated 0 tasks") — text-mode output must never be
  pattern-matched for success; it exists for a human terminal, not a
  machine.
- `--format json`'s **stdout** payload for this failure case is
  `{"success": true, "updatedTasks": []}` — `success:true` with an **empty**
  `updatedTasks` is a lie by omission, not a real success. The actual error
  object went to **stderr**, separately. Rule for every JSON-capable command
  the gateway calls: treat the call as failed if **exit code ≠ 0**, or if a
  `--format json` response's own array/object field (`updatedTasks`,
  `task`, …) doesn't actually contain what was asked for — never trust a
  bare `success` boolean alone.

`show <missing-id> --json` is cleaner (`{"task": null, "found": false,
"storageType": "file"}`, exit 0) — that shape is fine to trust as-is. Every
other JSON-capable command should get the same live-verification pass before
the gateway trusts its shape — **done for the full v1 set in §1e.**

**`add-dependency` (legacy family, no JSON) is exit-code-reliable and
text-pattern-distinguishable (verified §1e):** real failure (would-create-a-
cycle) → exit 1, stderr contains `[ERROR] Cannot add dependency … as it would
create a circular dependency.`; a harmless already-exists re-add → exit **0**
with `[WARN] Dependency … already exists in task ….` — safe to map
`exit≠0 AND /circular dependency/i` → `400`, else exit-code alone for
success/failure.

### 1d. Verified `list --json` shape (real output, seeded checkout, trimmed)

```jsonc
{
  "tasks": [
    {
      "id": "1",
      "title": "Define Loop Module Types and Interfaces",
      "description": "…",
      "status": "done", // pending|in-progress|done|deferred|cancelled|blocked|review
      "priority": "high", // high|medium|low
      "dependencies": [],
      "details": "…", // long markdown, can be tens of KB
      "testStrategy": "…",
      "subtasks": [
        /* nested, dot-ids like "1.3" appear only in `show`, not `list` top-level ids */
      ],
      "updatedAt": "2026-01-08T21:49:59.115Z",
      "complexity": 2, // present only if analyze-complexity has been run
      "recommendedSubtasks": 0,
      "expansionPrompt": "…",
      "blocks": ["3", "4", "5", "6", "7", "8"], // reverse-dependency edges, NOT in task-master's own docs
    },
  ],
  "metadata": {
    "total": 18,
    "filtered": 18,
    "tag": "loop",
    "storageType": "file",
    "allTags": false,
  },
}
```

`show <id> --json` returns `{ task: {...same shape, subtasks fully nested...} }`
(singular, not an array, even though `show` accepts comma-separated ids in
its `--help` text — re-verify multi-id `show --json` shape before relying on
it, see §8). **`next --format json` on an empty/fully-blocked tag (verified
§1e):** `{ "task": null, "found": false, "tag": "test-tag", "storageType":
"file", "hasAnyTasks": true }` — `hasAnyTasks` distinguishes "tasks exist but
none are unblocked" from "tag is genuinely empty," which the Hub's "what's
next" tile should surface as two different empty states, not one.

### 1e. Phase 0 verification spike (2026-09-05, worktree `taskmaster-hub`) — every blocking item resolved

Performed after a Codex-rescue review of the first draft flagged D3/§7 as
contradictory and D8/remote-SSH as unverified assumptions dressed up as
decisions. Everything below is a **live** result, not an inference — reproduced
against `task-master-ai@0.43.1` (pinned; matches the version already surveyed
in §1a/§1b/§1c/§1d, so no drift since the original draft), both **locally**
and over a real **ssh-to-localhost** session (ephemeral key added to
`~/.ssh/authorized_keys` for the duration of the spike, removed after —
mirrors the existing `acceptance-remote-survive.js` pattern), using a real
globally-installed binary (`npm install -g --prefix <scratch> task-master-ai@0.43.1`)
so the exec shape matches D5's primary (non-npx) resolution path.

1. **D8 (credentials) — RESOLVED, not blocking.** `parse-prd`, `add-task`, and
   `expand` all succeeded, **locally and over ssh**, against a disposable
   throwaway project (`task-master init -y`) configured with the **zero-key**
   `claude-code`/`sonnet` provider (`task-master models --set-main sonnet
--claude-code`) — real telemetry confirmed `Provider: claude-code, Model:
sonnet, Est. Cost: $0.000000` on every call. No extra environment variables
   were injected beyond what the shell already had; the `claude` CLI's own
   auth (stored outside process env) was sufficient in a fresh non-interactive
   ssh session. **No curated env allowlist (à la `codexChildEnv`) is needed
   for the claude-code provider path.** (An API-key provider, e.g. plain
   `anthropic`, would need that key in the target project's own `.env` — that
   remains the project's responsibility per D8, untested here since it isn't
   the gateway's problem either way.)
2. **The `--project` flag (core family) is genuinely cwd-independent —
   RESOLVED.** `list --project <path> --format json` run over ssh from a
   default ssh login shell (cwd = `$HOME`, nowhere near the target project)
   correctly returned `"tag": "loop"` — the target project's real active tag
   — proving `--project` fully substitutes for cwd for this family, locally
   and remotely, no `cd` wrapper needed, ever.
3. **`--file` does NOT substitute for cwd (legacy family) — the corrected
   finding that overturns part of the original D3.** Running `add-task --file
<absolute path to that project's tasks.json>` from cwd `/tmp` (nowhere near
   the project) printed `ProjectRoot: /tmp` in its own log line and then
   **used the wrong provider** — the default `anthropic`/`claude-sonnet-4-…`
   config baked into a fresh `task-master init`, not the `claude-code`/`sonnet`
   the target project's own `.taskmaster/config.json` actually specified —
   and failed with `Required API key ANTHROPIC_API_KEY … is not set`. `--file`
   only relocates the tasks.json read/write path; **project-root (and
   therefore config/provider) resolution is real-`cwd`-only for every legacy
   command, with no exception.** This means D3's original `fileFlag` vs
   `cwdOnly` split is a false distinction — collapse it (§2 D3 rewritten
   below).
4. **The `cd <path> && task-master …` wrapper works correctly for a real
   installed binary, both locally and over ssh — RESOLVED for D5's primary
   path.** `cd '<project>' && task-master tags list` (no npx involved)
   succeeded in both environments with correct output.
5. **A real, reproducible bug in the npx-fallback path — new finding, not in
   the original draft.** `cd '<project>' && npx -y --no-audit -p
task-master-ai@0.43.1 task-master <anything>` reliably fails with `sh: 1:
task-master: not found` (exit 127), reproduced **both locally and over ssh**,
   specifically when the target project's _own_ `package.json` happens to
   declare a bin literally named `task-master` (true of task-master's own
   monorepo — our seeded test fixture is a pathological case here, being
   task-master's own source checkout) — npx appears to defer to that local,
   unbuilt bin declaration instead of fetching/using the `-p`-requested
   package. Root cause not fully isolated (not confirmed whether _any_
   `package.json` at cwd triggers it or only a colliding bin name), but the
   actionable conclusion holds either way: **the npx fallback must never be
   combined with a `cd` into the target project.** Consequence for D5: the
   npx fallback (`TASKMASTER_COMMAND` override) is only safe to rely on for
   **core-family** commands (`--project`, no cd, confirmed working over ssh
   in #2 above); a server that needs **legacy-family** actions (`add-task`,
   `expand`, `update-task`, `add-dependency`, and everything still excluded
   per D6) must have a **real installed `task-master` binary**, not just npx
   reachability. The gateway should probe for and record which mode a
   registered project's server actually supports (§2 D5, rewritten).
6. **Tag switch + cycle detection, both exit-code-reliable — RESOLVED.**
   `tags use <name>` and `add-dependency`'s circular-dependency rejection
   both behave exactly as documented in §1b/§1c above, verified live including
   the exit-0-with-`[WARN]`-on-harmless-re-add edge case.

---

## 2. Architectural decisions

**D1 — Registry sidecar holds _pointers_, never task data.** New
`apps/terminal-gateway/src/taskmaster.js` (same shape as `registry.js`):
`data/taskmaster-projects.json` = `{ projects: [{ id, name, serverId, path }] }`.
`serverId` reuses the existing Connected Servers registry — remote projects
get SSH multiplexing, reachability probing, and auth for free. Adding a
project probes `path/.taskmaster` exists (`serverCmd(server, ["test", "-d",
"<path>/.taskmaster"])`) before accepting it, same spirit as `probeServer`.

**D2 — Every mutation shells out to the real `task-master` binary.** No route
ever opens `tasks.json` itself. This is what keeps tm-core's dependency-cycle
checks, id parsing (`"1.2"`, `"HAM-123"`), and tag/schema logic authoritative
— the Hub can never drift from what the CLI (and therefore what
Claude-Code/Codex running in a terminal pane) considers valid.

**D3 — Per-command capability table, corrected by the §1e spike (no
`fileFlag`/`cwdOnly` split — that distinction was false).** A fixed map in
the gateway:

```js
const TASKMASTER_COMMANDS = {
  // core family: --project is genuinely cwd-independent (§1e #2), never cd.
  list: { family: "core", json: true },
  show: { family: "core", json: true },
  next: { family: "core", json: true },
  "set-status": { family: "core", json: true },
  // legacy family: --file does NOT substitute for cwd (§1e #3) — every one
  // of these ALWAYS runs with real cwd = project path (local: {cwd:path} to
  // execFileAsync; remote: `cd <shellQuote(path)> && task-master …`), full
  // stop, no per-command exception.
  "add-task": { family: "legacy" },
  expand: { family: "legacy" },
  "update-task": { family: "legacy" },
  "add-dependency": { family: "legacy" },
  // move, parse-prd, tags *, research, analyze-complexity, remove-task,
  // add-subtask, remove-subtask, clear-subtasks: same "legacy" family,
  // not yet wired for v1 (see D6) — each needs its own live-verified
  // success/failure contract first, same as add-dependency got in §1e #6.
};
```

`family: "core"` → append `--project <path> --format json`, run from
whatever cwd the gateway process already has (never touched), parse stdout as
JSON, apply the §1c success rule. `family: "legacy"` → **always** real cwd =
project path (§1e #3) — locally via `execFileAsync`'s `{cwd: path}` option,
remotely via `cd <shellQuote(path)> && task-master <args>` — judge success by
**exit code** (+ the `add-dependency` cycle-text check from §1c where
applicable), then issue a follow-up `list --project <path> --format json` (or
`show`) to fetch the actually-changed state; the Hub UI updates from that
re-fetch, never from parsing the mutation's own text output.

**D4 — Command allowlist, argv-only, mirrors the Codex tool's safety model.**
Only the commands actually implemented in D3's table are reachable — no
passthrough of arbitrary `task-master` subcommands or flags. Every argv is
built as an array (never string-concatenated) even for the `cd … &&` wrapper
case, exactly like the fs/codex routes' existing rule.

**D5 — Binary resolution + override, corrected by the §1e spike.** Try
`task-master` on `$PATH` first (cheap); `ENOENT` (local) or "command not
found" (remote stderr match, same regex the Codex route already uses) → `503
taskmaster_unavailable`. A `TASKMASTER_COMMAND` env var overrides the
resolved argv prefix for tests (mirrors `CODEX_COMMAND`). **The npx fallback
(`npx -y --no-audit -p task-master-ai@<pinned> task-master`) is safe ONLY for
`family: "core"` commands** (no `cd`, confirmed working locally and over ssh,
§1e #2) — **it must never be combined with the legacy family's `cd <path>
&&` wrapper** (§1e #5's reproducible `task-master: not found` failure). A
server that needs legacy-family actions enabled must have a real installed
binary; record which mode (`"binary"` vs `"core-only-npx"`) a project's
server actually supports at registration time (probe: does `task-master
--version` resolve on `$PATH`? if not, legacy-family routes for that project
return `503 taskmaster_unavailable` with a message naming the gap, core-family
routes still work via the npx fallback).

**D6 — v1 action surface, now backed by live verification for every entry
(§1e).** Ship `list`, `show`, `next`, `set-status` (core, always available)
plus `add-task`, `update-task`, `expand`, `add-dependency` (legacy, requires
a real installed binary per D5 — credentials confirmed working via the
zero-key `claude-code` provider in §1e #1). Everything else in the legacy
family (`tags *`, `research`, `analyze-complexity`, `parse-prd`, `remove-task`,
subtask commands, `move`) is deliberately **not** wired for v1 — each needs
its own live-verified success/failure contract first, the same pass
`add-dependency` got in §1e #6. Tracked as the v2 backlog in §8, not silently
dropped. **One exception carved out for v1: `tags use <name>`** (§1b) — a
single, explicit, human-confirmed action (not a per-request parameter),
verified in §1e #6, needed because without it the "current tag only" model
from §1b has no way to actually switch.

**D7 — Agent tools reuse the same route, same allowlist, and are REST
clients only.** New tools in `apps/agent-service/src/tools.ts`:
`taskmaster_list_projects`, `taskmaster_list`, `taskmaster_show`,
`taskmaster_next`, `taskmaster_set_status`, `taskmaster_add_task`,
`taskmaster_update_task`, `taskmaster_expand`, `taskmaster_add_dependency`.
**Every one of these calls the gateway's `/api/taskmaster/*` routes via
`gateway-client.ts` — none reads `data/taskmaster-projects.json` or any
project's `.taskmaster/` files directly**, matching how every existing
`kanban_*`/`pm_*` tool works; the gateway remains the single enforcement
boundary. Approval tiers: reads (`list_projects`, `list`, `show`, `next`)
auto; `set_status`/`add_dependency` allow-always (routine, low-blast-radius);
`add_task`/`update_task`/`expand` **one-time** — all three invoke
task-master's own AI provider and can rewrite substantial task content, same
risk class as `run_codex`, not the "toggle a card's column" risk class of
Kanban's routine writes.

**D8 — Provider credentials are task-master's own problem, not the
gateway's — RESOLVED, verified live (§1e #1).** No curated env allowlist is
needed for the gateway to successfully invoke `add-task`/`update-task`/
`expand` against a project configured with a zero-key provider
(`claude-code`/`codex-cli`); the gateway's already-inherited environment is
sufficient, locally and over ssh. An API-key-based provider is the target
project's own `.env`/config responsibility, same as it would be for a human
running the CLI directly — the gateway does not need to know or forward any
provider secret.

**D9 — No file-watch/WS push in v1.** TanStack Query polls
`GET /api/taskmaster/projects/:id/tasks` every ~5s, same cadence and pattern
as the existing git-status poll (`hooks/use-git-status.ts`). task-master
itself isn't real-time (a human or agent finishes a CLI call, then the file
changes) — a poll is not a meaningfully worse experience than a watcher here,
and it avoids adding chokidar/file-watch machinery over SSH. The polled list
route returns a **projected summary** (id, title, status, priority,
dependencies, complexity, updatedAt) — `details`/`testStrategy`/
`expansionPrompt` (§1d: can run tens of KB per task) are fetched only by the
per-task `show` route, on demand when a task is opened.

**D10 — New artifact, not a PM-tool fork.** Own iframe host
(`components/taskmaster-hub-dialog.tsx`), own `public/taskmaster-hub/app.html`,
own `taskmasterHubOpen` store flag + `?taskmaster` URL flag + header button
(lucide `ListChecks` or similar). It borrows PM tool's _visual_ patterns
(board-ish status view, DESIGN.md tokens, sandboxed-iframe host with
`allow-scripts allow-same-origin allow-forms allow-modals`) but is a fresh
implementation — task-master's status enum (`pending/in-progress/done/
deferred/cancelled/blocked/review`), dot-notation subtask ids, and
tag/workstream model don't map cleanly onto the PM artifact's `Pm*` schema,
and D1 already rules out sharing storage.

**D11 — Error contract: typed non-2xx responses, not a blanket
`200 {ok:false}` envelope.** The existing `gateway-client.ts` pattern throws
on any non-2xx response; every existing `kanban_*`/`pm_*` tool relies on that.
Map task-master outcomes accordingly: `400` (invalid status/args, or a
detected dependency-cycle rejection per §1c's `add-dependency` text check),
`404` (unknown project, or a task `show`'s `found:false`), `503
taskmaster_unavailable` (D5), `504 taskmaster_timeout` — and for an AI-mutation
timeout specifically, the body carries `{code:"outcome_unknown"}` so the
caller knows the CLI may have already written state and must **re-fetch,
never blindly retry** (a retried `add-task`/`expand` after a false-timeout
could otherwise duplicate content).

**D12 — Tag routes exist, matching §1b/D6's exception.**
`GET /api/taskmaster/projects/:id/tags` (read-only — parses `tags list`'s
text output, or reads `.taskmaster/state.json`'s `currentTag` directly for
the "current" half, see §1e's note that this is a safe read-only exception to
D2 since task-master exposes no JSON-capable "what's current" read) and
`POST /api/taskmaster/projects/:id/tags/use` (the single confirmed
switch action, §1b/D6).

---

## 3. Data model (`data/taskmaster-projects.json`)

```jsonc
{
  "projects": [
    {
      "id": "tmp-<uuid>",
      "name": "claude-task-master (loop tag)", // user-assigned label
      "serverId": "local", // or a registered remote server id
      "path": "/home/sparklab/workspaces/samples/claude-task-master", // absolute, has .taskmaster/
      "binaryMode": "binary", // "binary" | "core-only-npx" — probed at registration, D5
      "createdAt": 0,
    },
  ],
}
```

Nothing else is persisted by the Hub — task content, status, tags, and
complexity all live inside that project's own `.taskmaster/` tree, read fresh
on every poll via the CLI (D2).

---

## 4. Backend routes (`/api/taskmaster/*`, new `handleTaskmaster` in `server.js`)

| Route                                               | Method                                    | Notes                                                                                                        |
| --------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/api/taskmaster/projects`                          | GET / POST                                | list / register (probes `.taskmaster/` + `binaryMode`, D1/D5)                                                |
| `/api/taskmaster/projects/:id`                      | DELETE                                    | registry-only removal, never touches the project's files                                                     |
| `/api/taskmaster/projects/:id/tasks`                | GET                                       | → `list --project <path> --format json`, **summary-projected** (D9)                                          |
| `/api/taskmaster/projects/:id/tasks/:taskId`        | GET                                       | → `show --project <path> --id <taskId> --json`, full detail                                                  |
| `/api/taskmaster/projects/:id/next`                 | GET                                       | → `next --project <path> --format json` (empty-state shape per §1d)                                          |
| `/api/taskmaster/projects/:id/tasks/:taskId/status` | POST `{status}`                           | → `set-status --project <path> --id <taskId> --status <status> --format json`, judged per §1c, then re-fetch |
| `/api/taskmaster/projects/:id/tags`                 | GET                                       | read-only tag list + current (D12)                                                                           |
| `/api/taskmaster/projects/:id/tags/use`             | POST `{name}`                             | → `tags use <name>` (D12, single confirmed action)                                                           |
| `/api/taskmaster/projects/:id/tasks`                | POST `{prompt, priority?, dependencies?}` | → `add-task --prompt "…" …` with **real cwd = project path** (D3), then re-fetch                             |
| `/api/taskmaster/projects/:id/tasks/:taskId`        | PATCH `{prompt}`                          | → `update-task --id <taskId> <prompt>`, real cwd                                                             |
| `/api/taskmaster/projects/:id/tasks/:taskId/expand` | POST `{research?, num?}`                  | → `expand --id <taskId> …`, real cwd                                                                         |
| `/api/taskmaster/projects/:id/dependencies`         | POST `{id, dependsOn}`                    | → `add-dependency --id <id> --depends-on <dependsOn>`, real cwd, cycle text → `400`                          |

Same auth as every other artifact route: cookie or shared bearer
(`isArtifactBearerAuthorized`), GET Origin-exempt, writes Origin/CSRF-checked.
Error mapping per **D11** — typed non-2xx, not a blanket `200 {ok:false}`.

Schemas: new `TaskMaster*` block in `packages/shared-types/src/terminal.ts`
— deliberately **not** a tight 1:1 mirror of task-master's own JSON shape
(§1d) since that shape is undocumented and unversioned upstream; keep fields
optional/passthrough-tolerant so a task-master version bump doesn't hard-break
parsing.

---

## 5. Frontend

- `taskmasterHubOpen` store slice (ephemeral, persist-excluded, like
  `kanbanOpen`/`pmOpen`), `?taskmaster` URL flag, always-enabled header
  button.
- `components/taskmaster-hub-dialog.tsx` — sandboxed iframe host,
  `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"` (D11
  lesson from PM tool — bake this in from the start, don't discover the gap
  later).
- `public/taskmaster-hub/app.html` — self-contained, zero external requests,
  DESIGN.md tokens. Top bar: project switcher (across every registered
  `{server, path}`) + "Add project" (form: server dropdown from the existing
  registry + path) + current-tag display with a "switch tag" confirm action
  (D12). Per-project view: status columns
  (pending/in-progress/review/done, deferred/cancelled/blocked collapsed into
  a filterable "other" bucket — task-master's 7-status enum doesn't map onto
  a 4-column Kanban cleanly, don't force it) with dependency-count and
  complexity badges pulled straight from the summary payload (§1d's
  `blocks`/`complexity` fields); click a task for the full `show` detail
  (subtasks, `testStrategy`, full `details` markdown, fetched on demand per
  D9) + status dropdown + "Add dependency" + "Expand" (research toggle) +
  "Update via prompt" actions, each a thin form over §4's routes; an explicit
  "no ready task" / "tag is empty" empty state for the next-task tile (two
  distinct states per §1d's `hasAnyTasks`).

---

## 6. Testing plan

`apps/terminal-gateway/test/taskmaster-endpoints.js` (`test:taskmaster`),
standalone script in the existing style (real gateway, `throw` asserts,
PASS/FAIL) — **but must stub the `task-master` binary** (`TASKMASTER_COMMAND`
override, D5) the same way `codex-endpoints.js` stubs `codex`, so the
deterministic suite never depends on network/npx/real AI providers. Cases to
cover, driven directly from §1's (now-verified) findings:

- Registry CRUD + the `.taskmaster/` existence probe + `binaryMode` probe (D1/D5).
- `family: "core"` commands get `--project <path> --format json` and run
  from the gateway's own cwd, unchanged (§1e #2) — never a `cd` wrapper.
- `family: "legacy"` commands always get real cwd = project path (local
  `{cwd}` option / remote `cd &&`), never `--file` as a substitute (§1e #3).
- The §1c failure contract: a stubbed `set-status` that exits 1 with a
  success-shaped JSON stdout must still be reported as a failure by the
  route.
- The §1c `add-dependency` contract: exit 0 + `[WARN] already exists` is a
  success; exit 1 + `/circular dependency/i` maps to `400`.
- The npx-fallback guard (§1e #5): a project registered with `binaryMode:
"core-only-npx"` returns `503` for any legacy-family route, never attempts
  the `cd && npx …` combination.
- Command allowlist rejects anything outside D3's table → 400.
- `taskmaster_unavailable` (503) on stubbed `ENOENT`.
- CSRF/Origin guard on every write route; GET routes Origin-exempt.
- Agent tools: presence, schemas, approval tiers (`tools.test.ts`, mirrors
  the Codex/PM tool coverage) — and that they call the REST routes, never the
  registry file directly (D7).

Plus one real-CLI, real-ssh-to-localhost smoke test (mirrors `test:push`'s
real-Firefox check and the hook-notify real-ssh checks) exercising only the
v1-core, non-AI commands against a disposable scratch project, so CLI drift
is caught without needing network/AI-provider credentials in CI.

---

## 7. Open questions — resolve before/during build (do not guess)

Everything originally listed here as "blocking" was resolved live in §1e.
What remains open, genuinely deferred to when those actions are built (§8):

- **D6's excluded commands** (`tags *` beyond `use`, `research`,
  `analyze-complexity`, `parse-prd`, `remove-task`, subtask commands, `move`)
  each need the same live-verification pass §1e did for the v1 set —
  particularly their success/failure JSON-or-text contract — before they're
  safe to wire as routes or agent tools.
- **Multi-id `show --json`** — `--help` documents comma-separated ids; only a
  single-id call was verified (§1d). Confirm the array/object shape before
  any detail-view route assumes either (§4's route only accepts one
  `:taskId` for now — deliberately not promising bulk).
- **The npx-collision root cause (§1e #5)** was not fully isolated (colliding
  bin name specifically, vs. any `package.json` at cwd) — doesn't block D5's
  design (avoid the combination entirely either way) but would be worth a
  quick follow-up test if the `binaryMode` probe ever needs to be more
  precise than "does `task-master` resolve on `$PATH`."
- **`TASKMASTER_TOOLS` MCP-tier env var** (task-master's own MCP server
  concept, unrelated to this repo's agent tools) is out of scope entirely —
  the Hub talks to the CLI, not to task-master's MCP server; no interaction
  to design here, just noting it so it isn't confused with §4's routes during
  build.

---

## 8. Deliberately deferred (post-v1)

Cross-project dependency view (task-master dependencies are per-project
only, same limitation noted for the PM tool's D6); tag/workstream switching
beyond the single-active-tag model (§1b) — read-only tag list + one confirmed
switch is the v1 ceiling (D12); `research`/`analyze-complexity`/`parse-prd`/
the rest of `tags *` as Hub actions (§7); real-time push (D9); a
"which terminal session is working this task" heuristic (mentioned in the
original brainstorm — needs session cwd ↔ project path matching, deferred
until the core Hub is real); bulk operations (multi-select status change);
a saved per-project view/filter.

---

## Critical files (to be created)

- `apps/terminal-gateway/src/taskmaster.js` — **new** registry sidecar (D1),
  including the `binaryMode` probe (D5).
- `apps/terminal-gateway/src/server.js` — **new** `handleTaskmaster` +
  `TASKMASTER_COMMANDS` table (D3/D4) + `TASKMASTER_COMMAND` resolution (D5).
  Reuses `serverCmd`/`serverCmdStdin` from the fs/codex seam — no new exec
  primitive needed.
- `apps/terminal-gateway/test/taskmaster-endpoints.js` — **new**
  `test:taskmaster`, binary stubbed (§6).
- `packages/shared-types/src/terminal.ts` + `index.ts` — **new**
  `TaskMaster*` block, passthrough-tolerant (§4).
- `apps/agent-service/src/tools.ts`, `gateway-client.ts` — **new**
  `taskmaster_*` tools, REST-client-only (D7).
- `apps/terminal/src/features/terminal/components/taskmaster-hub-dialog.tsx`
  — **new** host modal.
- `apps/terminal/public/taskmaster-hub/app.html` — **new** the artifact.
- `apps/terminal/src/features/terminal/{store.ts,components/terminal-shell.tsx}`
  — flag + button (D10).
