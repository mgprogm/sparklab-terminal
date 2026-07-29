# Browser Handoff / Shared Interactive Browser Design

Status: **Implemented (v1)**.

Operational diagnosis, production validation evidence, and the virtual-mouse
signal matrix live in
[`BROWSER-HANDOFF-OPERATIONS.md`](./BROWSER-HANDOFF-OPERATIONS.md).

## Objective

Extend the existing isolated Virtual Browser so a user can temporarily take
interactive control to complete authentication, then return the same browser
session to the agent.

Required behavior:

- The user can select **Take control**.
- Password, MFA, and other typed secrets are not visible to the agent and are
  never written to chat history, tool results, screenshots, or logs.
- Returning control preserves the existing Chromium process, profile, cookies,
  tabs, and authenticated session.
- Handoffs have idle/hard timeouts and an explicit **Cancel browser session**
  action.
- Cookies from the user's personal browser are never imported into the chat's
  isolated browser automatically.

## Architecture

The recommended design introduces a Browser Session Host that owns one
Chromium process and profile for the chat. Agent automation and human control
are separate adapters competing for an exclusive control lease.

```text
Agent tools ──► Agent Browser Adapter ──┐
                                       │
                                       ▼
                              Browser Session Host
                                       │
                          Chromium process/profile/proxy
                                       ▲
                                       │
User ── handoff WebSocket ──► Human Handoff Broker
```

Components:

- `BrowserSessionHost`: owns Chromium, the temporary profile, tabs, cookies,
  and enforcing outbound proxy.
- `BrowserControlLease`: grants exclusive control to `agent` or `human`.
- `AgentBrowserAdapter`: exposes the existing bounded Browser Use operations.
- `HumanHandoffBroker`: relays bounded screen frames and allowlisted input
  events without involving the model or AgentLoop.
- `HandoffTokenManager`: issues one-time tokens, binds ownership, and enforces
  timeouts and reconnect grace periods.

The frontend must never receive raw MCP, CDP, JavaScript execution, filesystem,
download, upload, or cookie APIs. The host may use CDP internally, but only a
typed and bounded interaction protocol is exposed to the browser client.

## State Machine

```text
NO_BROWSER
    │ lazy start
    ▼
AGENT_ACTIVE
    │ Take control
    ▼
HANDOFF_PENDING
    │ authenticated one-time connection
    ▼
HUMAN_ACTIVE
    ├─ Done ───────────────► AGENT_ACTIVE
    ├─ idle/hard timeout ──► SESSION_CLOSED
    ├─ disconnect expiry ──► SESSION_CLOSED
    └─ Cancel session ─────► SESSION_CLOSED
```

Only `AGENT_ACTIVE` permits `browser_observe`, `browser_list_tabs`, or
`browser_act`. Only `HUMAN_ACTIVE` accepts human input events.

The Take control button should normally be enabled only when the AgentLoop is
idle. The server-side lease remains authoritative and rejects races even when
the UI state is stale.

## Handoff Sequence

1. The agent reaches a login page and finishes its current browser operation.
2. The user selects **Take control**.
3. The server acquires the human lease, rejects new agent browser calls, clears
   cached DOM element indexes, and stops publishing agent snapshots.
4. The server returns an ephemeral handoff id and one-time token.
5. The frontend opens the dedicated handoff WebSocket and authenticates using
   the token in its first frame.
6. The user enters credentials and MFA through the interactive stream.
7. The user selects **Done — return to agent**.
8. The server reloads the active page in the same profile to clear transient
   password/OTP form values, stops the interactive stream, revokes the token,
   clears client frame buffers, and returns the lease to the agent.
9. The next agent observation uses the same Chromium process and profile, so
   cookies and the authenticated state remain available.

While a handoff is pending or active, another approved **Take control** /
`browser_request_handoff` request reopens the existing Browser View. It must
republish the current handoff state instead of acquiring another lease or
issuing another credential. The handoff id, data socket, Chromium profile,
cookies, idle deadline, and hard deadline remain unchanged.

Returning control must not restart Chromium or Browser Use MCP and must not copy
cookies through the frontend.

## Authentication and Transport

Use a dedicated same-origin WebSocket such as `/browser-handoff` rather than
the model-facing `/agent` channel.

