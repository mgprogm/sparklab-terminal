# CLI turn-finished hook notifications — setup and design record

## What this closes

The gateway's existing "job finished" push notification (see
`docs/PUSH-NOTIFICATIONS-PLAN.md`) watches each tmux session's
`pane_current_command` for a shell-transition (non-shell → shell). That's
blind to what happens _inside_ a long interactive CLI session: if you launch
`claude` or `codex` in a gateway-managed terminal and ask it to do a
multi-minute task, the pane's foreground process stays `claude`/`codex` for
the entire session — there's no shell transition between turns, so the
existing poll loop stays silent until you fully quit the tool.

This feature adds a **second, independent signal source** feeding the _same_
push pipeline: Claude Code's `Stop`/`Notification` hooks and Codex's own hook
config invoke a small script (`apps/terminal-gateway/scripts/hook-notify.sh`)
that tells the gateway "this session's current turn just finished" (or "is
waiting on you"). The gateway pushes a normal Web Push via the existing
`push.js`/`sendToAll()` — nothing about VAPID, the subscription store, or the
service worker's `push`/`notificationclick` handlers changes.

## Prerequisites

- Web Push already configured and working (`docs/PUSH-NOTIFICATIONS-PLAN.md`)
  — this feature reuses that pipeline and is a 503 no-op without it.
- `bash`, `curl`, and `tmux` on the machine running `claude`/`codex` (the same
  machine the gateway-managed terminal session lives on — local or a
  registered remote server reached over SSH).
- `jq` is **optional but recommended**: without it the script still works, it
  just can't extract a turn id for idempotency (the gateway's own short
  cooldown still collapses accidental rapid duplicates).
- The `HOOK_NOTIFY_TOKEN` from `apps/terminal-gateway/.env` on the gateway
  host, and the gateway's public origin (e.g. the same `PUBLIC_ORIGIN` the
  browser already uses).

Never paste the token into chat, a command-line argument, or a tracked
project file. Store it in a mode-`600` file outside the checkout, exactly like
the PM MCP token in `docs/PM-MCP-REMOTE-SETUP.md`.

## 1. Generate (or retrieve) the token

```bash
cd apps/terminal-gateway
pnpm generate-hook-token
```

Paste the printed `HOOK_NOTIFY_TOKEN=...` into `apps/terminal-gateway/.env`,
then restart the gateway. This token is **deliberately separate** from
`GATEWAY_API_TOKEN`/`KANBAN_API_TOKEN` — see "Why a dedicated token" below.

## 2. Install the script on each machine running claude/codex

```bash
mkdir -p ~/.local/bin ~/.config/sparklab

curl -fsSL \
  https://raw.githubusercontent.com/mgprogm/sparklab-terminal/main/apps/terminal-gateway/scripts/hook-notify.sh \
  -o ~/.local/bin/sparklab-hook-notify.sh
chmod 755 ~/.local/bin/sparklab-hook-notify.sh
bash -n ~/.local/bin/sparklab-hook-notify.sh   # syntax check
```

(If you're setting this up on the same host as the gateway checkout, you can
just point at the in-repo copy instead of curling it — either is fine, the
script has no dependency on the rest of the repo.)

## 3. Store the connection settings

```bash
install -m 600 /dev/null ~/.config/sparklab/notify.env
```

Edit `~/.config/sparklab/notify.env`:

```bash
HOOK_NOTIFY_TOKEN='PASTE_TOKEN_HERE'
HOOK_NOTIFY_BASE_URL='https://your-gateway-public-origin'
```

`HOOK_NOTIFY_BASE_URL` is the origin only (no trailing `/api/...`).

## 4. Configure Claude Code

