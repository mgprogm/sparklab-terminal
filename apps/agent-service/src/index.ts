/**
 * Agent Chat service entrypoint.
 *
 * HTTP server + a WebSocket endpoint at /agent. On upgrade we mirror the
 * gateway's WS security posture: origin allowlist BEFORE the handshake, then
 * cookie auth AFTER (by proxying the browser's cookie to the gateway's
 * /api/auth/me). Each authenticated socket is then bound to its required
 * terminalSessionId before resolving that terminal's chat. Unauthorized
 * connections close with code 4001, which the frontend maps to "do not
 * reconnect" — the same contract the terminal uses.
 */
import { createServer } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  AgentWsClientMessageSchema,
  type AgentWsServerMessage,
} from "@sparklab/shared-types";
import { availableModels, DEFAULT_MODEL } from "./azure.js";
import { config } from "./config.js";
import { gateway } from "./gateway-client.js";
import { AgentRunManager, type AgentRun } from "./agent-run-manager.js";
import { BrowserHandoffBroker } from "./browser-handoff-broker.js";
import { deleteChat, listChats, openChat } from "./history.js";
import { browserResources } from "./browser-resource-limiter.js";
import { browserHandoffMetrics } from "./browser-handoff-transport.js";
import { browserPerformanceMetrics } from "./browser-performance-metrics.js";
import { isAllowedWebSocketOrigin } from "./agent-security.js";

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ready" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        ready: true,
        service: "agent-service",
        browserResources: browserResources.snapshot(),
        browserPerformance: browserPerformanceMetrics.snapshot(),
        browserHandoff: {
          configuredTransport: config.handoff.transport,
          mediaProviderAvailable: false,
          ...browserHandoffMetrics.snapshot(),
        },
      }),
    );
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
const handoffWss = new WebSocketServer({
  noServer: true,
  // A 64 KiB bounded SDP plus its typed JSON envelope must fit one frame.
  maxPayload: 72 * 1024,
});
const handoffs = new BrowserHandoffBroker();
const runs = new AgentRunManager(handoffs);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/agent" && url.pathname !== "/browser-handoff") {
    socket.destroy();
    return;
  }
  // Origin allowlist before the handshake (CSWSH guard). Missing Origin is
  // accepted only when explicitly configured (the default is development-only).
  const origin = req.headers.origin;
  if (
    !isAllowedWebSocketOrigin(
      origin,
      config.allowedOrigins,
      config.allowMissingOrigin,
    )
  ) {
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  const target = url.pathname === "/agent" ? wss : handoffWss;
  const connectionLimit =
    target === wss ? config.maxConnections : config.handoff.maxConnections;
  if (target.clients.size >= connectionLimit) {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  if (
    url.pathname === "/browser-handoff" &&
    !isSecureHandoff(
      req.headers.host,
      req.headers["x-forwarded-proto"],
      req.socket.remoteAddress,
    )
  ) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket, req) => {
  const send = (frame: AgentWsServerMessage) => safeSend(ws, frame);
  let run: AgentRun | null = null;
  let detachRun: (() => void) | null = null;
  let socketClosed = false;
  let connectedTerminalSessionId: string | undefined;
  let ready = false;
  // Messages can arrive before auth + loop.init() finish (the client sends on
  // WS open). Attach the listener SYNCHRONOUSLY and buffer until ready, or the
  // first user_message is silently dropped and the turn never starts.
  const pending: RawData[] = [];
  let pendingBytes = 0;

  const route = (data: RawData) => {
    if (!run) return;
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
        void run.handleUserMessage(
          msg.data.text,
          msg.data.activeSessionId,
          msg.data.model,
          msg.data.reasoningEffort,
        );
        break;
      case "approval_response":
        run.onApprovalResponse(msg.data.requestId, msg.data.behavior);
        break;
      case "interrupt":
        run.interrupt();
        break;
      case "recovery_ack":
        run.acknowledgeRecovery(msg.data.behavior);
        break;
      case "list_chats":
        void listChats(connectedTerminalSessionId).then((chats) =>
          send({ type: "chat_list", chats }),
        );
        break;
      case "delete_chat":
        if (runs.hasActiveRun(msg.data.chatId)) {
          send({
            type: "error",
            message: "Stop the active agent run before deleting this chat",
          });
          break;
        }
        void deleteChat(msg.data.chatId, connectedTerminalSessionId)
          .then(() => listChats(connectedTerminalSessionId))
          .then((chats) => send({ type: "chat_list", chats }))
          .catch((error: unknown) =>
            send({
              type: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Unable to delete chat",
            }),
          );
        break;
      case "browser_handoff_request":
        try {
          run.requestBrowserHandoff(msg.data.browserId);
        } catch (error) {
          send({
            type: "error",
            message:
              error instanceof Error ? error.message : "browser_handoff_failed",
          });
        }
        break;
      case "browser_handoff_finish":
        void run
          .finishBrowserHandoff(msg.data.handoffId)
          .catch(() =>
            send({ type: "error", message: "browser_handoff_failed" }),
          );
        break;
      case "browser_handoff_cancel":
        void run
          .cancelBrowserHandoff(msg.data.handoffId)
          .catch(() =>
            send({ type: "error", message: "browser_handoff_failed" }),
          );
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
  const detach = () => {
    socketClosed = true;
    detachRun?.();
    detachRun = null;
  };
  ws.on("close", detach);
  ws.on("error", detach);

  void (async () => {
    // Auth: proxy the browser's cookie to the gateway. 4001 = no-reconnect.
    let authed = false;
    let user = "";
    try {
      const identity = await gateway.verifyCookie(req.headers.cookie);
      authed = identity.ok;
      user = identity.username ?? "open-mode";
    } catch {
      authed = false;
    }
    if (!authed) {
      send({ type: "error", message: "unauthorized" });
      ws.close(4001, "unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const terminalSessionId = url.searchParams.get("terminalSessionId")?.trim();
    if (!terminalSessionId || terminalSessionId.length > 512) {
      send({ type: "error", message: "terminalSessionId is required" });
      ws.close(1008, "terminal session required");
      return;
    }
    connectedTerminalSessionId = terminalSessionId;
    const resumeChatId = url.searchParams.get("resumeChatId") || undefined;
    const forceNew = url.searchParams.get("newChat") === "1";
    let chatId: string;
    try {
      chatId = await openChat(terminalSessionId, resumeChatId, forceNew);
    } catch (error) {
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Unable to open chat",
      });
      ws.close(1008, "unable to open chat");
      return;
    }
    try {
      run = await runs.open(chatId, terminalSessionId, user);
      detachRun = await run.attach(send);
      if (socketClosed || ws.readyState !== ws.OPEN) {
        detachRun();
        detachRun = null;
        return;
      }
      send({
        type: "agent_capabilities",
        models: availableModels(),
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultModel: DEFAULT_MODEL,
        defaultReasoningEffort: "medium",
      });
    } catch (error) {
      send({
        type: "error",
        message:
          error instanceof Error ? error.message : "Unable to start agent run",
      });
      ws.close(1011, "unable to start agent run");
      return;
    }

    ready = true;
    for (const d of pending) route(d);
    pending.length = 0;
    pendingBytes = 0;
  })();
});

handoffWss.on("connection", (ws: WebSocket, req) => {
  let user = "";
  let handoffId = "";
  let ready = false;
  let pending: { data: RawData; binary: boolean } | null = null;
  let routeQueue = Promise.resolve();
  let queuedRoutes = 0;
  const authTimer = setTimeout(
    () => ws.close(4001, "handoff_auth_failed"),
    10_000,
  );
  authTimer.unref();

  const route = async (data: RawData, binary: boolean) => {
    if (binary) {
      ws.close(1003, "browser_input_invalid");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      ws.close(1008, "browser_input_invalid");
      return;
    }
    try {
      if (!handoffId) {
        // The broker validates both one-time auth and reconnect resume frames.
        // Bind this connection only after that validation succeeds.
        handoffId = await handoffs.accept(ws, user, parsed);
        clearTimeout(authTimer);
      } else {
        await handoffs.input(handoffId, parsed);
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "browser_handoff_failed";
      ws.close(1008, reason.slice(0, 123));
    }
  };
  const enqueueRoute = (data: RawData, binary: boolean) => {
    if (++queuedRoutes > 256) {
      ws.close(1009, "browser_input_rate_limited");
      return;
    }
    routeQueue = routeQueue
      .then(() => route(data, binary))
      .catch(() => ws.close(1011, "browser_handoff_failed"))
      .finally(() => {
        queuedRoutes--;
      });
  };
  ws.on("message", (data, binary) => {
    // Authentication and input must remain ordered. In particular, a click
    // arriving while Chromium activation is still awaiting must not be parsed
    // as a second first-frame credential and close the handoff.
    if (ready) enqueueRoute(data, binary);
    else if (!pending) pending = { data, binary };
    else ws.close(1009, "handoff_auth_failed");
  });
  ws.on("close", () => {
    clearTimeout(authTimer);
    if (handoffId) handoffs.disconnected(handoffId, ws);
  });
  ws.on("error", () => {
    if (handoffId) handoffs.disconnected(handoffId, ws);
  });
  void (async () => {
    try {
      const identity = await gateway.verifyCookie(req.headers.cookie);
      if (!identity.ok) throw new Error("handoff_auth_failed");
      if (ws.readyState !== ws.OPEN) throw new Error("handoff_auth_failed");
      user = identity.username ?? "open-mode";
      ready = true;
      const queued = pending as { data: RawData; binary: boolean } | null;
      if (queued) enqueueRoute(queued.data, queued.binary);
    } catch {
      ws.close(4001, "handoff_auth_failed");
    }
  })();
});

function safeSend(ws: WebSocket, frame: AgentWsServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  const payload = JSON.stringify(frame);
  if (Buffer.byteLength(payload) <= MAX_OUTBOUND_BYTES) ws.send(payload);
}

server.headersTimeout = 30_000;
server.requestTimeout = 60_000;
void runs
  .recover()
  .then(() => {
    server.listen(config.port, config.host, () => {
      console.log(
        `[agent] listening on ${config.host}:${config.port} — gateway ${config.gatewayUrl}, models ${availableModels().join(", ")}`,
      );
    });
  })
  .catch((error: unknown) => {
    console.error("[agent] FATAL: unable to recover durable runs", error);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (async () => {
      await runs.disposeAll();
      await handoffs.disposeAll();
      for (const client of wss.clients)
        client.close(1001, "service shutting down");
      for (const client of handoffWss.clients)
        client.close(1001, "service shutting down");
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    })();
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}

function isSecureHandoff(
  host: string | undefined,
  forwardedProto: string | string[] | undefined,
  remoteAddress: string | undefined,
): boolean {
  let hostname = "";
  try {
    hostname = new URL(`http://${host ?? "invalid"}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const proxyIsLoopback =
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  const localHost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto?.split(",", 1)[0]?.trim();
  return proxyIsLoopback && (localHost || proto === "https");
}