Every production reverse proxy must route both `/agent` and
`/browser-handoff` to agent-service. Sending `/browser-handoff` to the Next.js
catch-all leaves the UI on a read-only snapshot because no interactive input
reaches the broker. Reference routes are maintained in `prod-proxy.cjs` and
`deploy/Caddyfile`.

Security requirements:

- Apply the existing Origin allowlist and gateway cookie authentication.
- Generate at least 256 bits of random token material.
- Bind the token to `user + chatId + browserId + handoffId`.
- Make tokens one-time, memory-only, and short-lived.
- After the one-time authentication succeeds, issue a separate memory-only
  resume token over the authenticated socket. It is valid only for the same
  handoff during the 30-second disconnect grace period.
- Send the token in the first WebSocket frame, not a URL query string.
- Allow only one live human connection per browser.
- Reject expired, replayed, cross-chat, and cross-browser tokens.
- Do not store the token in localStorage, persisted Zustand state, analytics, or
  server logs.
- Require TLS outside loopback development.

The production default is `BROWSER_HANDOFF_TRANSPORT=jpeg`. The same socket
also carries a versioned WebRTC capability/offer/answer/trickle-ICE foundation
behind `webrtc-preferred`. Authentication and lifecycle always remain on the
WebSocket, and mouse/keyboard input stays there so ICE failure cannot strand
human control. A failed or unavailable peer automatically returns to the same
bounded JPEG stream. The current provider reports unavailable intentionally;
do not treat native GStreamer/FFmpeg packages alone as an application media
provider. See [ADR-BROWSER-HANDOFF-WEBRTC.md](ADR-BROWSER-HANDOFF-WEBRTC.md).

## Interactive Data Plane

### Server to client

Send bounded WebP/JPEG frames over binary WebSocket messages:

- Maximum viewport: 1280×720 for v1.
- Target frame rate: 5–10 FPS.
- Apply backpressure; keep at most one unsent frame.
- Pace outbound frames to 10 FPS and use latest-frame-wins queues on both the
  broker and client. The client decodes at most one frame at a time while
  retaining one newer pending frame, outside React and persisted state.
- Pace CDP screencast acknowledgements to the same 10 FPS ceiling. Chromium
  therefore does not repeatedly encode frames that the broker would discard.
- Bound frame and message sizes.
- Do not persist or attach frames to chat history.

The Browser Session Host may use an internal CDP screencast, but CDP connection
details and commands never cross the server boundary.

Before starting the screencast, the host normalizes the target's CSS viewport
to 1280×720. CDP input coordinates and JPEG pixels are therefore 1:1 even when
Browser Use previously emulated 1920×1080. On Done, the host restores the exact
prior viewport before reloading the page and returning the lease to the agent.

### Client to server

Expose only allowlisted input messages:

```ts
type HandoffInput =
  | {
      type: "pointer";
      action: "move" | "down" | "up";
      x: number;
      y: number;
      button?: "left" | "middle" | "right";
      buttons?: ("left" | "middle" | "right")[];
      clickCount?: 1 | 2 | 3;
    }
  | { type: "wheel"; x?: number; y?: number; deltaX: number; deltaY: number }
  | {
      type: "key";
      action: "down" | "up";
      key: string;
      code: string;
      modifiers: string[];
    }
  | { type: "text"; text: string }
  | { type: "resize"; width: number; height: number }
  | { type: "ping" };
```

Validate message size, coordinates, key lengths, modifiers, viewport bounds,
and event rate. Never echo text payloads in errors.

Coalesce pointer movement to at most one event per animation frame and combine
wheel deltas over a short bounded interval. Flush pending movement before
ordered click or key events so high-rate input cannot starve or disconnect the
interactive channel.

Mouse handoff supports hover, left/middle/right click, double/triple click,
button-held drag, pointer cancellation, and wheel scrolling at the hovered
coordinates. Side buttons and browser navigation shortcuts remain excluded.
The server serializes authentication and subsequent input so an early click
cannot race Chromium activation, and the canvas remains visibly disabled until
the dedicated handoff channel reports `connected`.
The UI draws a local arrow cursor over the streamed frame with its tip at the
exact bounded CDP coordinates. Cursor DOM work is coalesced once per animation
frame, and the canvas backing size changes only when decoded dimensions change.
It shows a pressed state immediately and a short ✓
only after the server completes the corresponding pointer/wheel input; the
acknowledgement contains the input kind only and never echoes typed content.

