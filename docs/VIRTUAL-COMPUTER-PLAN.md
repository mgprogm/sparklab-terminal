# Virtual Computer Tool Plan

## Status

Original design/phasing pass (2026-08-30). **Superseded** — the authoritative
records are now [`VIRTUAL-COMPUTER.md`](./VIRTUAL-COMPUTER.md) (locked v1
decisions D1–D5) and
[`VIRTUAL-COMPUTER-REMAINING.md`](./VIRTUAL-COMPUTER-REMAINING.md) (the M1–M3
plan). The v1 runtime **shipped** on branch `feat/virtual-computer-cua-spike`
(`computer-runtime.ts`, `computer_observe` / `computer_act` gated on
`CUA_ENABLED`, the `computer_view` / `computer_closed` frames, the
`features/computer-view/` overlay), verified end to end against a real
`cua-driver` 0.22.2 desktop; it is inert unless `CUA_ENABLED=true`. Where this
document and `VIRTUAL-COMPUTER.md` disagree, `VIRTUAL-COMPUTER.md` wins.

Decision record for wiring **CUA** (`trycua/cua`, checkout at
`/home/sparklab/workspaces/sparklab/cua`) into the SP agent
(`apps/agent-service`) as a desktop-control skill, mirroring the Virtual
Browser integration (`docs/VIRTUAL-BROWSER-PLAN.md`, `docs/VIRTUAL-BROWSER.md`).

CUA becomes to the desktop what Browser Use is to the browser: a per-chat,
lazily started, isolated child the agent drives through a small approval-gated
tool surface, with a read-only revisioned screenshot overlay above xterm.

Tool names, the action-result contract, and Linux delivery limits below are
taken from the checkout, not extrapolated:
`libs/cua-driver/docs/action-icon-catalog.md` (public MCP tool union),
`libs/cua-driver/docs/action-result-contract.md` (driver 0.15 `ActionResult`),
`libs/cua-driver/docs/action-support.md` (per-platform empirical ledger),
`libs/cua-driver/rust/Skills/cua-driver/LINUX.md` (X11 delivery model),
`libs/xfce-cua/` and `libs/xfce/` (the desktop container images).

## Goal

Give the terminal agent a safe desktop-control skill (observe, click, type,
key, scroll, drag) against a disposable Linux desktop, and show that desktop
inside the terminal application. Users direct desktop work through Agent Chat.
The view is read-only; every consequential action needs one-time approval.
Desktop state never leaks across chats or into history.

Non-goals for v1: macOS/Windows targets, arbitrary in-desktop shell, file
upload/download into the desktop, persistent desktops, multiple desktops per
chat, `verify_state` postconditions, recording/replay.

## Why this fits the existing seam

`cua-driver mcp` **speaks MCP over stdio** — the same shape as
`uv run browser-use --mcp`. These parts of `apps/agent-service` are reused
almost verbatim:

- `browser-runtime.ts` — per-loop stdio MCP subprocess, bounded messages, lazy
  start, cancellation, group-kill teardown, `browser-performance-metrics.ts`
  counters.
- `browser-state.ts` — bounded model-facing state.
- `agent-loop.ts` / `tools.ts` / `approvals.ts` — restricted tool surface,
  one-time approval coercion (`ONE_TIME_TOOLS`), typed-text redaction, no
  persistent approval.
- `features/browser-view/` — ephemeral revisioned overlay with close tombstones.
- `features/browser-handoff/` — JPEG-streamed interactive control + exclusive
  lease (Phase 3 only).

## Architecture

Fifth independent lifetime. Never touches tmux, the gateway pty, or the terminal
byte pipeline. It is a gateway REST client for exactly one seam: `fs/upload`
(Phase 2 capture). Everything else lives in `apps/agent-service`; the gateway
stays plain-JS and untouched.

```text
agent-loop.ts
  └─ computer-runtime.ts                 NEW: one lazy CUA child per AgentLoop
       └─ per-chat desktop container      docker run -d, own network namespace
            ├─ Xvnc + XFCE (xfwm4) + supervisor   (from the image)
            └─ cua-driver mcp --direct    stdio, reached via `docker exec -i`
       egress: container network is the boundary (see Safety Model)

  computer_view / computer_closed frames → features/computer-view/ overlay
```

### Backend: `cua-driver mcp --direct`, co-located with the desktop, in a container

