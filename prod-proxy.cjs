/**
 * Single-origin reverse proxy for the *local production* stack.
 *
 * Fronts all three services on ONE host/port so a single public tunnel
 * (loclx) serves everything from one origin. That is what keeps the
 * `gw_session` cookie first-party: the browser sends it to the gateway
 * (/attach, /api/*) AND the agent (/agent) because they share the origin.
 * Splitting them across separate subdomains breaks the agent's cookie auth
 * (host-only cookie never reaches the agent host) — see docs/LOCAL-PROD.md.
 *
 * Zero dependencies (node http + net). Routes by path prefix:
 *   /attach, /api/*  -> gateway  (127.0.0.1:3107)
 *   /agent           -> agent    (127.0.0.1:3109)
 *   everything else  -> terminal (127.0.0.1:3100)
 *
 * WebSocket upgrades (/attach, /agent) are proxied by piping raw sockets.
 */
const http = require("node:http");
const net = require("node:net");

const PORT = Number(process.env.PROXY_PORT || 3110);
const HOST = process.env.PROXY_HOST || "127.0.0.1";

const GATEWAY = {
  host: "127.0.0.1",
  port: Number(process.env.GATEWAY_PORT || 3107),
};
const AGENT = {
  host: "127.0.0.1",
  port: Number(process.env.AGENT_PORT || 3109),
};
const TERMINAL = {
  host: "127.0.0.1",
  port: Number(process.env.TERMINAL_PORT || 3100),
};

function route(url) {
  const path = (url || "/").split("?")[0];
  if (path === "/attach" || path.startsWith("/attach/")) return GATEWAY;
  if (path === "/api" || path.startsWith("/api/")) return GATEWAY;
  if (path === "/agent" || path.startsWith("/agent/")) return AGENT;
  return TERMINAL;
}

const server = http.createServer((req, res) => {
  const target = route(req.url);
  const proxyReq = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad gateway: " + err.message);
  });
  req.pipe(proxyReq);
});

// WebSocket / HTTP upgrade proxying — reconstruct the request and pipe sockets.
server.on("upgrade", (req, socket, head) => {
  const target = route(req.url);
  const upstream = net.connect(target.port, target.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push("", "");
    upstream.write(lines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[prod-proxy] http://${HOST}:${PORT} → term:${TERMINAL.port} · gw:${GATEWAY.port} (/attach,/api) · agent:${AGENT.port} (/agent)`,
  );
});
