# Virtual Computer (CUA) — remaining work

Implementation plan for the work left after the spike + real `cua-driver` 0.22.2
verification. Companion to [`VIRTUAL-COMPUTER.md`](./VIRTUAL-COMPUTER.md)
(decision record, D1–D5) and [`VIRTUAL-COMPUTER-PLAN.md`](./VIRTUAL-COMPUTER-PLAN.md)
(design/phasing). Produced 2026-08-30 as an SA planning pass over branch
`feat/virtual-computer-cua-spike` (pushed, not merged, inert unless
`CUA_ENABLED=true`).

Decisions D1–D5 are unchanged by everything below.

## Pre-merge changes to the existing spike

Defects / misleading artifacts in the branch as pushed. Fold into M1; none
expand scope.

1. **`computer_observe` tool description is false.** `tools.ts` tells the model
   it returns "indexed on-screen elements (role, name, bounds, index)… pass it
   back with an element index," but `observe()` returns literally `elements []`
   and `computer_act`'s own description says element targeting is unavailable in
   v1. A model will try element targeting, spend a one-time approval, and hit
   `error: element N is not in the latest observation` from `act()`. Rewrite the
   description to match reality: viewport, `snapshotId`, window inventory
   (id/pid/title/app/bounds), screenshot; target `computer_act` by
   screen-absolute x,y.
2. **The element-targeting branch is half-live and mis-prioritised.**
   `parseComputerTarget` checks `element_index`/`snapshot_id` _first_, so a model
   sending both an element index and valid x,y is routed to the always-failing
   branch. For v1: drop `element_index`/`snapshot_id`/`window_id` from the
   `computer_act` schema and delete the element branch of `parseComputerTarget`
   / the `elementIndex` arm of `ComputerTarget` (M3 rebuilds this against
   `element_token`). Alternative: fall through to x,y when the element list is
   empty. Recommendation: remove it.
3. **Delete `parseAxTree` and `parseViewport` from `computer-runtime.ts`.**
   `parseAxTree` carries a `TODO(spike)` guessing a `get_accessibility_tree`
   shape the 0.22.2 run disproved. Neither is called by `observe()`. Exported +
   unit-tested, so removal touches `computer-runtime.test.ts`.
4. **`CUA_IMAGE` default is broken.** `config.ts` defaults to
   `trycua/xfce-cua:latest` = `cua-driver` 0.12.4 (no `mcp --direct`).
   `CUA_ENABLED=true` with nothing else set burns the X-readiness poll + 8
   driver retries, then fails. Change the default to
   `sparklab/cua-desktop:0.22.2`, or fail fast with a clear message on the
   known-bad tag. Document the one-time
   `docker build -t sparklab/cua-desktop:0.22.2 apps/agent-service/test/cua-real`.
5. **Docs stale / self-contradicting.** `VIRTUAL-COMPUTER-PLAN.md` still says
   "Status: Proposed. Not implemented"; its D6 (bounded default) and D7
   ("desktop-scope coordinates never used") contradict what shipped. Add
   supersede banners + flip the status line. `docs/AGENT-PROTOCOL.md` needs a
   `computer_*` tools + approval-tier section (observe auto, act one-time).
6. **`system-prompt.ts` focus caveat.** `type_text`/`press_key` go to
   `{scope:"desktop"}` with no coordinates, so text lands wherever X focus
   happens to be, and v1 has no focus-setting primitive. Add: "Before typing,
   click the target field first."
7. **(S, optional) Screenshot-byte bound is checked after unbounded
   accumulation.** `dockerCapture` concatenates all `base64` stdout with no cap;
   `MAX_SCREENSHOT_BYTES` is checked afterward. `head -c` in the exec, or a
   running cap in the base64 read path.

**Merge invariant:** with `CUA_ENABLED` unset, no behavior changes. Gate =
agent-service 142/142, terminal 327/327 unchanged, stub `test:computer-e2e`
9/9.

---

## M1 — "Mergeable"

Land the branch with the pre-merge fixes; no new capability.

- **M1.1 Apply fixes 1–7.** Files: `tools.ts`, `agent-loop.ts`,
  `computer-runtime.ts`, `computer-runtime.test.ts`, `config.ts`,
  `system-prompt.ts`, `tools.test.ts`, `agent-loop.test.ts`. Keep
  `ComputerTarget` x,y-only for v1. Verify: stub e2e 9/9; unit suites updated;
  full `lint && typecheck && test && build`. Effort S. Risk: grep
  `parseAxTree|parseViewport` for test ripple.