`cua-driver mcp` is **stdio** and must run in the same namespace as the desktop
it drives (`--direct` = the MCP process owns its runtime, no daemon). The
container's own `cua-computer-server` on `127.0.0.1:8000` is a _different_
protocol and is not used here; the driver is reached over stdio via
`docker exec -i cua_<chatId> cua-driver mcp --direct`, so the existing MCP stdio
client is reused unchanged apart from the spawn argv.

**The desktop image already provides a version-matched driver + real X server.**
`trycua/xfce-cua:latest` (application-neutral) / `trycua/cua-xfce:latest` bundle
`cua-driver` (version pinned in `libs/xfce/requirements-cua-driver.txt`), Xvnc,
XFCE, and supervisor. Either pull the tag or `docker build` it once from
`libs/xfce-cua/`. So P0 needs **near-zero desktop code** — `docker run` the
image, `docker exec` the driver.

`Xvnc` (a real X server with a framebuffer) is materially better than a bare
host `Xvfb :N`: `action-support.md` notes Xvfb "does not prove the real-Xorg
MPX/uinput background pointer route", so a host-Xvfb shape would under-exercise
exactly the delivery path CUA is special for.

Optional **host fallback** (`CUA_MODE=host-xvfb`): `Xvfb :N` + Openbox +
`cua-driver mcp --direct` as a direct child, for a machine without Docker. It is
dev-only and **offline-only** — it has no egress containment (see Safety Model)
and does not exercise the real X11 background route. Not the default, not for
any shared/hosted deployment.

### Linux X11 delivery model (what the agent actually gets)

From `LINUX.md` + `action-support.md`:

- Background delivery **does** work on X11: AT-SPI `do_action` for
  element-addressed clicks (focus-free, toolkit-native), `XSendEvent` for
  pixel clicks into a resolved target window, XInput2 MPX for the pointer.
  `type_text` lands focus-free in an editable widget via AT-SPI EditableText.
- `delivery_mode: "background"` is the default and the right one. `foreground`
  activates the target window (visible takeover) and **must never be
  auto-selected** — return the refusal instead.
- `move_cursor({scope:"desktop"})` is the only call that warps the real
  pointer. **Not used by this integration.**
- Some toolkit/action combinations return an exact `background_unavailable`
  refusal (e.g. GTK dialog buttons, non-editable focus for typing). The agent
  surfaces the refusal; it does not escalate to `foreground` on its own.
- Preferred targeting is therefore **element index from the latest observation**
  (like `browser_act`), with window+pixel as the fallback — not screen-absolute
  desktop-scope coordinates.

### Driver permission mode (second enforcement layer)

Launch with `CUA_DRIVER_PERMISSION_MODE=bounded` and a checked-in capability
manifest (`CUA_CAPABILITY_MANIFEST_FILE`, `CUA_CAPABILITY_MANIFEST_APPROVED=1`)
admitting only:

```text
get_desktop_state, get_window_state, get_screen_size, get_accessibility_tree,
list_apps, list_windows, get_cursor_position,
click, double_click, right_click, drag, scroll,
type_text, press_key, hotkey
```

Everything else — `launch_app`, `kill_app`, `bring_to_front`, `set_value`,
`page`/`browser_*`, recording, config writes, `move_cursor` desktop scope,
Linux low-level `mouse_button_down`/`mouse_drag`/`parallel_mouse_drag` — is
denied below the agent gate. `unrestricted` /
`--dangerously-bypass-approvals` is never used.

## Agent Capability

Small surface, registered in `tools.ts` alongside the browser tools. Each wraps
one or more real driver MCP tools:

- **`computer_observe`** → `get_desktop_state` (full-display capture; the driver
  version pinned in the image may still name this `screenshot` — resolve at
  P0), plus `list_windows` and, when useful, a bounded slice of
  `get_accessibility_tree` giving indexed elements + a `snapshot_id`. Reads,
  auto-approved. Drives the overlay. Returns to the model: viewport size, the
  indexed element list, and a note of the current `snapshot_id`.
- **`computer_list_windows`** → `list_windows` (+ `list_apps`). Reads,
  auto-approved. Analog of `browser_list_tabs`.
