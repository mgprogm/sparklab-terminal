// Frontend: xterm.js terminal wired to the /attach WebSocket.
//
// Raw bytes both ways. Server binary frames -> term.write(Uint8Array);
// keystrokes -> ws.send(binary). Reconnect with exponential backoff, and on
// every (re)connect we reset the terminal BEFORE the fresh attach redraw so the
// server's redraw never stacks on stale content.

const SESSION = 'web-main';
const HEARTBEAT_MS = 25000;
const BACKOFF = [1000, 2000, 4000, 8000, 15000];

const term = new Terminal({
  cursorBlink: true,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  scrollback: 10000,
  theme: { background: '#1e1e1e' },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById('term'));

// WebGL can throw in headless / no-GPU contexts; never let it kill the terminal.
try {
  term.loadAddon(new WebglAddon.WebglAddon());
} catch (e) {
  console.warn('WebGL addon unavailable, falling back to canvas/DOM renderer', e);
}

fitAddon.fit();

// ---- Status indicator ----
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
function setStatus(state, text) {
  dot.className = state;
  statusText.textContent = text;
}

// ---- Connection state ----
let ws = null;
let attempt = 0;
let freshConnect = false; // true until the first bytes of a (re)attach arrive
let heartbeatTimer = null;
let gotActivity = false;

function sendResize() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // If nothing arrived since the last tick, the link is likely dead: force a
    // close to trigger reconnect. Otherwise ping to keep idle proxies alive.
    if (!gotActivity) {
      ws.close();
      return;
    }
    gotActivity = false;
    ws.send(JSON.stringify({ type: 'ping' }));
  }, HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/attach?session=${encodeURIComponent(SESSION)}`;
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer'; // else binary frames arrive as Blob
  freshConnect = true;

  setStatus(attempt === 0 ? 'reconnecting' : 'reconnecting', attempt === 0 ? 'connecting…' : 'reconnecting…');

  ws.onopen = () => {
    attempt = 0;
    gotActivity = true;
    setStatus('connected', 'connected');
    sendResize(); // tell tmux our size immediately
    startHeartbeat();
  };

  ws.onmessage = (ev) => {
    gotActivity = true;
    if (typeof ev.data === 'string') {
      // JSON control message from server.
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'exit') {
        term.write(`\r\n[process exited with code ${msg.code}]\r\n`);
      }
      // pong: nothing to do, activity already recorded.
      return;
    }
    // Binary: raw pty output.
    if (freshConnect) {
      // First bytes after (re)connect are the fresh attach redraw. Clear stale
      // content so the redraw doesn't stack on top of it.
      term.reset();
      freshConnect = false;
    }
    term.write(new Uint8Array(ev.data));
  };

  ws.onclose = () => {
    stopHeartbeat();
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose will follow; avoid double-scheduling.
    try { ws.close(); } catch {}
  };
}

function scheduleReconnect() {
  const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
  attempt += 1;
  setStatus('reconnecting', `reconnecting in ${Math.round(delay / 1000)}s…`);
  setTimeout(connect, delay);
}

// ---- Terminal -> server ----
term.onData((data) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // xterm gives a string; encode to raw UTF-8 bytes and send as binary.
    ws.send(new TextEncoder().encode(data));
  }
});

// ---- Resize handling ----
term.onResize(() => sendResize());
const ro = new ResizeObserver(() => {
  try { fitAddon.fit(); } catch {}
});
ro.observe(document.getElementById('term'));
window.addEventListener('resize', () => {
  try { fitAddon.fit(); } catch {}
});

connect();
