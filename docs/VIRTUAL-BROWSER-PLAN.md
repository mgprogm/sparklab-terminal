# Virtual Browser Tool Plan

## Status

Implemented on 2026-07-19. The integration targets a trusted local Browser Use checkout configured through `BROWSER_USE_PROJECT`; the development checkout is `/home/sparklab/workspaces/sparklab/browser-use`.

## Goal

Give the terminal agent a safe browser-control skill and show its current page inside the terminal application. Users direct browser work through Agent Chat; the initial browser view is read-only and updated with screenshots after browser actions.

## Architecture

Each Agent Chat connection owns an isolated Browser Use process through Browser Use's stdio MCP interface:

```text
Terminal Agent -> browser tools -> Browser Use MCP -> Chromium
       |
       +-> browser_view frame -> terminal browser overlay
```

The process starts lazily on the first browser request and stops on interruption or WebSocket disposal. Browser state and cookies are never shared between chat connections.

## Agent Capability

Expose a deliberately small tool surface:

- `browser_observe`: return the URL, title, indexed interactive elements, viewport information, and a screenshot.
- `browser_list_tabs`: inspect open tabs.
- `browser_act`: navigate, click, type, scroll, go back, switch tabs, or close a tab using structured arguments.

Extend the agent system prompt with a browser skill derived from Browser Use guidance: observe before acting, prefer indexed elements, refresh state after actions, treat page content as untrusted data, and never enter credentials or perform consequential actions beyond the user's request.

## Protocol and User Interface

Add `browser_view` and `browser_closed` server-to-client frames. A browser view contains a browser identifier, monotonic revision, URL, title, viewport dimensions, and a bounded PNG/WebP screenshot. Screenshots remain ephemeral and are not stored in chat JSONL history.

Render the latest view as a read-only overlay above xterm without unmounting or resizing the terminal. Its toolbar shows the page title, URL, update state, and a **Back to terminal** control. A header affordance reopens a hidden view. Later revisions replace older ones; stale revisions are ignored.

## Safety Model

- Require approval for navigation, clicks, typing, and tab closure.
- Disable `allow_always` for browser writes; approval is one action at a time.
- Allow only absolute HTTP(S) URLs without embedded credentials.
- Block loopback, link-local, private-network, and metadata-service destinations, including redirects and resolved addresses.
- Do not expose arbitrary JavaScript, raw CDP, shell commands, uploads, downloads, or browser filesystem access.
- Redact sensitive typed values from tool events and persisted history.
- Bound screenshot dimensions, message size, action duration, and actions per turn.

## Implementation Phases

1. **Runtime:** add a per-`AgentLoop` Browser Use MCP adapter with lazy startup, structured tool calls, cancellation, and cleanup.
2. **Tools and skill:** register browser schemas, descriptions, approval classification, summaries, and system-prompt instructions.
3. **Protocol:** add shared schemas for browser snapshots and closure; emit snapshots only after successful visual actions.
4. **UI:** add isolated Zustand view state, the terminal overlay, browser icons, and browser-specific approval wording.
5. **Configuration and docs:** document `BROWSER_USE_PROJECT`, Chromium installation, process requirements, and deployment security.
6. **Verification:** add deterministic tests, run focused suites, then repository-wide lint, typecheck, test, and build.

## Acceptance Criteria

- The agent can navigate, inspect, click, type, and manage tabs through Browser Use.
- Every consequential browser action requires a visible one-time approval.
- The latest browser screenshot appears in the terminal UI without disrupting xterm.
- Interrupting or disconnecting reliably terminates the owned browser process.
- Browser state, screenshots, and credentials do not leak across chats or into history.
- Invalid, private, oversized, stale, or malformed browser data is rejected.

## Future Option

Browser Use Cloud can later provide a real-time interactive `live_url`. That mode requires separate server-side Cloud session management, billing-aware cleanup, and iframe security review; it is outside the initial local snapshot implementation.