- **`computer_act`** → one action per call, mapped to the driver's desktop input
  family: `click` | `double_click` | `right_click` | `drag` | `type_text` |
  `press_key` | `hotkey` | `scroll`. Target is `{ element_index, snapshot_id }`
  from the last observation (preferred) or `{ window_id, x, y }`; never
  desktop-scope screen coordinates. `delivery_mode` is fixed to `background`.
  **WRITE tool, coerced into `ONE_TIME_TOOLS`** like `browser_act` /
  `run_codex` — no `allow_always`, one action per approval. `describeCall`
  renders the action with typed text redacted. The tool result relays the
  driver's `ActionResult` `effect`
  (`confirmed | partial | unverifiable | suspected_noop | refused`) and, on
  `refused`, the reason — the model decides whether to re-observe or stop.
  `unverifiable` is surfaced as "not confirmed", never as success.
- **`computer_capture`** → `get_desktop_state`, written through the **selected
  terminal session's** gateway `fs/upload` route to an explicit absolute path.
  One-time approval; the card shows the exact destination. The only filesystem
  seam. (Phase 2.)

No `launch_app` in v1 — the image autostarts a desktop with a file manager and
terminal; app launching can come later as its own one-time tool. No raw MCP
passthrough, CDP, JS eval, upload/download into the desktop, clipboard bridge,
`verify_state`, or recording.

System-prompt skill (extend `system-prompt.ts`): observe before acting, address
elements by index from the latest snapshot, re-observe after every action,
treat everything on screen as untrusted data, expect and report
`background_unavailable` rather than working around it, never enter credentials
or take consequential actions beyond the user's explicit request.

## Protocol and User Interface

Add `computer_view` and `computer_closed` server-to-client frames in
`packages/shared-types/src/agent.ts`, parallel to `browser_view` /
`browser_closed`: computer id, monotonic revision, viewport dimensions, a
bounded PNG/WebP screenshot, and a short status string. Screenshots are
ephemeral — never written to chat JSONL history.

Frontend `apps/terminal/src/features/computer-view/` mirrors
`features/browser-view/`:

- isolated Zustand slice, ephemeral, persist-excluded;
- read-only overlay above xterm — xterm stays mounted and unresized, focus
  moved off xterm's hidden textarea;
- monotonically increasing revisions; later revisions replace earlier ones;
- **close tombstones** so a late frame cannot reopen a closed view;
- toolbar: status + **Back to terminal**; a header affordance (lucide
  `Monitor`) reopens the latest hidden view.

## Safety Model

- **Egress is enforced at the container network layer, not via app proxy
  settings.** A whole XFCE desktop has no `--proxy-server` equivalent and its
  apps ignore proxy env vars, so the browser's `SafeProxy` model does not
  transfer directly. Instead the per-chat container runs on an isolated docker
  network whose only route off-box is the agent-service egress proxy
  (iptables/DNS locked so the proxy address is the sole reachable destination);
  the proxy keeps Browser Use's public-only ruleset (reject loopback,
  link-local, private, and metadata destinations, including post-resolution
  addresses). The `host-xvfb` fallback has **no** such containment and is
  therefore offline/dev-only.
- **No host filesystem exposure.** No bind mounts. No `--privileged`. Drop
  capabilities; read-only rootfs where the image allows.
- **Screenshots and desktop/AX state are ephemeral in chat.** Never persist
  image bytes, element trees, or the `computer_capture` saved-path result.
- **Persisted tool history** redacts typed text and strips URL-like strings via
  the existing browser sanitizer path.
- **Approval:** `computer_act` and `computer_capture` require a visible
  one-time approval every call; `allow_always` disabled for both.
- **Driver `bounded` mode** with the manifest above is the independent second
  layer. `foreground` delivery and real-pointer warp are structurally
  unreachable.
- **Bounds:** screenshot dimensions, MCP message size, action duration, AX-tree
  slice size, and actions per turn are capped (reuse browser bounds constants).
- **Teardown is mandatory and total.** Stop, WebSocket disposal, and service
  shutdown kill the driver `docker exec` process, `docker rm -f` the container,
  and remove any temp state. No orphan process or container — verified by test.

## Decisions

- **D1 — Backend = `cua-driver mcp` over stdio, not `cua-computer-server`.**
  Reuses the existing stdio MCP client wholesale; background delivery on X11;
  element targeting. `cua-computer-server` (port 8000) would be a new protocol
  client for marginal gain.