- **M1.2 Docs + protocol.** `VIRTUAL-COMPUTER.md`, `VIRTUAL-COMPUTER-PLAN.md`
  (status + D6/D7 supersede), `AGENT-PROTOCOL.md` (new section). Effort S.
- **M1.3 Open the PR.** Body: what shipped, inert-unless-`CUA_ENABLED`, the
  one-time image build, links to M2/M3, the "no behavior change when disabled"
  claim + test evidence. Request the security reviewer. Effort S.

**M1 exit:** merged, dormant, docs consistent, protocol documented.

---

## M2 — "Safe to enable for one operator"

### M2.1 `bounded` permission mode + checked-in capability manifest

- New `apps/agent-service/test/cua-real/capability-manifest.yaml` + a `COPY`
  line in the Dockerfile placing it at a fixed in-container path (e.g.
  `/etc/cua/capability-manifest.yaml`). **The current wiring is broken** — it
  passes a _host_ path into a container with _no bind mount_, so the file never
  exists inside. Baking it into the image keeps "no bind mounts", versions the
  manifest with the image, adds no runtime step.
- `config.ts` — default `capabilityManifestFile` to that container path when
  `driverPermissionMode==="bounded"`; default mode stays `standard` (per-operator
  opt-in). `computer-runtime.ts` — startup assertion: `bounded` with no manifest
  path → refuse to start with a clear error.
- Allowlist = PLAN doc's list trimmed to what v1 + M3 calls:
  `get_desktop_state, get_window_state, get_screen_size, list_windows,
list_apps, get_cursor_position, click, double_click, right_click, drag,
scroll, type_text, press_key, hotkey`. **Pull the exact YAML schema from the
  checkout** (`rust/crates/cua-driver-core/src/session_manifest.rs`,
  `libs/cua-driver/contract/`) — do not invent it.
- Verify: `CUA_E2E_REAL=1 CUA_DRIVER_PERMISSION_MODE=bounded test:computer-e2e`
  admits every `computer_*` path. **Negative check (required):** extend
  `probe.mjs` to dump `tools/list` policy under bounded and assert a
  non-manifest tool (`launch_app`/`kill_app`/`bring_to_front`) is **denied** — a
  silent fallback-to-allow otherwise reads as a pass.
- Effort M. Risks: manifest schema drift per driver version; admission may key
  on resource classes not tool names; `element_token` vs `element_index` may be
  separate capabilities.

### M2.2 Per-service concurrent-desktop limiter

- New `computer-resource-limiter.ts` — near-verbatim copy of
  `browser-resource-limiter.ts`: `reserveSession()` (hard cap, throws
  `cua_desktop_limit_reached`) + `acquireLaunch()` (bounded concurrency queue).
  `computerResources` singleton.
- `config.ts` — `MAX_CUA_DESKTOPS` (2–4), `MAX_CUA_LAUNCHES` (1–2).
- `computer-runtime.ts` `start()` — `reserveSession()` before `docker run`,
  `acquireLaunch()` around `docker run` + `waitForXReady` + driver spawn;
  release both in `doDispose()` (keep the `released` guard).
- Rationale: N concurrent cold starts on one Docker daemon is exactly the
  pathology `maxConcurrentLaunches` exists for — mirror **both** methods.
- Verify: new `computer-resource-limiter.test.ts`; stub e2e case that a 3rd
  concurrent `ensureStarted()` rejects and leaks no container. Effort M.

### M2.3 `sweepOrphans()` multi-instance safety

- Today it `docker rm -f`s **every** `label=sparklab-cua` container host-wide —
  two agent-service instances (or a restart while another has a live desktop)
  and boot kills a running desktop. Add a per-instance label component
  (`sparklab-cua-instance=<id>`, id from `CUA_INSTANCE_ID` or a boot random) and
  filter `sweepOrphans()` on it. Graceful teardown (by name) is unaffected.
- Verify: unit test with stubbed `docker ps` across two instance labels removes
  only the current one. Effort S.

### M2.4 `/health` metrics wiring

- New `computer-performance-metrics.ts` — mirror `browser-performance-metrics.ts`
  exactly. Counters: `desktopReadiness` (run→X ready), `driverReadiness`
  (spawn→initialize), `computerCalls` (per `tools/call` timing + failure),
  `screenshotBytes`, `elementBytes` (M3), launch-queue depth.
