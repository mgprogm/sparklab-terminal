import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import test from "node:test";
import { SafeBrowserProxy } from "./browser-proxy.js";

test("HTTP requests connect to the address returned by one validation lookup", async (t) => {
  const upstream = createHttpServer();
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  );
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");
  upstream.on("request", (req, res) => {
    assert.equal(req.headers.host, `example.test:${upstreamAddress.port}`);
    res.end("proxied");
  });

  let lookups = 0;
  const proxy = new SafeBrowserProxy(async (hostname) => {
    lookups += 1;
    assert.equal(hostname, "example.test");
    return ["127.0.0.1"];
  });
  const proxyUrl = new URL(await proxy.start());
  t.after(() => proxy.close());

  const body = await new Promise<string>((resolve, reject) => {
    const req = request(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port,
        path: `http://example.test:${upstreamAddress.port}/resource`,
      },
      (res) => {
        let value = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (value += chunk));
        res.on("end", () => resolve(value));
      },
    );
    req.on("error", reject);
    req.end();
  });

  assert.equal(body, "proxied");
  assert.equal(lookups, 1);
});

test("CONNECT tunnels use the address returned by one validation lookup", async (t) => {
  const upstream = createTcpServer((socket) => socket.end("tunneled"));
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => upstream.close(() => resolve())),
  );
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress !== "string");

  let lookups = 0;
  const proxy = new SafeBrowserProxy(async (hostname) => {
    lookups += 1;
    assert.equal(hostname, "example.test");
    return ["127.0.0.1"];
  });
  const proxyUrl = new URL(await proxy.start());
  t.after(() => proxy.close());

  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(proxyUrl.port), proxyUrl.hostname);
    let value = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `CONNECT example.test:${upstreamAddress.port} HTTP/1.1\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => (value += chunk));
    socket.on("end", () => resolve(value));
    socket.on("error", reject);
  });

  assert.match(
    response,
    /^HTTP\/1\.1 200 Connection Established\r\n\r\ntunneled$/,
  );
  assert.equal(lookups, 1);
});
