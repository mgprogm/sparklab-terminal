import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import test from "node:test";

// M3.5 — opt-in proxied browsing. This file boots config with
// CUA_PROXY_BROWSING=true (and NO egress network, so config load succeeds) and
// binds the per-runtime proxy to loopback so CI never opens a listener on every
// interface.
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_API_KEY ??= "test-key";
process.env.GPT56SOL_DEPLOYMENT ??= "test-deployment";
process.env.CUA_ENABLED = "true";
process.env.CUA_INSTANCE_ID = "proxyinst";
process.env.CUA_PROXY_BROWSING = "true";
process.env.CUA_PROXY_BIND_HOST = "127.0.0.1";
delete process.env.CUA_EGRESS_NETWORK;

const { ComputerRuntime } = await import("./computer-runtime.js");
const { config } = await import("./config.js");

test("config exposes the M3.5 proxy knobs with their defaults", () => {
  assert.equal(config.cua.proxyBrowsing, true);
  assert.equal(config.cua.proxyBindHost, "127.0.0.1"); // overridden for CI
  assert.equal(config.cua.proxyContainerHost, "host.docker.internal");
});

// ---- a compact fake docker/cua-driver spawn seam ----------------------------

const FAKE_PNG_B64 = Buffer.from("fake-png").toString("base64");

class FakeChild extends EventEmitter {
  pid = 5555;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    writable: true,
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        let msg: { id?: number; method?: string; params?: any };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id !== "number") continue;
        if (msg.method === "initialize") {
          this.#emit({ id: msg.id, result: { protocolVersion: "2025-06-18" } });
          continue;
        }
        if (msg.method !== "tools/call") continue;
        const name = msg.params?.name as string;
        const path = msg.params?.arguments?.screenshot_out_file ?? "/tmp/x.png";
        if (name === "get_desktop_state")
          this.#emit({
            id: msg.id,
            result: {
              content: [{ type: "text", text: `written to ${path}` }],
              structuredContent: { screen_width: 1024, screen_height: 768 },
            },
          });
        else if (name === "list_windows")
          this.#emit({
            id: msg.id,
            result: {
              content: [{ type: "text", text: "0 windows" }],
              structuredContent: { windows: [] },
            },
          });
        else
          this.#emit({
            id: msg.id,
            result: { content: [], structuredContent: { effect: "confirmed" } },
          });
      }
      return true;
    },
    end: () => {
      this.stdin.writable = false;
    },
  };
  kill() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
  #emit(obj: unknown) {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
  }
}

function fakeSpawn() {
  const calls: string[][] = [];
  const spawn = ((_bin: string, args: string[]) => {
    calls.push(args);
    const child = new FakeChild();
    const a = args;
    if (a[0] === "run" || a[0] === "rm" || a[0] === "ps") {
      queueMicrotask(() => {
        if (a[0] === "run")
          child.stdout.emit("data", Buffer.from("container-xyz\n"));
        child.emit("exit", 0, null);
      });
    } else if (a[0] === "exec") {
      let i = 1;
      while (i < a.length) {
        if (a[i] === "-i") i += 1;
        else if (a[i] === "-u" || a[i] === "-e") i += 2;
        else break;
      }
      const cmd = a[i + 1];
      if (cmd === "base64")
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from(FAKE_PNG_B64));
          child.emit("exit", 0, null);
        });
      else if (cmd === "sh" || cmd === "rm")
        queueMicrotask(() => child.emit("exit", 0, null));
      // cmd === "cua-driver" → long-lived MCP child, driven over stdin
    }
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn, calls };
}

test("start() with proxy-browsing: docker run carries --add-host + http_proxy env, no --network; policy written; proxy up then torn down", async () => {
  const { spawn, calls } = fakeSpawn();
  const rt = new ComputerRuntime(undefined, { label: "chat-proxy", spawn });

  await rt.observe();

  const run = calls.find((a) => a[0] === "run");
  assert.ok(run, "a docker run happened");

  // --add-host maps the container-visible proxy host to the bridge gateway.
  assert.ok(
    run.includes("--add-host=host.docker.internal:host-gateway"),
    "run args carry --add-host for host.docker.internal",
  );

  // http_proxy / https_proxy (both cases) point at host.docker.internal:<port>.
  const proxyEnv = run
    .map((tok, idx) => (run[idx - 1] === "-e" ? tok : ""))
    .filter((v) => /^https?_proxy=/i.test(v));
  assert.equal(proxyEnv.length, 4, "http(s)_proxy in both cases");
  for (const v of proxyEnv)
    assert.match(
      v,
      /^https?_proxy=http:\/\/host\.docker\.internal:\d+$/i,
      `${v} points at the container-visible proxy`,
    );
  const port = Number(/:(\d+)$/.exec(proxyEnv[0]!)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0);

  // no_proxy keeps the in-container X-readiness probe (127.0.0.1:<novncPort>)
  // off the proxy.
  const noProxy = run
    .map((tok, idx) => (run[idx - 1] === "-e" ? tok : ""))
    .filter((v) => /^no_proxy=/i.test(v));
  assert.equal(noProxy.length, 2);
  for (const v of noProxy)
    assert.equal(v, v.replace(/=.*/, "=127.0.0.1,localhost"));

  // proxied browsing and --internal are mutually exclusive — no --network here.
  assert.ok(!run.includes("--network"), "no --network in proxy-browsing mode");

  // The proxy is really listening on the reported port while the desktop runs.
  await new Promise<void>((resolve, reject) => {
    const s = connect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve();
    });
    s.on("error", reject);
  });

  // A Firefox enterprise policy write ran inside the container.
  const policyWrite = calls.find(
    (a) =>
      a[0] === "exec" &&
      a.includes("sh") &&
      a.some((t) => t.includes("policies.json")),
  );
  assert.ok(policyWrite, "writeFirefoxProxyPolicy ran a docker exec");
  assert.ok(
    policyWrite.some((t) => t.includes(`host.docker.internal:${port}`)),
    "the policy JSON carries the real proxy authority",
  );

  await rt.stop();

  // Torn down: the port no longer accepts connections.
  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const s = connect(port, "127.0.0.1");
        s.on("connect", () => {
          s.destroy();
          resolve();
        });
        s.on("error", reject);
      }),
    /ECONNREFUSED/,
    "the per-runtime proxy is closed on stop()",
  );
});