- **D2 — v1 desktop = per-chat Docker container from the CUA desktop image
  (`trycua/xfce-cua` / `trycua/cua-xfce`), driver reached via
  `docker exec -i`.** _(Reversed from the first draft, which had host-Xvfb as
  v1.)_ The image ships a version-matched driver + a real X server (Xvnc) + a
  full desktop, so P0 needs almost no desktop code, gets namespace/FS
  isolation and a real network boundary from day one, and exercises the real
  X11 background route that bare Xvfb does not. Host-Xvfb survives only as an
  offline dev fallback (`CUA_MODE=host-xvfb`).
- **D3 — Fresh, disposable desktop per chat.** The agent never gets the
  operator's real session or a machine that also hosts terminal sessions.
  Matches Browser Use's always-isolated model.
- **D4 — No arbitrary in-desktop shell and no `launch_app` in v1.**
  `computer_observe` + `computer_act` + `computer_capture` proves the feature
  with minimal blast radius. `launch_app` / `computer_run` can follow as their
  own one-time tools.
- **D5 — `computer_act` is one-time approval, never `allow_always`.** Add it to
  the exported `ONE_TIME_TOOLS` set in `tools.ts`. Identical to `browser_act`.
- **D6 — Driver launched in `bounded` permission mode** with the checked-in
  capability manifest listed above. `foreground` delivery and `move_cursor`
  desktop scope are unreachable.
  _(**Superseded by the spike — see VIRTUAL-COMPUTER.md**: v1 ships `standard`
  permission mode by default; `bounded` + a checked-in manifest is M2 follow-up
  work.)_
- **D7 — `delivery_mode` fixed to `background`; element-index targeting
  preferred over pixel; screen-absolute desktop-scope coordinates never used.**
  Follows `LINUX.md`. `background_unavailable` is surfaced, not worked around.
  _(**Superseded by the spike — see VIRTUAL-COMPUTER.md**: `background` delivery
  holds, but v1 has **no** element targeting — screen-absolute desktop-scope
  x,y is the only path; per-window element indexing is M3.1.)_
- **D8 — Linux-only v1.** macOS needs `CuaDriver.app` for TCC attribution;
  deferred with Lume. Windows deferred.
- **D9 — Egress enforced at the container network layer** (isolated docker
  network, proxy is the only route off-box), not via app proxy env. The
  host-xvfb fallback is offline/dev-only because it cannot provide this.
- **D10 — Handoff ("Take control") is a later phase.** _(Superseded by
  `VIRTUAL-COMPUTER.md` D4: it gets a dedicated `/computer-handoff` WebSocket and
  its own frontend feature, a sibling of `features/browser-handoff/`, rather
  than a `target: "browser" | "computer"` parameter on the existing browser
  handoff protocol. Shared helpers may be extracted afterward, not generalized
  up front.)_ Read `docs/BROWSER-HANDOFF-DESIGN.md` +
  `docs/BROWSER-HANDOFF-OPERATIONS.md` first. The container's Xvnc is the
  natural frame source.
- **D11 — Config in `apps/agent-service/.env`, gated by `CUA_ENABLED`** (mirrors
  browser tools gated by `BROWSER_USE_PROJECT`). Keys: `CUA_ENABLED`,
  `CUA_MODE=container|host-xvfb`, `CUA_IMAGE` (default `trycua/xfce-cua:latest`),
  `CUA_DRIVER_BIN` (host-xvfb only; absolute path from `command -v cua-driver`),
  `CUA_DRIVER_PERMISSION_MODE=bounded`, `CUA_CAPABILITY_MANIFEST_FILE`,
  `CUA_EGRESS_PROXY`, `CUA_VNC` (container only, for Phase 3).

## Implementation Phases

1. **P0 — Runtime + read-only observe/act (container).**
   `computer-runtime.ts`: per-`AgentLoop` lazy `docker run -d` of `CUA_IMAGE` on
   an isolated network; first `computer_*` call spawns
   `docker exec -i <c> cua-driver mcp --direct` (bounded mode) and does the MCP
   handshake; structured tool calls; cancellation; `docker rm -f` + exec-kill
   cleanup; `/health` counters (no labels/coords/image bodies, mirroring
   `browser-performance-metrics.ts`). Resolve the pinned driver's capture tool
   name (`get_desktop_state` vs legacy `screenshot`) and AX-tree shape against
   the actual image. Register `computer_observe` + `computer_act`
   (click/type_text/press_key/scroll, element-index targeting) in `tools.ts`
   with one-time approval + summaries + system-prompt skill. Add `computer_view`
   / `computer_closed` shared schemas. Frontend `features/computer-view/`
   overlay. Isolated docker network + egress proxy wired.
