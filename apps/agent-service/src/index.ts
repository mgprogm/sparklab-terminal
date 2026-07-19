/**
 * Agent Chat service entrypoint.
 *
 * HTTP server + a WebSocket endpoint at /agent. On upgrade we mirror the
 * gateway's WS security posture: origin allowlist BEFORE the handshake, then
 * cookie auth AFTER (by proxying the browser's cookie to the gateway's
 * /api/auth/me). Unauthorized connections close with code 4001, which the
 * frontend maps to "do not reconnect" — the same contract the terminal uses.
 */
import { createServer } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  AgentWsClientMessageSchema,
  type AgentWsServerMessage,
} from "@sparklab/shared-types";
import { config } from "./config.js";
import { gateway } from "./gateway-client.js";
import { AgentLoop } from "./agent-loop.js";
import { deleteChat, listChats } from "./history.js";

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agent-service" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const MAX_INBOUND_BYTES = 64 * 1024;
const MAX_PENDING_FRAMES = 32;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_OUTBOUND_BYTES = 3 * 1024 * 1024;
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_INBOUND_BYTES,
});
const loops = new Set<AgentLoop>();

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/agent") {
    socket.destroy();
    return;
  }
  // Origin allowlist before the handshake (CSWSH guard). An absent Origin
  // (non-browser client, e.g. the smoke test) is allowed, matching the gateway.
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.has(origin)) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket, req) => {
  const send = (frame: AgentWsServerMessage) => safeSend(ws, frame);
  let loop: AgentLoop | null = null;
  let ready = false;
  // Messages can arrive before auth + loop.init() finish (the client sends on
  // WS open). Attach the listener SYNCHRONOUSLY and buffer until ready, or the
  // first user_message is silently dropped and the turn never starts.
  const pending: RawData[] = [];
  let pendingBytes = 0;

  const route = (data: RawData) => {
    if (!loop) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return; // ignore non-JSON
    }
    const msg = AgentWsClientMessageSchema.safeParse(parsed);
    if (!msg.success) return; // ignore malformed frames
    switch (msg.data.type) {
      case "ping":
        send({ type: "pong" });
        break;
      case "user_message":
        void loop.handleUserMessage(msg.data.text, msg.data.activeSessionId);
        break;
      case "approval_response":
        loop.onApprovalResponse(msg.data.requestId, msg.data.behavior);
        break;
      case "interrupt":
        loop.interrupt();
        break;
      case "list_chats":
        void listChats().then((chats) => send({ type: "chat_list", chats }));
        break;
      case "delete_chat":
        void deleteChat(msg.data.chatId)
          .then(() => listChats())
          .then((chats) => send({ type: "chat_list", chats }));
        break;
    }
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, "JSON text frames only");
      return;
    }
    if (ready) route(data);
    else {
      const bytes = Buffer.byteLength(data.toString());
      if (
        pending.length >= MAX_PENDING_FRAMES ||
        pendingBytes + bytes > MAX_PENDING_BYTES
      ) {
        ws.close(1009, "too many messages before initialization");
        return;
      }
      pending.push(data);
      pendingBytes += bytes;
    }
  });
  const disposeLoop = () => {
    if (!loop) return;
    void loop.dispose();
    loops.delete(loop);
  };
  ws.on("close", disposeLoop);
  ws.on("error", disposeLoop);

  void (async () => {
    // Auth: proxy the browser's cookie to the gateway. 4001 = no-reconnect.
    let authed = false;
    try {
      authed = (await gateway.verifyCookie(req.headers.cookie)).ok;
    } catch {
      authed = false;
    }
    if (!authed) {
      send({ type: "error", message: "unauthorized" });
      ws.close(4001, "unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const resumeChatId = url.searchParams.get("resumeChatId") || undefined;
    loop = new AgentLoop(send, resumeChatId);
    loops.add(loop);
    await loop.init();

    ready = true;
    for (const d of pending) route(d);
    pending.length = 0;
    pendingBytes = 0;
  })();
});

function safeSend(ws: WebSocket, frame: AgentWsServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  const payload = JSON.stringify(frame);
  if (Buffer.byteLength(payload) <= MAX_OUTBOUND_BYTES) ws.send(payload);
}

server.listen(config.port, () => {
  console.log(
    `[agent] listening on :${config.port} — gateway ${config.gatewayUrl}, model ${config.azure.deployment}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await Promise.all([...loops].map((loop) => loop.dispose()));
      loops.clear();
      for (const client of wss.clients)
        client.close(1001, "service shutting down");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    })();
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}