The ACK is transport/adapter evidence, not page-effect evidence. In v1 a
pointer-move ACK is indistinguishable from down/up, and successful CDP command
completion does not imply that the coordinate contained an actionable DOM
target. Incident reports must record connection state, canvas bitmap and CSS
dimensions, virtual coordinates, a controlled target effect, and frame
freshness separately.

Clipboard/paste should be disabled by default. If enabled later, it must require
explicit user consent and remain memory-only with the same secret handling as
keyboard input.

## Secret Isolation

During `HUMAN_ACTIVE`:

- Agent browser tools fail with `browser_under_human_control`.
- AgentLoop receives no keyboard, text, pointer, frame, page-state, or DOM
  events.
- No automatic screenshots are published to `/agent`.
- The existing snapshot and indexed-element cache are cleared.
- Input payloads are excluded from request logging, telemetry, analytics,
  tracing, crash reports, and error messages.
- The handoff broker uses fixed metadata in operational logs, such as handoff
  id, state transition, byte counts, and durations; it never logs message
  bodies.
- Query strings and URL fragments are removed from app chrome and operational
  logs because OAuth callbacks may contain codes or tokens.

Before control returns, the active page is reloaded in the same Chromium
profile. This preserves authenticated cookies while clearing transient
password/OTP form values before agent observation resumes. URL query strings
and fragments are recursively removed from Browser Use state and action text.

## Session and Cookie Semantics

Cookies remain inside the temporary Chromium profile owned by the chat's
Browser Session Host.

- **Done** preserves the process, profile, cookies, tabs, and current URL; the
  active page is reloaded once to clear transient credential fields.
- **Cancel browser session** destroys Chromium/MCP, closes the proxy, deletes
  the temporary profile, revokes all tokens, and emits `browser_closed`.
- Stop, service shutdown, or an expired disconnected handoff also destroys the
  session.
- There is no cookie export, import, serialization, or browser-to-browser sync.

The UI must display this warning before handoff:

> This is an isolated browser. Existing logins and cookies from your personal
> browser are not shared. Sign in again only if you trust this session.

Manual OTP entry is supported. Local passkeys, security keys, platform
biometrics, and personal-browser password-manager autofill are outside v1;
supporting them requires an explicit credential-device bridging design.

## Timeout and Disconnect Policy

Recommended defaults:

- Idle timeout: 2 minutes.
- Hard timeout: 10 minutes.
- Warning: 60 seconds before expiry.
- Network disconnect grace period: 30 seconds.

Human activity resets only the idle timer, never the hard timer. During a
disconnect grace period the agent remains blocked. When a timeout or grace
period expires, close the complete browser session rather than automatically
returning an unattended authenticated browser to the agent.

## Agent Control Protocol

Extend the `/agent` JSON control plane with bounded messages. These messages
must not contain credentials or interactive input.

### Client to server

```ts
type BrowserHandoffRequest = {
  type: "browser_handoff_request";
  browserId: string;
};

type BrowserHandoffFinish = {
  type: "browser_handoff_finish";
  handoffId: string;
};

type BrowserHandoffCancel = {
  type: "browser_handoff_cancel";
  handoffId: string;
};
```

### Server to client

```ts
type BrowserHandoffReady = {
  type: "browser_handoff_ready";
  browserId: string;
  handoffId: string;
  token: string;
  expiresAt: number;
};

type BrowserHandoffState = {
  type: "browser_handoff_state";
  browserId: string;
  handoffId?: string;
  state: "pending" | "human_active" | "agent_active" | "closed";
  expiresAt?: number;
  hardExpiresAt?: number;
};
```

`browser_handoff_ready` is routed directly to an ephemeral handoff store. It is
never passed into chat entries, tool rows, browser snapshots, or persisted
state.

## User Interface

Extend the browser overlay with:

- **Take control** when a live browser exists and the agent is idle.
- A clear “Agent paused — you control this browser” banner.
- An idle/hard timeout countdown and one-minute warning.
- **Done — return to agent**.
- **Cancel browser session**, with confirmation that cookies and login state
  will be destroyed.
- A connection/reconnecting indicator during the short grace period.
- Reopen the hidden Browser View when the authenticated chat republishes a
  pending or active handoff state.