2. **P1 — `computer_list_windows`, `drag`/`double_click`/`right_click`/`hotkey`,
   hardening.** Tool-history redaction via the browser sanitizer. Bounds
   constants. `ActionResult` `effect` relayed to the model; `unverifiable`
   shown as not-confirmed. Cap-drop / read-only-rootfs container flags.
   Deterministic teardown test (no orphan container/process).
3. **P2 — `computer_capture`.** Bounded `get_desktop_state` → selected session's
   gateway `fs/upload`, one-time approval with exact destination,
   overwrite-in-place, parent-dir-must-exist. Never persisted in chat.
4. **P3 — Handoff ("Take control").** Generalise `/browser-handoff` to
   `target: "computer"`: bounded JPEG stream sourced from the container's Xvnc,
   exclusive agent/human control lease, frontend feature reuse. Follow the
   handoff design + operations docs.
5. **P4 — CUA cloud / Lume.** `CUA_MODE=cloud-sandbox` via the `cua` Sandbox
   SDK / `cua-computer` client (server-side session mgmt, billing-aware
   cleanup, no local compute); later a Lume/macOS target.
6. **Verification (every phase).** Deterministic unit/contract tests for the
   runtime lifecycle and schemas; a teardown test proving no orphan
   process/container survives Stop/disconnect/shutdown; then repo-wide lint,
   typecheck, test, build. An end-to-end smoke needs Docker + the pulled/built
   image on the runner.

## Acceptance Criteria

- The agent can observe an isolated Linux desktop and perform
  click/type/key/scroll via `cua-driver` element-index targeting with
  `delivery_mode: background`.
- Every `computer_act` and `computer_capture` shows a visible one-time
  approval; no persistent approval path exists.
- The latest desktop screenshot renders as a read-only overlay above xterm
  without unmounting, resizing, or stealing focus from the terminal.
- Interrupting or disconnecting a chat reliably terminates the owned driver
  exec and destroys the container, with no orphans.
- The container's only network route off-box is the egress proxy; private and
  metadata destinations are rejected.
- Desktop state, screenshots, AX trees, and typed text do not leak across chats
  or into chat history.
- Invalid, private, oversized, stale, or malformed computer frames/actions are
  rejected. `unverifiable`/`refused` driver results are never reported as
  success.
- The gateway is unchanged; tmux and the terminal byte pipeline are untouched.

## Open Questions

- Is `trycua/xfce-cua:latest` published to a registry, or must P0 `docker build`
  it from `libs/xfce-cua/`? (One-time cost either way; determines a setup step.)
- Image size / cold-start time for per-chat `docker run` — if the KiCad-based
  `libs/xfce` image is too heavy, build a slim `Xvfb`/Openbox + driver image
  under `deploy/`.
- Exact capture tool name and AX-tree JSON shape for the driver version pinned
  in `libs/xfce/requirements-cua-driver.txt` (0.15 catalog says
  `get_desktop_state`; older `LINUX.md` still says `screenshot`) — pin at P0.
- AX-tree fidelity from GTK/Qt apps under Xvnc, and how large a slice to send
  the model — measure at P0, size `computer-state.ts` bounds accordingly.
- Whether to route the isolated docker network's egress through the _same_
  proxy process Browser Use uses or a second instance — one process is simpler
  if it can bind a container-visible address.

## References

- `docs/VIRTUAL-BROWSER-PLAN.md`, `docs/VIRTUAL-BROWSER.md` — mirrored pattern.
- `docs/BROWSER-HANDOFF-DESIGN.md`, `docs/BROWSER-HANDOFF-OPERATIONS.md`,
  `docs/ADR-BROWSER-HANDOFF-WEBRTC.md` — required before P3.
- `docs/AGENT-PROTOCOL.md` — extend with `computer_*` tools + approval tiers
  when P0 lands.
- CUA checkout: `libs/cua-driver/README.md` (`cua-driver mcp --direct`,
  permission modes), `libs/cua-driver/docs/action-icon-catalog.md` (tool
  union), `libs/cua-driver/docs/action-result-contract.md` (`ActionResult`),
  `libs/cua-driver/docs/action-support.md` (Linux X11 ledger),
  `libs/cua-driver/rust/Skills/cua-driver/LINUX.md` (delivery model),
  `libs/xfce-cua/`, `libs/xfce/` (desktop images), `README.md` (Sandbox SDK for
  P4).
