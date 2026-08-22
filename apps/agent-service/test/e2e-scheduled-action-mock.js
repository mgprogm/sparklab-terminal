// Deterministic Agent Chat stand-in for Playwright. It exercises the real
// browser chat protocol and real gateway timer without depending on an LLM.
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3909;
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3907";
const wss = new WebSocketServer({ noServer: true });

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  res.writeHead(404).end();
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/agent") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, url.searchParams.get("terminalSessionId"));
  });
});

wss.on("connection", (ws, sessionId) => {
  const send = (frame) => ws.send(JSON.stringify(frame));
  send({ type: "chat_started", chatId: "e2e-scheduled-action" });
  let requestId;
  let executeAt;

  ws.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "ping") return send({ type: "pong" });
    if (message.type === "user_message") {
      requestId = "approve-scheduled-enter";
      executeAt = new Date(Date.now() + 1_200).toISOString();
      send({ type: "assistant_message", text: "I will schedule Enter." });
      send({
        type: "approval_request",
        requestId,
        tool: "schedule_terminal_action",
        sessionId,
        summary: `schedule Enter at ${executeAt}`,
        input: {
          session_id: sessionId,
          keys: ["Enter"],
          execute_at: executeAt,
        },
      });
      return;
    }
    if (
      message.type === "approval_response" &&
      message.requestId === requestId
    ) {
      const response = await fetch(`${GATEWAY_URL}/api/terminal-actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, keys: ["Enter"], executeAt }),
      });
      if (!response.ok) throw new Error(`schedule failed: ${response.status}`);
      send({
        type: "approval_resolved",
        requestId,
        behavior: message.behavior,
      });
      send({ type: "assistant_message", text: "Enter has been scheduled." });
    }
  });
});

server.listen(PORT, "127.0.0.1");