- `computer-runtime.ts` reports into the singleton at the same seams
  `browser-runtime.ts` uses; keep the per-instance `counters` for unit tests.
- `index.ts` — add `computerResources` + `computerPerformance` snapshots to
  `/health` JSON.
- Rationale: `ComputerRuntime.metrics()` is per-instance and **nothing reads
  it** — `/health` only exposes process-wide singletons. Design gap, not a
  "confirm it's wired" item. Label-free by construction.
- Verify: metrics-module unit test; `/health` contains the two new keys with
  zeroed summaries when CUA is enabled-but-unused. Effort M.

### M2.5 Frontend verification + missing reopen affordance

- **Add the `computerView && !computerVisible` header button** calling
  `useComputerViewStore(s => s.show)` in `terminal-shell.tsx`, mirroring the
  browser block (lucide `Monitor`, `text-chart-2`). **It does not exist today**
  — nothing calls `show()`, so "Back to terminal" is one-way, contradicting the
  doc.
- New `computer-view/__tests__/computer-view-overlay.test.tsx` mirroring
  `browser-view/__tests__/browser-view-overlay.test.tsx` (only `store.test.ts`
  exists): renders on `computer_view`, "Back to terminal" hides, later revision
  replaces the image, `computer_closed` at R tombstones so `computer_view` at
  R−1 can't reopen.
- Manual pass with a real desktop behind `CUA_ENABLED=true`: overlay renders at
  correct aspect, xterm stays mounted/!resized beneath, focus → Back button,
  header `Monitor` reopens the same revision, Stop mid-session emits
  `computer_closed` and clears the overlay.
- Effort M. Risk: 1280x900 desktop in the default split — check `object-contain`
  doesn't letterbox badly; if so, note the resolution knob for M3.

### M2.6 Egress default guidance

- Runbook in `VIRTUAL-COMPUTER.md` + `.env.example`: `docker network create
--internal sparklab-cua-egress`, set `CUA_EGRESS_NETWORK`,
  `CUA_DRIVER_PERMISSION_MODE=bounded`, build the image. State the `--internal`
  trade-off plainly (no browsing). Startup **warning** (not hard failure — keep
  offline dev) when `CUA_ENABLED=true` and no egress network. Effort S.

**M2 exit:** one operator, one instance, `bounded` + image-pinned manifest
(with a negative-deny test), `--internal` egress, desktop/launch caps,
`/health` counters, verified overlay with a working reopen affordance.

---

## M3 — "Feature-complete v1"

Ordering: **M3.1 before M3.2** (the extra actions re-plumb `ComputerTarget` /
`act()`).

### M3.1 P1 per-window element targeting — L — ✅ DONE (2026-08-31)

**Shipped as planned:**

- `observe()` phase 2: `get_window_state({pid, window_id,
include_screenshot:false, max_elements:80})` for up to `MAX_WINDOWS=12`
  on-screen windows (skipping `is_on_screen:false` and parked/degenerate
  geometry), merged into ONE flat 0-based indexed list
  (`[{index, role, name, windowId}]`, labelled elements first, total ≤
  `MAX_ELEMENTS=200`, name ≤ `MAX_ELEMENT_NAME`), minted under a synthetic
  `snap-<n>` id. `this.lastElements` (Map) + `this.lastSnapshotId` re-added.
- `ComputerTarget` is now `{ elementIndex; snapshotId } | { x; y }` (vestigial
  `windowId?` dropped). New exported `parseWindowElements()` (tolerant, unit-
  tested against recorded real Thunar + degraded-Desktop JSON). `driverArgs`
  gained an element arm — **prefers `element_token`** (the driver requires
  `pid` alongside it; `element_index + snapshot_id` is the fallback when a
  snapshot carried no tokens). `act()` staleness/membership checks are live
  (`error: stale snapshotId` / `error: element N is not in the latest
observation`, both local, no driver round-trip).
- `tools.ts` — `computer_act` re-exposes `element_index` + `snapshot_id`;
  `computer_observe` / `computer_act` descriptions rewritten; `describeCall`
  element case → `"click computer element N"`. `agent-loop.ts`
  `parseComputerTarget` — element branch first, x,y fallback, coherent when
  both supplied. `system-prompt.ts` updated. `elementBytes` counter now
  measures the emitted model-facing element JSON (was the window list).
