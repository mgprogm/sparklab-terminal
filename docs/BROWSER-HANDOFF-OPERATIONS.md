# Browser Handoff Operations and Diagnostics

This runbook is the operational companion to
[`BROWSER-HANDOFF-DESIGN.md`](./BROWSER-HANDOFF-DESIGN.md). Use it when the
interactive canvas is visible but mouse, keyboard, or streamed-page changes do
not appear to work.

## What the User Is Controlling

The canvas is not the user's personal browser and is not a DOM iframe. It is a
bounded JPEG screencast from the isolated Chromium process owned by the active
Agent Chat. The frontend converts canvas input into a small allowlisted
protocol; agent-service converts that protocol to internal CDP input commands.

```text
pointer/key event
  -> InteractiveBrowser canvas
  -> HandoffInputScheduler
  -> dedicated /browser-handoff WebSocket
  -> BrowserHandoffBroker validation and ordering
  -> BrowserSessionHost internal CDP adapter
  -> isolated Chromium target

isolated Chromium screencast
  -> BrowserSessionHost
  -> latest-frame-wins broker queue (10 FPS maximum)
  -> binary /browser-handoff frame
  -> one-in-flight frontend decoder
  -> canvas paint
```

The user's normal browser cookies, password manager, passkeys, and existing
login session are not copied into this browser. Only the isolated Chromium
profile continues across agent and human control.

## Code Ownership

| Layer            | Primary code                                                                    | Responsibility                                                                     |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| UI overlay       | `apps/terminal/src/features/browser-view/components/browser-view-overlay.tsx`   | Human-control state, countdowns, Done/Cancel, and connection banner                |
| Canvas input     | `apps/terminal/src/features/browser-handoff/components/interactive-browser.tsx` | Coordinate mapping, focus, pointer capture, keyboard filtering, and virtual cursor |
| Input pacing     | `apps/terminal/src/features/browser-handoff/input-scheduler.ts`                 | Coalesce moves/wheel; flush them before ordered down/up/key events                 |
| Frame decoding   | `apps/terminal/src/features/browser-handoff/frame-renderer.ts`                  | One active decode and one replaceable pending frame                                |
| Browser socket   | `apps/terminal/src/features/browser-handoff/connection.ts`                      | One-time auth, reconnect token, binary frames, and control ACKs                    |
| Strict schemas   | `packages/shared-types/src/agent.ts`                                            | Bounded input and handoff control contracts                                        |
| Broker           | `apps/agent-service/src/browser-handoff-broker.ts`                              | Ownership, input validation/rate limits, timers, backpressure, and ACKs            |
| Socket route     | `apps/agent-service/src/index.ts`                                               | Cookie authentication and serialized auth/input routing                            |
| Chromium adapter | `apps/agent-service/src/browser-session-host.ts`                                | Ephemeral profile/proxy, screencast, internal CDP input, and cleanup               |
| Control lease    | `apps/agent-service/src/browser-control-lease.ts`                               | Exclusive agent versus human control                                               |

Raw MCP, CDP, JavaScript evaluation, cookies, filesystem, upload, and download
must never be added to the public handoff protocol.

## Virtual Mouse Semantics

The virtual cursor is an arrow rendered locally and contains no page or secret
data. Its tip is the exact bounded browser coordinate sent by the frontend.
Its color reflects connection/pressed/ACK state; the label remains the
authoritative coordinate display.

| Signal                     | Proven                                                                 | Not proven                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Cursor moves               | The canvas received the local pointer event and calculated coordinates | The WebSocket sent it or Chromium accepted it                                                                                    |
| `data-connected="true"`    | The handoff socket authenticated and is currently open                 | A particular click was delivered                                                                                                 |
| Label ends in `...`        | The local event was queued for sending                                 | Server/CDP acceptance                                                                                                            |
| Label ends in `✓`          | A pointer or wheel input completed in agent-service/CDP                | Which pointer action was acknowledged, that a DOM target existed, focus changed, navigation occurred, or a new frame was painted |
| `data-pressed="true"`      | The local pointer-down handler ran                                     | The remote page handled the press                                                                                                |
| `data-pressed="false"`     | No button is currently held locally                                    | Whether the preceding click changed the page                                                                                     |
| `data-acknowledged="true"` | A recent pointer/wheel ACK arrived                                     | Long-lived success; it resets after about 350 ms                                                                                 |

Current v1 ACKs contain only `inputType` (`pointer`, `wheel`, and so on). They do
not contain coordinates, text, button, or action. A pointer-move ACK can
therefore produce the same `✓` as down/up. The label text currently retains
its last check mark after the short acknowledged style expires, so
`data-acknowledged="false"` together with a visible `✓` is expected. Do not use
the check mark alone as proof that a button or form changed state.

This limitation preserves secret isolation but is also an observability gap.
A future protocol revision may add a non-secret monotonic input sequence and
pointer action (`move`/`down`/`up`) without echoing coordinates or typed text.

