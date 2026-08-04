#!/usr/bin/env bash
# Claude Code / Codex CLI turn-finished hook -> gateway POST /api/push/hook-notify.
#
# Closes the gap where the gateway's shell-transition poll loop stays silent
# for an entire interactive claude/codex session (see
# docs/HOOK-NOTIFICATIONS-SETUP.md for the full design record and install
# instructions — this file is the mechanism, that doc is the "how to wire it
# up"). This script is invoked BY Claude Code / Codex's own hook machinery; it
# is never run directly by a human.
#
# Usage: hook-notify.sh <mode> [argv-payload]
#   claude-stop          Claude Code Stop hook          (stdin JSON)
#   claude-notification  Claude Code Notification hook  (stdin JSON, gated on
#                         notification_type == permission_prompt)
#   codex-stop           Codex [[hooks.Stop]] (PREFERRED for Codex — stdin
#                         JSON, does not expose message text via argv/ps)
#   codex-notify         Codex legacy `notify` config (LAST-RESORT fallback
#                         for Codex versions without hooks.Stop — the payload
#                         arrives as this script's own $2, which means Codex's
#                         `input-messages`/`last-assistant-message` fields are
#                         already visible to other users on this host via
#                         `ps`/`/proc` for the lifetime of this process. This
#                         script does not make that worse — it never re-reads
#                         those fields or forwards them anywhere — but it
#                         cannot retroactively hide argv. Prefer codex-stop.)
#
# Hard rules this script MUST follow (see docs/HOOK-NOTIFICATIONS-SETUP.md §Security):
#   - ALWAYS exit 0, regardless of outcome. A Claude Stop hook that exits 2
#     BLOCKS the stop; a nonzero exit here must never interfere with the CLI.
#   - NEVER write anything to stdout. Claude Code parses Stop-hook stdout as
#     JSON for decision control; any accidental output could be misread.
#   - NEVER forward last_assistant_message / input-messages / any prompt or
#     response text anywhere (not to curl, not to a log, not to a temp file).
#     We only ever extract a bare turn/prompt id for idempotency.
#   - NEVER put the bearer token on any process's argv (curl's -K config-file
#     mode is used instead of `-H "Authorization: ..."`, which would appear in
#     `ps`).
set -u
umask 077

main() {
  local mode="${1:-}"

  local config="${SPARKLAB_HOOK_NOTIFY_CONFIG:-$HOME/.config/sparklab/notify.env}"
  [ -r "$config" ] || return 0
  # shellcheck disable=SC1090
  . "$config"
  [ -n "${HOOK_NOTIFY_TOKEN:-}" ] || return 0
  [ -n "${HOOK_NOTIFY_BASE_URL:-}" ] || return 0

  local tool kind payload=""
  case "$mode" in
    claude-stop) tool=claude; kind=turn-finished; payload="$(timeout 2 cat)" ;;
    claude-notification)
      tool=claude; kind=waiting-input; payload="$(timeout 2 cat)"
      if command -v jq >/dev/null 2>&1; then
        local ntype
        ntype="$(jq -r '.notification_type // empty' <<<"$payload" 2>/dev/null)"
        [ "$ntype" = "permission_prompt" ] || return 0
      fi
      ;;
    codex-stop) tool=codex; kind=turn-finished; payload="$(timeout 2 cat)" ;;
    codex-notify) tool=codex; kind=turn-finished; payload="${2:-}" ;;
    *) return 0 ;;
  esac
  [ -n "$payload" ] || return 0

  # Extract ONLY a bare id (turn_id / prompt_id / turn-id) for idempotency —
  # never any message-text field. jq is optional: absent => no eventId, the
  # gateway's own short cooldown still collapses accidental rapid duplicates.
  local event_id=""
  if command -v jq >/dev/null 2>&1; then
    event_id="$(jq -r '.turn_id // ."turn-id" // .prompt_id // empty' <<<"$payload" 2>/dev/null)"
    # Belt-and-suspenders charset clamp — never let anything but a plain
    # token-like id reach the outbound JSON we build by hand below.
    event_id="$(printf '%s' "$event_id" | tr -cd 'A-Za-z0-9_.-')"
  fi

  # Resolve the CURRENT gateway-managed tmux session by name. -t "$TMUX_PANE"
  # targets the pane explicitly rather than relying on an ambient attached
  # client, which also makes this correct when invoked from a hook subprocess.
  # Nested tmux (an inner tmux session started inside the gateway pane) or
  # "not running inside any gateway session at all" both resolve to a session
  # name that doesn't start with "web-" -> silent no-op, by design.
  [ -n "${TMUX_PANE:-}" ] || return 0
  local sess
  sess="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)" || return 0
  case "$sess" in
    web-*) ;;
    *) return 0 ;;
  esac

  local json
  if [ -n "$event_id" ]; then
    json=$(printf '{"session":"%s","tool":"%s","kind":"%s","eventId":"%s"}' \
      "$sess" "$tool" "$kind" "$event_id")
  else
    json=$(printf '{"session":"%s","tool":"%s","kind":"%s"}' "$sess" "$tool" "$kind")
  fi

  # -K reads the Authorization header from a process substitution (a pipe,
  # never a file on disk) so the bearer token never appears on curl's own
  # argv/ps. Bounded to 3s and fully silenced — a DNS hiccup or gateway
  # restart must never surface as a hook failure.
  curl -s -o /dev/null --max-time 3 \
    -X POST \
    -H "Content-Type: application/json" \
    --data-binary "$json" \
    -K <(printf 'header = "Authorization: Bearer %s"\n' "$HOOK_NOTIFY_TOKEN") \
    "${HOOK_NOTIFY_BASE_URL%/}/api/push/hook-notify" \
    >/dev/null 2>&1
  return 0
}

main "$@" >/dev/null 2>&1
exit 0
