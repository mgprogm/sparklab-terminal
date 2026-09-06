# Task Master Hub — port-preparation prompt template

A reusable prompt to hand an agent (Claude Code / Codex CLI / OpenCode / Pi)
working **inside a different project**, so it prepares that project to host a
Task Master Hub feature — a pluggable dashboard + coordination layer over one
or more `claude-task-master` projects.

## How to use

1. Make the source repo's docs reachable to the agent (clone it beside the
   target project, or paste the four docs named below).
2. Fill the `«PLACEHOLDERS»` in the template.
3. Paste it as the first message. The agent produces a
   `docs/TASKMASTER-HUB-PORT-PLAN.md` **gap analysis** — it does not write
   feature code on this pass.
4. Review that plan, then tell it to implement phase by phase.

---

## Template

```
You are preparing THIS project to host a "Task Master Hub" feature: a
gateway-owned dashboard + agent-coordination layer over one or more
`claude-task-master` projects, shipped as a self-contained HTML artifact in a
sandboxed iframe. It is already built in a reference repo — your job on this
pass is a GAP ANALYSIS and a PORT PLAN for this project, not feature code.

## Reference (read fully before doing anything)
- «SOURCE_REPO»/docs/TASKMASTER-HUB-PLAN.md  — design record + the §1e live
  CLI-compatibility spike (the load-bearing findings; re-verify them here).
- «SOURCE_REPO»/docs/TASKMASTER-HUB-OPERATIONS.md — the runtime claim protocol
  and "Multiple agent tools on one backlog".
- «SOURCE_REPO»/docs/TASKMASTER-AGENT-SETUP.md — per-CLI MCP-vs-REST access.
- «SOURCE_REPO»/docs/TASKMASTER-HUB-PHASE-C-PLAN.md — the credential-to-owner
  (`ownerChannel`) binding on the execution store.
Also skim any `TASKMASTER-HUB-*` files not listed.

## Context for this project
- Gateway / backend service: «GATEWAY_PATH_OR_"discover it"»
- Frontend app: «FRONTEND_PATH_OR_"discover it"»
- Agent/tool-loop service, if any: «AGENT_SERVICE_PATH_OR_"none"»
- Auth model: «single-user cookie | multi-user | none»
- Want the `taskmaster_*` agent tools too? «yes | no»
- Target servers where `.taskmaster/` projects live: «local only | local + SSH remotes»

## Step 1 — infra inventory (have / missing / partial, with a rough size)
Check whether this project already provides each capability the Hub depends on:
1. A backend service with REST routing, session/cookie auth, a scoped-bearer
   token path, and an Origin/CSRF guard on state-changing routes.
2. A seam to run a shell command with an explicit working directory, locally
   AND (if remotes are in scope) over SSH — Hub runs the real `task-master`
   CLI through it.
3. A sidecar JSON store pattern: atomic write (tmp + rename), synchronous
   mutators so no mutex is needed, an optimistic `rev` for concurrent edits.
4. A server registry (only if remote servers are in scope) → qualified
   project ids.
5. A "pluggable artifact" host: a sandboxed `<iframe>` modal
   (`allow-scripts allow-same-origin allow-forms allow-modals`), a UI store
   slice, a `?flag` URL param, and a header button — mirroring how this
   project embeds any other self-contained HTML tool.
6. A typed-schema package (Zod or equivalent) for request/response shapes.
7. (only if agent tools are wanted) a tool-calling loop with a gateway client
   and an approval-tier convention.
For every "missing", note it as a prerequisite with an estimate — some of
these are larger than the Hub itself.

## Step 2 — run the CLI-compatibility spike IN THIS ENVIRONMENT
Do not trust the reference repo's findings blind; re-verify against the
`task-master` version and Node/npm on this host. Record actual output for:
- `npx -p task-master-ai@latest task-master --version` (the `task-master-ai`
  bin is the MCP server, not the CLI — confirm the `-p … task-master` form).
- A core-family call with `--project <abs path>` + JSON output
  (`list` / `show` / `next` / `set-status`) — confirm it is cwd-independent.
- A legacy-family call (`add-task` / `expand` / `tags`) — confirm it has NO
  `--project`, NO JSON, and needs the real process cwd; confirm `--file
  <abs path>` does NOT make it cwd-independent.
- `cd <a project whose package.json declares a "task-master" bin> && npx -p
  task-master-ai@<ver> task-master …` — confirm it breaks (needs a real
  installed binary for legacy routes).
- `--tag` support on `show` / `set-status` (likely ignored → plan
  "current-tag-only" for v1).
- Whether a cold `npx` needs `--no-audit` to avoid an npm metavuln timeout.
- Confirm `success` / exit code alone is not trustworthy — a failing
  `set-status --format json` can print `{"success":true,…}` on stdout while
  exiting non-zero. Judge by exit code AND the response actually containing
  the requested change.

## Step 3 — write docs/TASKMASTER-HUB-PORT-PLAN.md
Include:
- The Step 1 inventory (have / missing / partial + estimates).
- The Step 2 findings, verbatim commands + observed output.
- A file-by-file port map from the reference repo to THIS project's layout:
  the registry store, the execution/claim store (with `ownerChannel`), the
  `/api/taskmaster/*` route family, the `cwd`-aware exec seam extension, the
  typed schemas, the `public/taskmaster-hub/app.html` artifact + its iframe
  host + store slice + URL flag + header button, and (if in scope) the
  `taskmaster_*` agent tools + gateway-client methods.
- Env vars: bearer token, `TASKMASTER_COMMAND` binary override, claim TTL,
  the two data-file path overrides.
- Decisions to make for THIS project: auth model vs. the `ownerChannel`
  bearer↔cookie separation; current-tag-only vs. multi-tag; with/without the
  agent tools.
- A phased build order (backend + stores + routes → tests with a stub binary
  → frontend artifact → agent tools), each phase independently verifiable.
- A test approach: a stub `task-master` binary via `TASKMASTER_COMMAND`
  emulating the exact contracts from Step 2, plus one live run against a real
  seeded `.taskmaster/` project.

## Constraints (carry into the plan)
- The gateway/backend is the single enforcement point — every path flows as
  one argv token, never string-concatenated; the CLI is never invoked another
  way.
- Never hand-edit `.taskmaster/tasks/tasks.json` — only the `task-master` CLI
  or the Hub's own API.
- The artifact is self-contained: no bundler, no external requests, palette
  hardcoded from this project's design tokens.
- Execution/claim state is sidecar metadata, never Task Master task content.

Produce the plan file, then stop and wait for review.
```

---

## Notes

- The template deliberately forbids feature code on the first pass — the
  reference build's own history shows the CLI spike changed the design
  (`--file` not being cwd-independent, npx/bin collisions), so a blind port
  would bake in wrong assumptions.
- If the target project has none of the Step 1 infra, the honest output is
  "the prerequisites are a bigger project than the Hub" — that is a useful
  result, not a failure.
- For an MCP-less agent (Pi, `codex exec`) the same template applies; it just
  can't use `task-master` via MCP during its own spike — it runs the CLI
  directly, which is what the Hub does anyway.