## Coordinate Mapping

The browser protocol uses canvas bitmap coordinates, not CSS pixels:

```text
x = (clientX - canvasRect.left) / canvasRect.width  * canvas.width
y = (clientY - canvasRect.top)  / canvasRect.height * canvas.height
```

The values are rounded and bounded to `0..1280` by `0..720`. CSS scaling is
therefore expected: for example, a `1280x720` canvas displayed as `816x459`
maps protocol point `(640,242)` to approximately CSS point `(408,154)` inside
the element.

Do not compare absolute screen `clientX/clientY` values to browser coordinates.
The virtual label shows the latter.

Screencast dimensions must describe the same current viewport used by CDP
input. The handoff adapter therefore normalizes the active target to 1280x720
before starting the bounded JPEG screencast, then restores Browser Use's prior
viewport before reloading and returning control to the agent. Earlier builds
could leave Browser Use at `1920x1080` while scaling only the JPEG to
`1280x720`, causing pointer coordinates to miss by roughly 1.5x. During an
active handoff, both the CDP viewport and canvas contract are now `1280x720`.

## Layered Diagnosis

Run the checks in order. Do not jump from “the image did not visibly change” to
“the click did not reach Chromium.”

### 1. Confirm the current frontend bundle

The interactive canvas should contain all of these markers:

```html
<canvas
  aria-label="Interactive isolated browser"
  aria-disabled="false"
  class="cursor-none ..."
></canvas>
<div data-testid="virtual-mouse">
  <svg data-testid="virtual-mouse-arrow"></svg>
</div>
```

If `cursor-none`, `aria-disabled`, or the virtual-mouse sibling is absent, the
tab is running an older frontend bundle. Hard reload it. If necessary,
unregister the service worker and clear site data, understanding that this also
signs the user out and destroys client-only handoff credentials.

The service worker uses network-first navigation and cache-first immutable
Next assets. An already-open tab does not hot-replace its JavaScript after a
PM2 restart. The update prompt is tied to a changed service worker, so an app
bundle-only deployment can leave an old open tab running until reload.

### 2. Confirm handoff connection state

- The banner must say **Connected**.
- The canvas must have `aria-disabled="false"`.
- The cursor must have `data-connected="true"`.

If not, inspect the `/browser-handoff` WebSocket. Production proxies must route
that exact path to agent-service, not the Next.js catch-all. Authentication is
the first text frame; input sent before authentication is serialized behind it
server-side.

### 3. Confirm local hit testing

Move over the canvas and verify that the virtual cursor follows the physical
pointer and the bounded label changes. If it does not, inspect overlay stacking
and pointer-event capture. The cursor overlay itself is `pointer-events:none`
and cannot block the canvas.

### 4. Confirm transport/CDP acceptance

A temporary `✓` means that at least one pointer/wheel message passed schema
validation and its CDP command completed. If the socket closes immediately
after input, inspect the close reason for invalid input, rate limiting, or an
inactive handoff lease.

Remember that the v1 check mark cannot distinguish move from down/up.

### 5. Confirm the target and expected effect

Clicking blank page space produces no visible result. Clicking a text field may
only change focus styling. Use a known target coordinate or a controlled fake
login page before concluding that input failed.

For the Microsoft sign-in page reached from
`https://tv.buzzebees-dev.com/journalentry_.aspx`, the isolated diagnostic on
2026-07-27 found the email input near browser coordinate `(640,242)` at viewport
`1280x633`. A direct move/down/up made `document.activeElement` an
`INPUT[type=email]`. This coordinate is diagnostic evidence, not a permanent
selector; Microsoft can change its layout.

### 6. Confirm frame freshness

Input success and frame success are independent directions on the same socket.
If input is accepted but the canvas never changes:

- confirm binary WebSocket frames continue arriving;
- confirm the bytes are bounded JPEG/WebP;
- confirm `createImageBitmap` succeeds;
- compare frame hashes before and after a controlled visible change;
- inspect whether canvas `width`/`height` updates to the decoded bitmap;
- inspect broker backpressure without logging frame bodies.

The broker keeps only the newest pending frame and sends at most 10 FPS. The
frontend similarly keeps one active decode and one replaceable pending frame.
Frame dropping under load is intentional; a permanently frozen frame is not.

## Decision Table

