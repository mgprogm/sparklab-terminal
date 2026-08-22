# Autonomous Terminal Monitors

## Status

Implemented v1. A monitor is a persisted deterministic terminal automation,
not an unattended LLM loop.

## Capability

`start_autonomous_terminal_monitor` observes one terminal session at a bounded
interval. When the exact approved trigger text appears on screen, it performs
one exact approved action: literal text, named keys, or a literal command
(typed then `Enter`). It stops after its execution budget or expiry.

## Safety boundary

- Creation is a one-time-approved Agent Chat write. The approval summarizes the
  trigger and action; the user must explicitly request both.
- The monitor engine is deterministic. It never asks a model to interpret
  screen output, generate a command, or expand a template at execution time.
- Trigger text and text/command actions are AES-256-GCM encrypted using
  `SCHEDULED_TERMINAL_ACTIONS_KEY`; list responses never reveal them.
- Intervals are 60 seconds to one hour, expiry is bounded to one year, and a
  monitor may execute one to 100 times. A missing session, bad encryption key,
  or execution failure records an error and does not create a replacement action.
- Stop/cancel works only while a monitor is active. A claimed execution is not
  replayed after a crash, preferring a lost action over duplicate terminal input.

## Gateway API

`POST /api/terminal-monitors` accepts a session, encrypted trigger/action
payload, interval, expiry, and execution budget. `GET` lists safe metadata;
`DELETE /api/terminal-monitors/:id` stops an active monitor.

## Agent Chat test prompts

Use a known session ID in place of `2b2-01`. Start with a screen-reading
prompt so the operator can confirm that the intended session and trigger text
are present:

```text
Read the screen and the latest 50 history lines of terminal session 2b2-01.
```

Create a single-use text action with a literal screen trigger:

```text
Monitor terminal session 2b2-01 every 60 seconds. If the exact text
"Build complete" appears, type "continue" and press Enter once. Expire this
monitor in 30 minutes.
```

The following prompts cover the supported action types and lifecycle:

```text
Monitor terminal session 2b2-01 every 2 minutes. If the exact text
"migration required" appears, run the literal command "pnpm db:migrate" once.
Expire this monitor in one hour.
```

```text
Monitor terminal session 2b2-01 every 1 minute. If the exact text
"Press Enter to continue" appears, press Enter at most 3 times. Expire this
monitor in 20 minutes.
```

```text
List the autonomous terminal monitors currently configured.
```

```text
Stop autonomous terminal monitor <monitor_id>.
```

Each creation must request approval. Confirm that the approval describes the
same session, literal trigger, literal action, interval, expiry, and execution
limit as the prompt. The agent must not create an action whose command or text
is derived from terminal output.
