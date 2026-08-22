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
