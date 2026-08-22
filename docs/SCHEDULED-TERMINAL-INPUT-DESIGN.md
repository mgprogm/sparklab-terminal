# Scheduled Terminal Input Design

## Status

Implemented. This design extends the existing one-shot scheduled named-key
actions with explicitly approved delayed literal text followed by named keys.

## Problem

The original scheduler could safely defer `Enter`, but could not defer the
literal input needed for an interactive prompt such as `continue` followed by
`Enter`. Users otherwise had to type the text manually before scheduling a key
press, which is fragile and does not survive a changed prompt.

## Decision

Add a distinct `input` action rather than broadening the existing keys action:

```json
{
  "kind": "input",
  "sessionId": "local/web-...",
  "text": "continue",
  "keys": ["Enter"],
  "executeAt": "2026-08-22T22:30:00+07:00"
}
```

`schedule_terminal_input` is a separate Agent Chat write tool. It requires a
fresh one-time approval even if another action was previously allowed. Its
approval card shows the exact text, keys, target session, and execution time.

## Security model

This is intentionally a delayed input/command capability, not a convenience
alias for delayed keys. The safeguards are:

- The user must explicitly request the exact text, target session, keys, and
  timezone-qualified time. The model must not derive future input from terminal
  output or templates.
- Text is one literal line, capped at 4096 characters. No shell interpolation,
  command construction, multiline paste, or dynamic expansion is performed.
- Keys remain restricted to the existing 1–32 item named-key allowlist.
- The gateway stores text only as AES-256-GCM ciphertext. The encryption key is
  `SCHEDULED_TERMINAL_ACTIONS_KEY`, a stable base64 32-byte secret owned by the
  gateway. `GET /api/terminal-actions` returns `hasText: true`, never text or
  ciphertext. Agent Chat's durable history omits the text as well.
- If the key is missing, creating input actions fails with `503`; ordinary
  keys-only actions keep working. If the key is unavailable or changed when an
  action is due, it fails closed rather than sending partial input.
- Actions are claimed durably before sending. A gateway crash therefore loses a
  pending occurrence rather than replaying possibly consequential input.

The key must be present on every gateway that reads the same action store and
must not be rotated while encrypted actions are pending. Generate it once with:

```bash
openssl rand -base64 32
```

## Execution and lifecycle

At the scheduled instant the gateway rechecks that the session exists, decrypts
the text, types it literally, then sends the approved named keys in order. It
records `executed` or `failed`; users may list or cancel only an action still in
`scheduled` state. Remote terminal sessions work through the same gateway SSH
execution seam, but the ciphertext and key remain on the gateway host.

## Verification

`apps/terminal-gateway/test/agent-endpoints.js` proves an input action fires
once, types text before `Enter`, does not expose plaintext via the list/create
response, and never writes plaintext into the action store. Agent-service tests
prove the tool is one-time approval-gated and that scheduled text is omitted
from durable chat history.
