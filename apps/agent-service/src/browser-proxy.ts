import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import {
  resolvePublicBrowserHost,
  validateBrowserUrl,
} from "./browser-security.js";

/** A loopback forward proxy that resolves and checks every browser request before connecting by the checked IP. */
export class SafeBrowserProxy {
  private server: Server | null = null;
  private sockets = new Set<Socket>();

  async start(): Promise<string> {
    if (this.server) throw new Error("browser proxy already started");
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const url = await validateBrowserUrl(req.url ?? "");
          const [address] = await resolvePublicBrowserHost(url.hostname);
          if (!address) throw new Error("destination has no public address");
          const headers: Record<string, string | string[] | undefined> = {
            ...req.headers,
            host: url.host,
          };
          delete headers["proxy-authorization"];
          delete headers["proxy-connection"];
          const upstream = httpRequest(
            {
              host: address,
              family: address.includes(":") ? 6 : 4,
              port: url.port ? Number(url.port) : 80,
              method: req.method,
              path: `${url.pathname}${url.search}`,
              headers,
            },
            (upstreamResponse) => {
              res.writeHead(
                upstreamResponse.statusCode ?? 502,
                upstreamResponse.headers,
              );
              upstreamResponse.pipe(res);
            },
          );
          upstream.setTimeout(30_000, () =>
            upstream.destroy(new Error("proxy request timed out")),
          );
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          });
          req.pipe(upstream);
        } catch {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("blocked by browser network policy");
        }
      })();
    });
    server.on("connect", (req, clientSocket, head) => {
      void (async () => {
        try {
          const authority = req.url ?? "";
          const split = authority.lastIndexOf(":");
          const rawHost = split > 0 ? authority.slice(0, split) : authority;
          const host = rawHost.replace(/^\[|\]$/g, "");
          const port = split > 0 ? Number(authority.slice(split + 1)) : 443;
          if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error("invalid port");
          const urlHost = host.includes(":") ? `[${host}]` : host;
          await validateBrowserUrl(
            `https://${urlHost}${port === 443 ? "" : `:${port}`}`,
          );
          const [address] = await resolvePublicBrowserHost(host);
          if (!address) throw new Error("destination has no public address");
          const upstream = connect({
            host: address,
            port,
            family: address.includes(":") ? 6 : 4,
          });
          this.trackSocket(upstream);
          upstream.setTimeout(30_000, () => upstream.destroy());
          upstream.once("connect", () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
          });
          upstream.on("error", () => clientSocket.destroy());
        } catch {
          clientSocket.end(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
          );
        }
      })();
    });
    server.on("connection", (socket) => this.trackSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("browser proxy did not bind TCP");
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private trackSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => this.sockets.delete(socket));
  }
}
