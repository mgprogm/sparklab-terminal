#!/usr/bin/env bash
set -euo pipefail

chromium --version >/dev/null
test -u /usr/lib/chromium/chrome-sandbox
ffmpeg -hide_banner -encoders 2>/dev/null \
  | grep -E '[[:space:]]libvpx[[:space:]]' >/dev/null
uv --version >/dev/null
gst-inspect-1.0 webrtcbin >/dev/null
gst-inspect-1.0 nice >/dev/null
gst-inspect-1.0 vp8enc >/dev/null
gst-inspect-1.0 rtpvp8pay >/dev/null
gst-inspect-1.0 ximagesrc >/dev/null

python3 - <<'PY'
import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstWebRTC", "1.0")
from gi.repository import Gst, GstWebRTC  # noqa: F401, E402

Gst.init(None)
assert Gst.ElementFactory.find("webrtcbin") is not None
PY