Add to `~/.claude/settings.json` (user-level, so it applies to every project)
or a project's own `.claude/settings.json`. **Use the fully-resolved absolute
path — NOT `~`** (replace `/home/YOUR_USER` below): unlike an interactive
shell, Claude Code's hook runner does not reliably expand `~` in a `command`
string, so a literal `~/...` command fails silently (ENOENT) and the hook
simply never fires — this was hit for real during initial rollout and cost a
round of "why isn't this notifying" debugging:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/YOUR_USER/.local/bin/sparklab-hook-notify.sh claude-stop"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "/home/YOUR_USER/.local/bin/sparklab-hook-notify.sh claude-notification"
          }
        ]
      }
    ]
  }
}
```

If you already have hooks configured for `Stop`/`Notification` (e.g. another
tool), **add a new object to the existing array** — do not replace it. Claude
Code runs every matching hook-group for an event, so both coexist.

`Stop` fires once per turn (no matcher support — the script itself is the
gate). `Notification` is filtered to `permission_prompt` only: that's "Claude
is waiting on you," the other notification types (`idle_prompt`,
`auth_success`, …) are out of scope for this feature. The script also
independently checks `notification_type` in the stdin payload, so a
misconfigured/missing matcher degrades to "fires on every notification type"
rather than sending the wrong copy.

## 5. Configure Codex

**Preferred — `hooks.Stop`** (delivers JSON on stdin; does not put message
text on argv). Add to `~/.codex/config.toml` — **TOML does not expand `$HOME`
or `~` in `command` either** (same failure mode as Claude Code above — use the
absolute path, replacing `/home/YOUR_USER`):

```toml
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = '/home/YOUR_USER/.local/bin/sparklab-hook-notify.sh codex-stop'
timeout = 5
```

Codex may rewrite this section on first run, adding a `[hooks.state."<path>"]`
block with a `trusted_hash` and `enabled = true` — that's Codex's own hook
trust/approval bookkeeping (it hashes the command string so a later edit
requires re-approval); leave it in place.

**Legacy fallback — `notify`** (only if your installed Codex version predates
`hooks.Stop`). This delivers the JSON payload as a **final argv argument**,
which means Codex's `input-messages`/`last-assistant-message` fields are
briefly visible to other users on a shared host via `ps`/`/proc` for the
lifetime of that process — a real, documented trade-off (see "Known reduced-
privacy path" below), not something this script can retroactively fix:

```toml
notify = ["/home/YOUR_USER/.local/bin/sparklab-hook-notify.sh", "codex-notify"]
```

Use at most **one** of the two for Codex — don't enable both, or a single
turn fires two notifications.

## 6. Remote-server sessions

This works unchanged for a gateway-managed session on a registered **remote**
server, _as long as that machine has outbound network egress to the
gateway's public HTTPS origin_ — the same one your browser already reaches.
Set `HOOK_NOTIFY_BASE_URL` in that machine's own `~/.config/sparklab/notify.env`
to that public origin (not `127.0.0.1` — the gateway binds loopback-only on
its own host, see `docs/DEPLOYMENT.md`).

**Honest limitation:** if a registered remote server has _no_ general internet
egress (a real, intentional case in this system — the whole point of
SSH+tmux-only Option C in `docs/MULTI-SERVER-PLAN.md` is that nothing beyond
`sshd`+`tmux` is required on the remote), this HTTP-based mechanism is
structurally unusable there. There is currently no fallback for that case —
the existing shell-transition poll loop (which already works over the
gateway's own SSH connection) is the only signal available on a no-egress
remote.

## 7. Verify

```bash
set -a; source ~/.config/sparklab/notify.env; set +a
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HOOK_NOTIFY_TOKEN" \
  -d '{"session":"web-does-not-exist","tool":"claude","kind":"turn-finished"}' \
  "$HOOK_NOTIFY_BASE_URL/api/push/hook-notify"
