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

const wss = new WebSocketServer({ noServer: true });

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

  ws.on("message", (data) => {
    if (ready) route(data);
    else pending.push(data);
  });
  ws.on("close", () => loop?.dispose());
  ws.on("error", () => loop?.dispose());

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
    await loop.init();

    ready = true;
    for (const d of pending) route(d);
    pending.length = 0;
  })();
});

function safeSend(ws: WebSocket, frame: AgentWsServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

server.listen(config.port, () => {
  console.log(
    `[agent] listening on :${config.port} — gateway ${config.gatewayUrl}, model ${config.azure.deployment}`,
  );
});
