// Frontend: multi-session xterm.js terminal (Phase 2).
//
// Raw bytes both ways. Server binary frames -> term.write(Uint8Array);
// keystrokes -> ws.send(binary). On every (re)connect we reset the terminal
// BEFORE the fresh attach redraw so the server's redraw never stacks on stale
// content.
//
// LIFECYCLE (the load-bearing part): all per-connection state lives on a
// Connection instance — its WebSocket, reconnect timer, heartbeat interval, and
// its attempt/freshConnect/gotActivity flags. Exactly ONE connection is live at
// a time. Switching sessions fully disposes the current connection before
// opening the next, so a backgrounded connection can never fire a stray
// reconnect that stomps the active one.
//
// Two paths can resurrect a dead connection, and dispose() must block BOTH:
//   1. dispose -> ws.close() -> onclose (fires async) -> scheduleReconnect
//   2. server {"type":"error"} on a deleted session -> close -> onclose -> loop
// A single `noReconnect` flag guards scheduleReconnect() and is set by both
// dispose() and receipt of an error frame.

const HEARTBEAT_MS = 25000;
const BACKOFF = [1000, 2000, 4000, 8000, 15000];
const POLL_MS = 3000;

// ---- The single, shared terminal ----
const term = new Terminal({
  cursorBlink: true,
  fontFamily: "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace",
  fontSize: 14,
  scrollback: 10000,
  // Warp-inspired warm-dark theme; off-white caret (no chromatic accent).
  theme: {
    background: '#2b2622',
    foreground: '#f7f5f0',
    cursor: '#f7f5f0',
    cursorAccent: '#2b2622',
    selectionBackground: '#4a443f',
  },
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

// ---- DOM refs ----
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const titleEl = document.getElementById('title');
const listEl = document.getElementById('session-list');
const emptyState = document.getElementById('empty-state');
const termWrap = document.getElementById('term-wrap');

function setStatus(state, text) {
  dot.className = state;
  statusText.textContent = text;
}

// ---- Active connection (exactly one at a time) ----
let activeConnection = null; // Connection instance or null
let activeSessionId = null; // id of the session we are showing

// A single Connection owns one WebSocket's whole lifetime.
class Connection {
  constructor(sessionId, { onStatus } = {}) {
    this.sessionId = sessionId;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.attempt = 0;
    this.freshConnect = false; // true until the first bytes of a (re)attach arrive
    this.gotActivity = false;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.noReconnect = false; // once true, nothing may call connect() again
  }

  connect() {
    if (this.noReconnect) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/attach?session=${encodeURIComponent(this.sessionId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer'; // else binary frames arrive as Blob
    this.ws = ws;
    this.freshConnect = true;

    this.onStatus('reconnecting', this.attempt === 0 ? 'connecting…' : 'reconnecting…');

    ws.onopen = () => {
      if (this.ws !== ws) return; // superseded
      this.attempt = 0;
      this.gotActivity = true;
      this.onStatus('connected', 'connected');
      this.sendResize();
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.gotActivity = true;
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'error') {
          // Server refused this session (bad prefix / deleted). Do NOT reconnect
          // in a loop — this session is gone. Stop the lifecycle here.
          this.noReconnect = true;
          this.onStatus('disconnected', msg.message || 'session unavailable');
          term.write(`\r\n[${msg.message || 'session unavailable'}]\r\n`);
          this.dispose();
          // Refresh the list so a deleted/invalid session drops out of the UI.
          refreshSessions();
          return;
        }
        if (msg.type === 'exit') {
          term.write(`\r\n[process exited with code ${msg.code}]\r\n`);
        }
        // pong: nothing to do, activity already recorded.
        return;
      }
      // Binary: raw pty output.
      if (this.freshConnect) {
        // First bytes after (re)connect are the fresh attach redraw. Clear stale
        // content so the redraw doesn't stack on top of it.
        term.reset();
        this.freshConnect = false;
      }
      term.write(new Uint8Array(ev.data));
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // a superseded socket closing: ignore
      this.stopHeartbeat();
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      // onclose will follow; avoid double-scheduling.
      try { ws.close(); } catch {}
    };
  }

  scheduleReconnect() {
    if (this.noReconnect) return; // disposed or fatal error: never resurrect
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    this.onStatus('reconnecting', `reconnecting in ${Math.round(delay / 1000)}s…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // If nothing arrived since the last tick, the link is likely dead: force a
      // close to trigger reconnect. Otherwise ping to keep idle proxies alive.
      if (!this.gotActivity) {
        ws.close();
        return;
      }
      this.gotActivity = false;
      ws.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  sendResize() {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }

  send(payload) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }

  // Cancel EVERYTHING: block future reconnects, clear the reconnect timer, clear
  // the heartbeat interval, detach handlers, and close the ws. After this no
  // path can call connect() again.
  dispose() {
    this.noReconnect = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null; // guards in the async onclose/onopen see the supersession
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch {}
    }
  }
}

// ---- Switching sessions ----
function switchTo(sessionId) {
  // Fully dispose the current connection before opening the next.
  if (activeConnection) {
    activeConnection.dispose();
    activeConnection = null;
  }
  activeSessionId = sessionId;

  if (!sessionId) {
    // Empty state.
    termWrap.classList.add('hidden');
    emptyState.style.display = '';
    titleEl.textContent = 'no session';
    titleEl.classList.add('none');
    setStatus('disconnected', 'idle');
    renderList();
    return;
  }

  emptyState.style.display = 'none';
  termWrap.classList.remove('hidden');
  term.reset();
  try { fitAddon.fit(); } catch {}

  const meta = sessions.find((s) => s.id === sessionId);
  titleEl.textContent = meta ? meta.name : sessionId;
  titleEl.classList.remove('none');

  activeConnection = new Connection(sessionId, { onStatus: setStatus });
  activeConnection.connect();
  renderList();
}

// ---- Terminal -> active connection ----
term.onData((data) => {
  if (activeConnection) {
    // xterm gives a string; encode to raw UTF-8 bytes and send as binary.
    activeConnection.send(new TextEncoder().encode(data));
  }
});

term.onResize(() => {
  if (activeConnection) activeConnection.sendResize();
});

const ro = new ResizeObserver(() => {
  try { fitAddon.fit(); } catch {}
});
ro.observe(document.getElementById('term'));
window.addEventListener('resize', () => {
  try { fitAddon.fit(); } catch {}
});

// ---- Session list (REST) ----
let sessions = []; // [{ id, name, createdAt, currentCommand, attached }]

async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) return;
    sessions = await res.json();
  } catch {
    return;
  }
  // If the active session vanished (deleted elsewhere), fall back.
  if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
    if (sessions.length) switchTo(sessions[0].id);
    else switchTo(null);
    return;
  }
  // On first load with sessions but nothing selected, attach to the first.
  if (!activeSessionId && sessions.length) {
    switchTo(sessions[0].id);
    return;
  }
  if (!sessions.length && activeSessionId) {
    switchTo(null);
    return;
  }
  renderList();
}

// A command counts as "running a job" when the pane's foreground command is not
// a bare shell.
const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', '-bash', '-sh', '-zsh']);
function isRunning(cmd) {
  return cmd && !SHELLS.has(cmd);
}

function renderList() {
  listEl.textContent = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session' + (s.id === activeSessionId ? ' active' : '');
    li.dataset.id = s.id;
    li.title = s.name; // names are hidden in the collapsed rail — keep them on hover

    const runDot = document.createElement('span');
    runDot.className = 'run-dot' + (isRunning(s.currentCommand) ? ' running' : '') + (s.attached ? ' attached' : '');
    runDot.title = (isRunning(s.currentCommand) ? `running: ${s.currentCommand}` : 'idle shell') + (s.attached ? ' (attached)' : '');

    const meta = document.createElement('span');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const cmd = document.createElement('span');
    cmd.className = 'cmd';
    cmd.textContent = s.currentCommand || '';
    meta.append(name, cmd);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete session (kills the running job)';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteSession(s.id, s.name);
    });

    li.append(runDot, meta, del);
    li.addEventListener('click', () => {
      if (s.id !== activeSessionId) switchTo(s.id);
    });
    listEl.append(li);
  }
}

// ---- Modal (in-page replacement for native prompt/confirm/alert) ----
// One reusable dialog, one at a time. openModal resolves a Promise: text-input
// modals resolve to the string (or null on cancel), button-only modals resolve
// to true/false. Focusing the modal moves focus off xterm's textarea, so
// keystrokes go to the dialog; on close we hand focus back to the terminal.
const overlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalInput = document.getElementById('modal-input');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

function openModal({
  title = '', message = '', input = false, value = '', placeholder = '',
  confirmText = 'OK', cancelText = 'Cancel', danger = false, showCancel = true,
} = {}) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalMessage.style.display = message ? '' : 'none';
    modalInput.style.display = input ? '' : 'none';
    if (input) { modalInput.value = value; modalInput.placeholder = placeholder; }
    modalConfirm.textContent = confirmText;
    modalConfirm.className = danger ? 'btn-danger' : 'btn-primary';
    modalCancel.textContent = cancelText;
    modalCancel.style.display = showCancel ? '' : 'none';

    overlay.classList.remove('hidden');
    if (input) { modalInput.focus(); modalInput.select(); } else { modalConfirm.focus(); }

    function done(result) {
      overlay.classList.add('hidden');
      modalConfirm.removeEventListener('click', onConfirm);
      modalCancel.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onOverlayDown);
      document.removeEventListener('keydown', onKeydown, true);
      resolve(result);
      try { term.focus(); } catch {}
    }
    const onConfirm = () => done(input ? modalInput.value : true);
    const onCancel = () => done(input ? null : false);
    const onOverlayDown = (e) => { if (e.target === overlay) onCancel(); };
    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };

    modalConfirm.addEventListener('click', onConfirm);
    modalCancel.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onOverlayDown);
    document.addEventListener('keydown', onKeydown, true);
  });
}

const modalPrompt = (title, opts = {}) => openModal({ title, input: true, confirmText: 'Create', ...opts });
const modalConfirm2 = (title, message, opts = {}) =>
  openModal({ title, message, confirmText: 'Delete', danger: true, ...opts });
const modalAlert = (title, message) =>
  openModal({ title, message, confirmText: 'OK', showCancel: false });

// ---- Actions ----
async function createSession() {
  const name = await modalPrompt('New session', { placeholder: 'Session name (optional)' });
  if (name === null) return; // cancelled
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(name.trim() ? { name: name.trim() } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      await modalAlert('Create failed', String(err.error || res.status));
      return;
    }
    const created = await res.json();
    await refreshSessions();
    switchTo(created.id);
  } catch (e) {
    await modalAlert('Create failed', e.message);
  }
}

async function deleteSession(id, name) {
  const ok = await modalConfirm2('Delete session', `Delete "${name || id}"? This kills the running job.`);
  if (!ok) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      await modalAlert('Delete failed', String(err.error || res.status));
      return;
    }
  } catch (e) {
    await modalAlert('Delete failed', e.message);
    return;
  }
  if (id === activeSessionId) {
    // Dispose immediately so the doomed connection can't reconnect-loop. Leave
    // activeSessionId set so refreshSessions() sees it vanish from the list and
    // routes to another session or the empty state (don't null it here, or the
    // fall-through would leave a frozen terminal on the last delete).
    if (activeConnection) { activeConnection.dispose(); activeConnection = null; }
  }
  await refreshSessions();
}

document.getElementById('new-session').addEventListener('click', createSession);
document.getElementById('create-first').addEventListener('click', createSession);

// ---- Sidebar collapse/expand ----
// State persists across reloads. No manual refit: shrinking the sidebar grows
// #main -> #term, and the ResizeObserver on #term (above) refits xterm for us.
const appEl = document.getElementById('app');
const toggleBtn = document.getElementById('toggle-sidebar');
const toggleChev = toggleBtn.querySelector('.chev');

function setCollapsed(collapsed) {
  appEl.classList.toggle('collapsed', collapsed);
  toggleChev.textContent = collapsed ? '»' : '«';
  toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  toggleBtn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  toggleBtn.setAttribute('aria-label', toggleBtn.title);
  try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
}

toggleBtn.addEventListener('click', () => setCollapsed(!appEl.classList.contains('collapsed')));

let startCollapsed = false;
try { startCollapsed = localStorage.getItem('sidebarCollapsed') === '1'; } catch {}
setCollapsed(startCollapsed);

// ---- Poll ----
setInterval(refreshSessions, POLL_MS);
refreshSessions();
