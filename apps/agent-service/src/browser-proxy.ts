import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import {
  type BrowserHostResolver,
  resolvePublicBrowserHost,
  validateBrowserDestination,
} from "./browser-security.js";

/**
 * A forward proxy that resolves and checks every browser request before
 * connecting by the checked IP. Binds loopback by default (the browser path);
 * `start(bindHost)` can bind it elsewhere so a container can reach it (CUA
 * proxied-browsing, M3.5) — the public-only ruleset is identical either way.
 */
export class SafeBrowserProxy {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private boundPort: number | null = null;

  constructor(
    private readonly resolveHost: BrowserHostResolver = resolvePublicBrowserHost,
  ) {}

  /** The bound TCP port. Throws before `start()` / after `close()`. */
  get port(): number {
    if (this.boundPort === null) throw new Error("browser proxy not started");
    return this.boundPort;
  }

  /**
   * Start listening. `bindHost` defaults to loopback — the browser path calls
   * `start()` with no argument and its behaviour is unchanged. A caller that
   * binds a non-loopback host (e.g. `0.0.0.0` so a Docker container can dial
   * the bridge gateway) should compose the address it hands out from `.port`
   * plus a host the peer can route to; the returned URL still resolves to
   * loopback for a same-host caller.
   */
  async start(bindHost = "127.0.0.1"): Promise<string> {
    if (this.server) throw new Error("browser proxy already started");
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const { url, addresses } = await validateBrowserDestination(
            req.url ?? "",
            this.resolveHost,
          );
          const [address] = addresses;
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
          const { addresses } = await validateBrowserDestination(
            `https://${urlHost}${port === 443 ? "" : `:${port}`}`,
            this.resolveHost,
          );
          const [address] = addresses;
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
      server.listen(0, bindHost, resolve);
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("browser proxy did not bind TCP");
    this.boundPort = address.port;
    const urlHost =
      bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
    return `http://${urlHost}:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
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
