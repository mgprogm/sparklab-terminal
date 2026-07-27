# ADR: Browser Handoff WebRTC Migration

Status: **Foundation implemented; media provider blocked** (2026-07-27)

## Decision

Keep `/browser-handoff` as the authenticated control channel and preserve the
current bounded JPEG binary stream as the default and automatic fallback. Add a
strict versioned WebRTC signaling protocol and browser receiver behind
`BROWSER_HANDOFF_TRANSPORT`, but do not advertise WebRTC until agent-service has
a production media provider.

Mouse, keyboard, resize, heartbeat, Done, Cancel, timeout, and reconnect remain
on the existing WebSocket. A DataChannel does not improve the current security
boundary and would couple input availability to ICE negotiation, so it is not
part of this phase.

The default is `BROWSER_HANDOFF_TRANSPORT=jpeg`. Setting
`webrtc-preferred` with this revision records a bounded
`media_provider_unavailable` fallback and continues over JPEG. Rollback is the
single env change back to `jpeg`; old clients continue to ignore new text
control frames and consume the same binary JPEG frames.

## Verified Current Runtime

- `BrowserSessionHost` launches isolated Chromium and obtains page pixels from
  CDP `Page.startScreencast`, which supports JPEG/PNG rather than a video track.
- agent-service runs Node 24 with `ws`; Node exposes no `RTCPeerConnection`,
  `MediaStream`, or `VideoEncoder`, and the lockfile contains no WebRTC stack.
- The default Docker target remains small. The optional `browser-runtime`
  target installs and build-verifies Chromium, its sandbox, Xvfb, FFmpeg, pinned
  uv, GStreamer WebRTC/VP8 plugins, and libnice. It runs non-root with no Linux
  capabilities and no privilege escalation.
- No application provider (`wrtc`, `werift`, `node-datachannel`, media server,
  or GStreamer adapter) is present. Native GStreamer is deliberately not
  advertised as usable WebRTC until an adapter owns its lifecycle and a real
  media E2E proves ICE/DTLS/SRTP, congestion response, and cleanup.

## Capture and Codec Evaluation

| Option                                                       | Result                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| CDP screencast                                               | Safe existing fallback, but produces JPEG/PNG only and cannot supply VP8/H.264 RTP directly.                                   |
| JPEG into an internal Chromium canvas plus `captureStream()` | Re-encodes JPEG, adds another privileged page/CDP surface, and does not remove the main capture cost; rejected for production. |
| Virtual display/raw window capture plus FFmpeg               | Can encode VP8/H.264, but FFmpeg alone lacks the complete WebRTC peer stack; viable only with a reviewed provider.             |
| Headed Chromium `getDisplayMedia()`                          | Requires display-selection/permission bypass and fragile window targeting; rejected for unattended production.                 |

For the provider phase, VP8 is the baseline because it avoids H.264 profile and
licensing ambiguity and has broad WebRTC browser support. H.264 may be offered
after runtime codec/profile negotiation and license review. The provider must
support RTCP feedback, congestion control, and actual bitrate/FPS/resolution
controls; configuration knobs unsupported by the selected library must not be
invented.

## Protocol Foundation

All signaling is strict JSON on the already authenticated socket:

- client `capabilities`: protocol version, supported transports/codecs, trickle
  ICE support;
- server `transport_capabilities`: available/preferred transports, bounded ICE
  configuration, negotiation deadline;
- server `webrtc_offer`, client `webrtc_answer`;
- bidirectional `webrtc_ice_candidate`, bounded and order-tolerant;
- server `transport_state` for negotiating/connected/failed/fallback/closed;
- client `transport_fallback` and non-activity heartbeat/ack.

SDP is limited to 64 KiB, candidates to 4 KiB, ICE servers to eight, and early
candidates to four negotiations with 64 candidates each. SDP, candidates, TURN
credentials, tokens, page URLs, and frame bodies are never logged or persisted.
One-time and resume-token authentication is unchanged and still precedes every
signaling message.

TURN configuration uses coturn REST credentials generated with a server-only
shared secret. Credentials are scoped to an opaque handoff digest and expire in
at most one hour (ten minutes by default). Static TURN username/password values
and `NEXT_PUBLIC_*` TURN secrets are prohibited.

## Resource and Operational Controls

- `MAX_BROWSER_SESSIONS` bounds Chromium trees.
- `MAX_BROWSER_LAUNCHES` serializes CPU/memory-heavy startup.
- `MAX_AGENT_CONNECTIONS` and `MAX_HANDOFF_CONNECTIONS` bound WebSockets.
- `MAX_WEBRTC_PEERS` is enforced by the transport state machine/provider seam.
- `/health` exposes aggregate metadata only: active sessions/launches/handoffs,
  active peers, fallback/failure counts, dropped frames, and cleanup reasons.
  It reports `mediaProviderAvailable=false` until the provider exists.
- Production rejects missing or foreign Origin headers. Missing Origin remains
  possible only through explicit development configuration.

## Required Provider Contract and Next Phases

1. Select and security-review a maintained provider with a license compatible
   with deployment. Pin its exact version and native/system packages.
2. Implement a raw capture path in the verified browser-enabled image, isolated
   from the public protocol. The provider owns ICE/DTLS/SRTP and exposes only
   bounded offer/answer/candidate/state callbacks to the broker.
3. Advertise `webrtc` only when provider readiness and peer capacity pass.
   During negotiation continue the JPEG stream; stop it only after WebRTC is
   connected, and restart it on ICE/peer failure.
4. Wire provider-supported RTCP/congestion statistics to bitrate, FPS, and
   resolution adaptation. Record only aggregate timing/state metadata.
5. Add fake-login E2E for real media success, forced TURN/ICE failure fallback,
   reconnect, Done/Cancel, cookie persistence, and secret sentinels before a
   production canary.

The repository currently tests protocol parsing, state/auth/origin/resource
limits, signaling order, heartbeat, cleanup, and fallback. A real WebRTC media
success E2E is intentionally not claimed until step 1 supplies the missing
provider.