| Observation                                                  | Most likely layer                              | Next check                                                         |
| ------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| No virtual cursor                                            | Stale bundle or canvas event/overlay issue     | Bundle markers and DOM stacking                                    |
| Cursor moves, says `connecting...`                           | Handoff socket/auth                            | Banner, WebSocket route, cookie, Origin                            |
| Cursor moves, no ACK, socket remains open                    | Client send or broker processing               | WS text frames, schema, queue/rate limit                           |
| `✓`, but blank-space click changes nothing                   | Expected page behavior                         | Click a controlled input/button                                    |
| `✓`, known target will not focus                             | Wrong target or coordinate mapping             | Canvas bitmap/CSS dimensions and active target                     |
| Known input accepts typing but canvas stays unchanged        | Server-to-client frame path                    | Binary frames, decode, canvas paint                                |
| Canvas changes in a fresh E2E session but not the user's tab | Client-specific stale state/browser behavior   | Hard reload, new handoff, browser console/network                  |
| Reload returns only recovery controls                        | Expected loss of memory-only media credentials | Use Done to return control, or Cancel and start a fresh handoff    |
| Reopen request reports active but no recovery view appears   | Chat/client ownership or control-frame failure | Verify the same chat and inspect the authenticated `/agent` socket |

## Reproducible Tests

### Focused automated suites

```bash
pnpm --filter @sparklab/terminal test
pnpm --filter @sparklab/agent-service test
pnpm --filter @sparklab/terminal typecheck
pnpm --filter @sparklab/agent-service typecheck
```

Key regression files:

- `interactive-browser.test.tsx`: pointer mapping, mouse buttons, virtual
  cursor, and ACK display.
- `input-scheduler.test.ts`: move/wheel coalescing and event ordering.
- `connection.test.ts`: authentication, binary frames, reconnect, and ACK
  control messages.
- `frame-renderer.test.ts`: one-decode/latest-pending frame behavior.
- `browser-handoff-broker.test.ts`: tokens, reconnect, frame backpressure, and
  pacing.
- `browser-session-host.test.ts`: CDP mouse parameters and screencast ACK
  failure handling.

### Production E2E method

Use a fresh temporary terminal/chat so another browser tab cannot own or hide
the handoff state. The test must:

1. Authenticate normally; never print credentials or cookies.
2. Create a uniquely named temporary terminal session.
3. Ask the agent to navigate to a public test login page and request handoff.
4. Approve each browser action once. Note that `browser_request_handoff` may
   render a generic **Approve** label while `browser_act` renders
   **Approve once**; automation should match both intentionally.
5. Wait for the connected interactive canvas.
6. Record canvas bitmap and CSS dimensions.
7. Click a known non-secret input coordinate and type a synthetic sentinel.
8. Compare canvas frame hashes before and after; do not persist screenshots.
9. Cancel the browser session and delete only the temporary terminal.

The 2026-07-27 production run used a temporary session and the Microsoft email
input without real credentials. It observed:

```text
browser approvals:       2
canvas bitmap:           1280x720
canvas CSS box:          816x459
protocol click:          640,242
CSS click inside canvas: 408,154
virtual cursor:          640,242 ✓
frame hash changed:      yes
```

This proves the complete production path for that run: frontend hit testing,
socket authentication, broker validation/ordering, CDP input, screencast return,
binary proxying, decode, and canvas repaint. It does not prove that every user
browser, page layout, or concurrent chat client is healthy.

### Direct Chromium diagnostic

An isolated `BrowserSessionHost` diagnostic may use internal CDP locally to
separate adapter behavior from the UI. It must never expose the debugger URL or
CDP messages to the browser client, logs, docs output, or public protocol.

The 2026-07-27 checks established:

- direct click on an `example.com` link changed the target URL;
- the screencast emitted a distinct frame after the click;
- the Microsoft email input received focus after move/down/up;
- no username, password, OTP, cookie, or typed credential was used.

## Production Checks

```bash
pm2 describe prod-terminal
pm2 describe prod-agent
ss -ltnp | rg ':(3100|3107|3109|3110)\b'
curl -fsSI http://127.0.0.1:3100/
curl -fsSI http://127.0.0.1:3110/
```

The local-production topology is:

```text
3110 proxy
  /attach, /api/*       -> 3107 gateway
  /agent                -> 3109 agent-service
  /browser-handoff      -> 3109 agent-service
  everything else       -> 3100 terminal
```

Build frontend changes into `.next-prod` before restarting:

```bash
./build-prod.sh
pm2 restart ecosystem.config.cjs --only prod-terminal,prod-agent --update-env
```

Restarting agent-service destroys its in-memory handoff tokens, active leases,
and ephemeral Chromium sessions. Always create a new handoff after a restart.
Do not inspect `pm2 jlist` or dump complete process environments into shared
logs: they may contain credentials. Prefer `pm2 describe` and filtered health
checks.

## Security During Diagnostics

- Never ask the user to paste a password, OTP, cookie, resume token, or handoff
  token into chat or a terminal.
- Never log WebSocket message bodies for the handoff path.
- Never save production frame images unless the user explicitly authorizes an
  artifact and its retention policy; hashes and dimensions are sufficient for
  most stream checks.
- Use synthetic text only. Cancel the test browser afterward so its temporary
  profile and cookies are deleted.
- Do not return control to the agent after typing a diagnostic sentinel into an
  authentication field; cancel the browser session instead.
- Test-created terminal sessions may be deleted only when their exact ids are
  captured at creation. Never clean up by name glob or broad prefix.