- Stub `cua-driver-mcp.mjs` answers `get_window_state` (2 windows, tokens) and
  `list_windows` bumped to 2. New e2e cases (stub 13/13); `CUA_E2E_REAL=1`
  10/10 incl. a live click-by-element + stale-snapshot reject.

**Deviated from the plan (all evidence-backed by the pre-impl real probe):**

- **Element targeting is `click` + `type_text` only.** Element-targeted
  `press_key` / `scroll` under `delivery_mode:"background"` on X11 _always_
  return `background_unavailable` (the XTest route only reaches the globally
  focused widget) — the parse layer rejects that combination so the model
  never spends an approval on a guaranteed failure. `press_key` / `scroll`
  stay `x,y`-only, unchanged from M2.
- Token supersession is **per-window** (probed), so the specced stored-token
  multi-window merge is safe with **zero** extra round-trips — no re-snapshot
  before dispatch.
- AT-SPI fidelity is **good**, not "unmeasured / possibly poor" — Thunar 71
  labelled elements, Application Finder 120, panels 6–10; only `xfdesktop`'s
  canvas is empty (surfaced as an `elements-degraded` hint). Element targeting
  is a real capability on this image, not "nice when available".

**Known M3.1 gaps (documented, not blockers):** `describeCall` shows only
`element N` (role/label aren't in the tool args); `act()` costs `1 + (N+2)`
driver calls because the trailing re-observe re-walks every window;
`test:computer-smoke` was not extended (out of scope — no live-model change).

### M3.2 `drag` / `double_click` / `right_click` / `hotkey` — M — ✅ DONE (2026-08-31)

**Shipped as planned:** `ComputerAction` union + `ACTION_TOOL` map + `driverArgs`
cases; `tools.ts` `kind` enum + `to_x`/`to_y` + `keys` (`maxItems:8`, item
`maxLength:16`); `agent-loop.ts` `parseComputerAction` cases; `describeCall`
cards (`"double_click computer element N"` / `"right_click computer @ x,y"` /
`"drag computer @ x,y → x,y"` / `"hotkey computer ctrl+l"`); `system-prompt.ts`
one-liner. `redactToolArgs` unchanged (only `type_text` carries a secret; the
new kinds carry none). Still `WRITE_TOOLS` ∩ `ONE_TIME_TOOLS`, one per approval.
Stub `cua-driver-mcp.mjs` already answered the four tool names generically. Six
new stub e2e cases (19/19); `CUA_E2E_REAL=1` adds a real `right_click`-by-x,y
case (17/17).

**Deviated from the plan (probe-driven — `test/cua-real/probe.mjs` round 1–3
against real 0.22.2):**

- **`double_click` / `right_click` use `delivery_mode:"foreground"`, not
  background.** Their driver schemas have **no `scope` param** and a
  **required `pid`**; under `delivery_mode:"background"` both return
  `background_unavailable` for **every** target form (element_token AND
  x,y+pid+window_id) on this X11 image. `foreground` (a brief window activate,
  then the prior foreground is restored) is the only mode that works and
  returns `effect=unverifiable route=global_input`. The M3.1 "delivery is
  always background / never escalates to foreground" invariant is amended for
  exactly these two verbs — it was a no-focus-shift fidelity guarantee, not a
  containment boundary (the desktop is a human-less disposable container).
- **A screen-`x,y` `double_click` / `right_click` resolves `pid` + `window_id`
  locally** from `windowAtPoint(x,y)` — the front-most window (largest
  `z_index`, ties → smaller area) in the last `observe()` that contains the
  point — because the driver requires a window and has no desktop-scope form
  for these two. Refused locally if no observed window contains the point.
  `observe()` now stashes `this.lastWindows` (cleared at the top of every
  `observe()` so a stale point fails closed).
- **`hotkey` is rejected below 2 keys at the parse layer.** The driver requires
  "modifier(s) + one non-modifier key" (probe: `["Escape"]` →
  `invalid_arguments` "must contain at least two keys"); `parseComputerAction`
  / `act()` enforce `2 ≤ keys.length ≤ 8` up front so a one-key chord never
  spends a one-time approval — same principle M3.1 applied to element-targeted
  `press_key` / `scroll`. Deliberate tightening of the task's stated
  "non-empty" rule.
- **`drag` is `scope:"desktop"` with no `pid`/`window_id`.** Probe: `{from_x,
from_y, to_x, to_y, scope:"desktop", delivery_mode:"background"}` works
  (`effect=unverifiable route=global_input`); adding `pid`/`window_id` →
  `invalid_action_target` "desktop scope cannot be combined with pid or
  window_id". `to` is x,y-only (no element end) as the task allowed for v1.
  `driverArgs` param names are `from_x/from_y/to_x/to_y` (probed).
- **All four M3.2 kinds return `effect=unverifiable` on this image, never
  `confirmed`** — so none can self-report success; the model must re-observe.

### M3.3 `computer_list_windows` — S — ✅ DONE (2026-08-31)

New read tool (no args, **not** in `WRITE_TOOLS`), gated on `config.cua.enabled`;
`agent-loop.ts` `execute()` branch → `this.computer.listWindows(signal)` (a
plain string, auto-approved, no `computer_view` frame). `ComputerRuntime.listWindows()`
= `list_windows` + `list_apps`, bounded (`MAX_WINDOWS` windows via
`summarizeWindow`; `MAX_APPS` = 40 running apps as `{name, pid}`), no screenshot.
`describeCall` → `"list computer windows"`. `list_apps` structuredContent shape
(probed): `{apps:[{name, pid, running, active, bundle_id, kind, ...}]}` — only
`name` + `pid` of `running !== false` entries are surfaced. Stub + FakeChild
gained a `list_apps` handler.

### M3.4 `computer_capture` — S — ✅ DONE (2026-08-31)

New tool, `WRITE_TOOLS` ∩ `ONE_TIME_TOOLS`, gated on `config.cua.enabled`;
params `session_id` + `path` (both required). `agent-loop.ts` `execute()` branch
is a near-verbatim copy of `browser_capture`: validate `path` absolute and
≤ 4096, `this.computer.observe(signal)`, `"error: computer did not return a
screenshot"` when there is no snapshot, emit the `computer_view` frame, then
`gateway.uploadSessionFile(session_id, path, bytes, mediaType)` (the **existing**
`fs/upload` route — no gateway change), return `{saved, path, size, mediaType,
viewport}`. `sanitizePersistedToolResult`'s `computer_*` rule already blanks it
from durable history. `describeCall` → `"capture computer screen to <path>"`.

### M3.5 Proxied browsing — L, explicitly weaker guarantee — ✅ DONE (2026-08-31)

**Shipped as an opt-in mode with a deliberately weaker guarantee, as designed:**

- `browser-proxy.ts` — `SafeBrowserProxy.start(bindHost = "127.0.0.1")` +
  a `.port` getter. Backward-compatible: the browser path calls `start()` with
  no argument and is byte-identical. The public-only `browser-security.ts`
  ruleset is unchanged and applies regardless of bind host.
- `config.ts` — `cua.proxyBrowsing` (`CUA_PROXY_BROWSING`, default `false`),
  `cua.proxyBindHost` (`CUA_PROXY_BIND_HOST`, default `0.0.0.0`),
  `cua.proxyContainerHost` (`CUA_PROXY_CONTAINER_HOST`, default
  `host.docker.internal`). **Hard config error** (throws at load) when
  `CUA_PROXY_BROWSING=true` and `CUA_EGRESS_NETWORK` are both set — an
  `--internal` net has no route to the proxy.
- `computer-runtime.ts` — a per-runtime `SafeBrowserProxy`, started in `start()`
  ONLY under `proxyBrowsing`, bound to `proxyBindHost`, torn down in
  `doDispose()` (idempotent). The `docker run` args gain
  `--add-host=host.docker.internal:host-gateway` + `-e http_proxy` /
  `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` = `http://<containerHost>:<port>`
  - `no_proxy` / `NO_PROXY` = `127.0.0.1,localhost`, and NO `--network` (mutually
    exclusive). After `waitForXReady`, `execInContainer` writes a Firefox ESR
    enterprise `policies.json` (`Proxy.Mode=manual`, `Locked=true`) to every path
    a Debian/Mozilla build reads — best-effort, `console.warn` on failure, never
    fatal.
- Tests: `browser-proxy.test.ts` (+2 — bindHost/`.port`/teardown, ruleset still
  applies), `config-cua-proxy-conflict.test.ts` (NEW — both-set → config load
  rejects), `computer-runtime-proxy.test.ts` (NEW — `docker run` carries
  `--add-host` + the proxy env and NO `--network`; the proxy really listens then
  is closed on `stop()`; the Firefox policy write ran). `computer-e2e.js` gains
  a `CUA_E2E_REAL=1 CUA_PROXY_BROWSING=true`-guarded case: desktop reaches
  X-readiness with `http_proxy` set, `curl -x <proxy> https://example.com`
  succeeds from inside, `curl -x <proxy> http://169.254.169.254/` is refused.
  Stub e2e stays 19/19, default real 17/17.

**What it enforces:** proxy-env-aware tools (curl/wget) and policy-driven
Firefox reach only allowed public HTTP(S) via the SafeProxy; private / metadata
destinations are `403`'d.

**What it does NOT do (documented loudly in `VIRTUAL-COMPUTER.md`):** it is
**not a containment boundary** — the container keeps a default route off-box
(`curl --noproxy '*'` still reaches the internet), non-proxy-aware apps egress
freely, and real enforcement needs netns firewall rules (moved to Open items).
**Deviation / honest gap:** Firefox end-to-end through the proxy is **UNVERIFIED
on `sparklab/cua-desktop:0.22.2`** — Firefox 140 ESR cannot render pages in that
image (broken software-GL framebuffer; hangs before writing a profile),
unrelated to egress. The policy-write mechanism is implemented and lands at the
right paths; curl/wget routing is verified.

**M3 exit — COMPLETE (2026-08-31).** Element targeting (M3.1 ✅), full action
family (M3.2 ✅), window listing (M3.3 ✅), bounded capture (M3.4 ✅), opt-in
proxied browsing (M3.5 ✅, weaker guarantee as designed). The milestone matches
the PLAN's v1 acceptance criteria; `--internal` (`CUA_EGRESS_NETWORK`) stays the
recommended default and the only mode with a hard zero-egress guarantee.

---

## P3 — Interactive "Take control" (scope only; separate doc)

New **`docs/COMPUTER-HANDOFF-DESIGN.md`** (sibling of
`BROWSER-HANDOFF-DESIGN.md`), per D4: a dedicated `/computer-handoff`
WebSocket, its own control-lease module, a `features/computer-handoff/`
frontend feature — **not** a `target:` param on the browser protocol.

Required reading first: `BROWSER-HANDOFF-DESIGN.md`,
`BROWSER-HANDOFF-OPERATIONS.md` incident log (the silent-drop regression D4
cites), `ADR-BROWSER-HANDOFF-WEBRTC.md`.

Four unknowns the doc must resolve: (1) frame source — Xtigervnc stream vs
`get_desktop_state` polling vs WebRTC; (2) control-lease shape + interaction
with `ComputerRuntime` mid-`act()`; (3) input primitives — X11
pointer/keyboard + geometry; `move_cursor({scope:"desktop"})` (real-pointer
warp, currently structurally unreachable) becomes reachable here under a human
lease only; (4) transport — bounded JPEG now vs WebRTC later. Shared helpers
extracted from both implementations _afterward_, not generalized up front.

---

## Cross-cutting risks

- **Cold start under load** — `docker run` + layer unpack + seconds of X
  readiness per chat. M2.2 bounds concurrency, not latency. Measure once M2 is
  on; a slimmer image (Openbox) changes the AX surface M3.1 depends on.
- **Manifest schema drift** — `bounded` YAML is version-coupled to
  `cua-driver`; pin with the image, re-verify the deny probe on any bump.
- **AX-tree fidelity** — ~~unmeasured~~ measured in M3.1: **good** for GTK/XFCE
  under Xtigervnc (Thunar 71 elements, Application Finder 120, panels 6–10);
  only `xfdesktop`'s canvas is empty. x,y stays the documented fallback for
  non-AX surfaces and for `press_key` / `scroll`.
- **`element_token`/`snapshot_id` lifetime** — M3.1 confirmed supersession is
  **per-window**, so tokens collected across one `observe()` stay live
  together; a stale token → driver `stale_element_token` refusal, and `act()`
  now also rejects a stale synthetic `snapshotId` locally. `click` /
  `type_text` by element return `unverifiable` (AT-SPI route, no readback) —
  the "not confirmed" path stays under test.
- **Resolution** — real desktop 1280x900; if the overlay aspect is wrong in the
  default split, expose `CUA_SCREEN_SIZE` (small; do it in M3.1 if M2.5 flags
  it).
- **Docker daemon as shared dependency** — M2.3 fixes the label; one-daemon-
  per-host assumption stands.