```

Expect `{"ok":false,"reason":"unknown_session"}` with HTTP `200` — this proves
auth + wiring without needing a real session. `401` means the token is wrong;
a connection error means `HOOK_NOTIFY_BASE_URL` is unreachable.

To test against a real session, open a gateway-managed terminal, note its
session name (the sidebar shows the display name, not the tmux name — use
`tmux ls` on that host to get `web-<uuid>`), then run the same curl with that
name. You should get a push notification and the gateway log should show
`[push] notify {"sessionId":...,"kind":"hook",...}`.

## Why a dedicated token (D1)

`GATEWAY_API_TOKEN`/`KANBAN_API_TOKEN` grant Kanban/PM CRUD and Agentic
run-launch. This hook script lives in a **user/global** CLI config (not a
per-project MCP launcher) and fires on **every turn** — a materially
different, less-trusted exposure than a manually-invoked MCP client. A leak
of `HOOK_NOTIFY_TOKEN` grants exactly one capability: firing a push
notification tagged with a session name you already know. It is checked by
its own predicate (`isHookNotifyAuthorized`) against exactly
`POST /api/push/hook-notify`, never folded into the broader artifact-bearer
allowlist.

## Session resolution (D2) — fail-closed, not "trust the metadata"

The script sends a **bare tmux session name** (`tmux display-message -p -t
"$TMUX_PANE" '#{session_name}'` — targeting the pane explicitly rather than
relying on an ambient attached client, so it resolves correctly even from a
hook subprocess with no tmux client of its own). The gateway does **not**
trust its session-metadata sidecar blindly: dead-session metadata persists
indefinitely by design (see `CLAUDE.md`'s "Dead session persistence" section),
so a stale name could otherwise still resolve. Instead the gateway confirms
**liveness** with one targeted `tmux has-session` check per metadata
candidate and fails closed:

- Zero live matches → `{ok:false, reason:"unknown_session"}`
- More than one live match (only possible with hand-edited metadata; tmux
  names are gateway-generated UUIDs and globally unique in practice) →
  `{ok:false, reason:"ambiguous_session"}`
- Exactly one → resolved, proceeds.

Nested tmux (an inner tmux started inside the gateway pane) or running
outside any gateway session at all both resolve to a session name that
doesn't start with `web-` — the script itself no-ops before ever calling the
gateway.

## Interaction with existing push settings (D3)

A hook-triggered notification **respects** the per-session `muted` flag (the
general "stop bothering me about this session" switch, source-agnostic) but
**ignores** the global `minDurationMs`/`notifyOnStart` settings — those encode
shell-job-_duration_ semantics (suppress short commands, alert on long-running
ones) that actively fight per-turn granularity: a 5-second Claude turn is
exactly the kind of event this feature exists to surface.

## Idempotency and rate limiting (D3, hardened per review)

The gateway extracts a bare turn/prompt id (`eventId`) when `jq` is available
and dedupes repeated calls for the same `(session, tool, kind, eventId)` for
10 minutes — a hook can legitimately double-fire (retries, subagent nesting).
Without an `eventId` (no `jq`, or an older CLI payload shape), a 2-second
same-kind cooldown collapses accidental rapid duplicates instead. Independent
of that, a fixed-window rate limit (20 calls/session/minute) bounds worst-case
push-service-quota abuse from a buggy or malicious hook.

## Known reduced-privacy path — Codex's legacy `notify`

Codex's `notify` mechanism (as opposed to the newer `hooks.Stop`) delivers its
JSON payload as this script's own **final argv argument**. That means fields
like `input-messages`/`last-assistant-message` — real prompt/response text —
are visible to any other user on the same host via `ps`/`/proc/<pid>/cmdline`
for the lifetime of the notify subprocess. This is **not** something the
script can fix after the fact: the exposure happens at process-creation time,
before the script runs at all. The script's own contribution is to never
compound it — it extracts only a bare `turn-id` and never re-reads, logs, or
forwards the message-text fields anywhere. **Prefer `hooks.Stop`** (stdin
delivery) on any Codex version that supports it; treat `notify` as a
last-resort compatibility fallback and mention this trade-off to anyone on a
shared/multi-user host before enabling it.

The gateway route independently only ever emits **fixed template copy**
("Claude finished" / "Codex finished" / "Claude needs input") plus the
session's own **name and org/project** — user-assigned labels already shown in
the sidebar, pulled from the same metadata sidecar that already gates `muted`,
never CLI content — e.g. "Claude finished responding — my-session
(work/backend)." It never echoes any caller-supplied text (`detail`, or
anything from the hook payload) into the push payload itself, regardless of
transport. That closes the _onward_ leak into the encrypted push payload (and
from there, the third-party push service); it does not and cannot close the
argv/`ps` exposure described above.

## Other things the script deliberately does

- Always exits `0` and never writes to stdout, regardless of outcome. A
  Claude `Stop` hook that exits `2` **blocks the stop**; empty stdout + exit
  `0` is the universal "no-op, proceed normally" signal for both Claude and
  Codex hooks. A DNS hiccup or gateway restart must never surface as a hook
  failure or interfere with the CLI's own turn.
- Never puts the bearer token on any process's argv: the `Authorization`
  header is supplied to `curl` via `-K` reading from a process substitution
  (a pipe), not `-H "Authorization: ..."` (which would appear in `ps`).
- Bounded to a 3-second `curl --max-time`, fully silenced (`-o /dev/null`,
  stderr discarded).

## Troubleshooting

- No notification fires: confirm `~/.config/sparklab/notify.env` exists and
  is readable, `HOOK_NOTIFY_TOKEN` matches the gateway's `.env`, and
  `HOOK_NOTIFY_BASE_URL` is reachable from the machine running claude/codex
  (`curl` the verify command in step 7). **Confirm the `command` in
  `settings.json`/`config.toml` is an absolute path, not `~`** — see §4/§5;
  this was the actual root cause the first time this was rolled out (Claude's
  hook silently failed with ENOENT, ~127, while Codex's — already an absolute
  path — worked). Diagnosing it required temporarily instrumenting the
  installed script to log to a side file (stdout is normally suppressed by
  design) and driving a REAL `claude`/`codex` turn end-to-end; piping a fake
  JSON payload directly into the script (as done during initial development)
  proves the gateway route and script logic work, but proves nothing about
  whether the CLI actually invokes the script at all.
- A session's own hook config only takes effect for `claude`/`codex`
  processes started **after** the config file was edited — a long-running
  interactive session that was already open reads hooks once at its own
  startup and will not pick up a change until you exit and relaunch it.
- Fires once then goes quiet: check the per-session `muted` flag in the
  sidebar — hook notifications honor mute like everything else.
- Codex fires twice per turn: both `hooks.Stop` and legacy `notify` are
  configured — remove one (prefer keeping `hooks.Stop`).
- Suspect a leaked token: rotate it (`pnpm generate-hook-token`, update
  `.env` + every machine's `notify.env`, restart the gateway) — it grants
  only the ability to fire a push notification tagged with a session name,
  nothing else.

## Test coverage

`apps/terminal-gateway/test/hook-notify-endpoints.js` (`pnpm --filter
@sparklab/terminal-gateway test:hook-notify`) covers the gateway route against
a real gateway + real tmux sessions: auth, validation, live-session
resolution (unknown / unique / ambiguous), mute suppression, confirming
`minDurationMs`/`notifyOnStart` have no effect on this path, idempotency
dedup, rate limiting, a leak-guard regression (a `detail` field carrying
a fake secret never appears in the emitted push payload), and its positive
counterpart (a session's name/org/project DO appear, proven by a differential
ciphertext-length check between a short- and long-named session). The
`hook-notify.sh` script itself was manually verified end to end during
development (all four modes, notification_type gating, no-config/no-tmux
no-ops, no secret text reaching the gateway log) — it has no automated CI
coverage since it requires a real Claude Code/Codex install to exercise
authentically; that gap is intentional and matches this repo's existing
"needs a real device" category for CLI-specific behavior.