- After a full reload loses memory-only snapshots and credentials, show a
  recovery view from the authoritative handoff state. An active lease still
  exposes **Done** and **Cancel**; a pending lease exposes **Cancel** so the
  user is never instructed to select a control that is absent.
- The isolated-browser warning before the first handoff.

Keep xterm mounted beneath the overlay and move focus away from its hidden
textarea. Interactive frames and tokens belong in a new non-persisted Zustand
store; do not extend the persisted Agent Chat store with handoff data.
Countdowns use the server's `expiresAt` and `hardExpiresAt`; reconnecting must
not invent fresh client-side deadlines.

## Suggested Code Boundaries

Backend:

- `browser-session-host.ts`: Chromium/profile/proxy lifecycle.
- `browser-control-lease.ts`: exclusive state machine and transitions.
- `browser-runtime.ts`: agent-only adapter using the host.
- `browser-handoff-broker.ts`: handoff WebSocket, frame/input adapter.
- `browser-handoff-tokens.ts`: one-time token ownership and expiry.

Frontend:

- `features/browser-handoff/store.ts`: ephemeral handoff state.
- `features/browser-handoff/connection.ts`: dedicated WebSocket protocol.
- `features/browser-handoff/components/interactive-browser.tsx`: bounded
  canvas/video and input capture.
- Extend `browser-view-overlay.tsx` with handoff actions and state banners.

Shared contracts belong in `@sparklab/shared-types`; all inbound messages must
use strict Zod schemas with `additionalProperties: false` semantics.

## Agent-Initiated and Manual Handoffs

V1 supports both the manual **Take control** action and the
`browser_request_handoff` agent tool. The tool is available only for an already
running isolated browser, requires explicit one-time approval, and returns only
a fixed status; typed values and handoff frames never enter the tool result.
If that browser already has a pending or active handoff, the same tool reopens
the existing view without replacing its session. The model is instructed to
stop browser actions after requesting handoff.

If a manual handoff finishes while no agent turn is waiting, returning control
only re-enables tools. The user sends the next instruction explicitly; the
system must not manufacture a user message.

## Test Plan

### Unit tests

- Valid and invalid lease transitions.
- Agent tools rejected during `HUMAN_ACTIVE`.
- Human input rejected outside `HUMAN_ACTIVE`.
- Token ownership, expiry, one-time use, and replay prevention.
- Idle, hard, warning, and disconnect timers.
- Bounded input/frame validation and rate limiting.
- Snapshot, DOM-index, and token stores remain non-persistent.

### Security tests

- A password and OTP sentinel never appears in JSONL history, OpenAI requests,
  logs, tool results, errors, telemetry, or `/agent` frames.
- Cross-chat, cross-browser, and cross-user handoff attempts fail.
- Forbidden Origin and unauthenticated WebSocket attempts fail.
- Raw MCP/CDP commands and cookie access are not representable by the protocol.
- OAuth query/fragment values are absent from logs and app chrome.
- Cancel/timeout kills the process group and removes the profile.

### Integration and E2E tests

- Use a fake login page with password and OTP fields.
- Agent navigates to login, then the user takes control.
- User enters sentinels and completes authentication.
- Done returns the same browser/profile to the agent.
- The agent sees the authenticated page but not either sentinel.
- Cookies persist through Done and disappear after Cancel.
- Disconnect grace permits a short reconnect but destroys the session on
  expiry.
- Personal-browser cookies are never imported into the isolated profile.
- A production/manual E2E uses a fresh temporary terminal/chat, approves both
  browser navigation and handoff, clicks a known synthetic input, compares
  ephemeral frame hashes, cancels the browser, and deletes only the exact
  test-created terminal. It must not reuse an active user handoff or persist
  screenshots. The repeatable procedure and 2026-07-27 baseline are in the
  operations runbook.

## Delivery Phases

1. Extract Browser Session Host and implement the exclusive control lease.
2. Add handoff control messages, token manager, and ephemeral frontend store.
3. Add bounded interactive streaming/input without clipboard support.
4. Add timeout, reconnect grace, cancellation, and UI warnings.
5. Add secret-sentinel security tests and full fake-login E2E coverage.
6. Consider agent-initiated paused handoffs, clipboard consent, and supported
   MFA extensions only after the v1 security invariants are proven.
