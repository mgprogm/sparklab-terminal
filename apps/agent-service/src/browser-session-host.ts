import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { BrowserHandoffInput } from "@sparklab/shared-types";
import { config } from "./config.js";
import { SafeBrowserProxy } from "./browser-proxy.js";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const CDP_CALL_TIMEOUT_MS = 10_000;

export class BrowserSessionHost {
  private chromium: ChildProcessWithoutNullStreams | null = null;
  private proxy: SafeBrowserProxy | null = null;
  private tempDir: string | null = null;
  private cdp: CdpPage | null = null;
  private closing: Promise<void> | null = null;
  private activeUrl = "about:blank";

  configDir = "";
  profileDir = "";
  downloadsDir = "";
  cdpUrl = "";

  constructor(private readonly onUnexpectedExit?: () => void) {}

  async start(): Promise<void> {
    if (this.chromium) return;
    this.tempDir = await mkdtemp(join(tmpdir(), "sparklab-browser-"));
    this.configDir = join(this.tempDir, "config");
    this.profileDir = join(this.tempDir, "profile");
    this.downloadsDir = join(this.tempDir, "downloads");
    await Promise.all([
      mkdir(this.configDir, { recursive: true }),
      mkdir(this.profileDir, { recursive: true }),
      mkdir(this.downloadsDir, { recursive: true }),
    ]);
    this.proxy = new SafeBrowserProxy();
    const proxyUrl = await this.proxy.start();
    const port = await availableLoopbackPort();
    const executable = findChromium();
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDir}`,
      `--proxy-server=${proxyUrl}`,
      "--proxy-bypass-list=<-loopback>",
      "--window-size=1280,720",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      "--disable-features=DownloadBubble",
      ...(config.browser.headless ? ["--headless=new"] : []),
      "about:blank",
    ];
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.chromium = child;
    child.stdout.on("data", () => undefined);
    child.stderr.on("data", () => undefined);
    child.once("exit", () => {
      if (this.chromium === child) {
        this.chromium = null;
        this.onUnexpectedExit?.();
      }
    });
    this.cdpUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForCdp(this.cdpUrl, child);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async startInteractive(onFrame: (frame: Buffer) => void): Promise<void> {
    if (!this.chromium) throw new Error("browser_handoff_unavailable");
    this.cdp = await CdpPage.connect(this.cdpUrl, this.activeUrl, onFrame);
    await this.cdp.start();
  }

  setActiveUrl(url: string): void {
    this.activeUrl = url;
  }

  async input(event: BrowserHandoffInput): Promise<void> {
    if (!this.cdp) throw new Error("browser_handoff_inactive");
    await this.cdp.input(event);
  }

  async stopInteractive(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    await cdp?.close();
  }

  async prepareAgentReturn(): Promise<void> {
    await this.cdp?.reload();
  }

  dispose(): Promise<void> {
    if (!this.closing) this.closing = this.doDispose();
    return this.closing;
  }

  private async doDispose(): Promise<void> {
    await this.stopInteractive();
    const child = this.chromium;
    this.chromium = null;
    if (child) {
      killGroup(child, "SIGTERM");
      await waitForExit(child, 2_000);
    }
    await this.proxy?.close();
    this.proxy = null;
    if (this.tempDir) {
      const owned = this.tempDir;
      this.tempDir = null;
      await rm(owned, { recursive: true, force: true });
    }
  }
}

class CdpPage {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  private constructor(
    private ws: WebSocket,
    private onFrame: (frame: Buffer) => void,
  ) {
    ws.on("message", (data) => this.message(data.toString()));
    ws.on("close", () => this.rejectAll());
  }

  static async connect(
    base: string,
    activeUrl: string,
    onFrame: (frame: Buffer) => void,
  ): Promise<CdpPage> {
    const response = await fetch(`${base}/json/list`);
    const targets = (await response.json()) as Array<{
      type?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const pages = targets.filter((target) => target.type === "page");
    const endpoint =
      pages.find((target) => target.url === activeUrl)?.webSocketDebuggerUrl ??
      pages[0]?.webSocketDebuggerUrl;
    if (!endpoint) throw new Error("browser_handoff_unavailable");
    const ws = new WebSocket(endpoint, { maxPayload: MAX_FRAME_BYTES * 2 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new CdpPage(ws, onFrame);
  }

  async start(): Promise<void> {
    await this.call("Page.enable", {});
    await this.call("Browser.setDownloadBehavior", { behavior: "deny" }).catch(
      () => undefined,
    );
    await this.call("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
  }

  async input(event: BrowserHandoffInput): Promise<void> {
    switch (event.type) {
      case "ping":
        return;
      case "resize":
        await this.call("Emulation.setDeviceMetricsOverride", {
          width: event.width,
          height: event.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        return;
      case "text":
        await this.call("Input.insertText", { text: event.text });
        return;
      case "wheel":
        await this.call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: event.x ?? 0,
          y: event.y ?? 0,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
        });
        return;
      case "pointer":
        await this.call("Input.dispatchMouseEvent", mouseEventParams(event));
        return;
      case "key":
        const printable = event.key.length === 1 && event.action === "down";
        await this.call("Input.dispatchKeyEvent", {
          type: event.action === "down" ? "keyDown" : "keyUp",
          key: event.key,
          code: event.code,
          modifiers: modifierMask(event.modifiers),
          ...(printable ? { text: event.key, unmodifiedText: event.key } : {}),
          ...virtualKeyCode(event.key),
        });
    }
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        await this.call("Page.stopScreencast", {});
      } catch {
        // The page may already be gone.
      }
      this.ws.close(1000, "handoff complete");
    }
    this.rejectAll();
  }

  async reload(): Promise<void> {
    await this.call("Page.reload", { ignoreCache: false });
  }

  private call(method: string, params: unknown): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("browser_handoff_unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("browser_handoff_timeout"));
      }, CDP_CALL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private message(raw: string): void {
    let value: {
      id?: number;
      error?: unknown;
      method?: string;
      params?: { data?: string; sessionId?: number };
    };
    try {
      value = JSON.parse(raw) as typeof value;
    } catch {
      return;
    }
    if (value.method === "Page.screencastFrame" && value.params) {
      const frame = Buffer.from(value.params.data ?? "", "base64");
      if (frame.length > 0 && frame.length <= MAX_FRAME_BYTES)
        this.onFrame(frame);
      void ignoreScreencastAckFailure(
        this.call("Page.screencastFrameAck", {
          sessionId: value.params.sessionId,
        }),
      );
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.error) pending.reject(new Error("browser_handoff_failed"));
    else pending.resolve();
  }

  private rejectAll(): void {
    for (const pending of this.pending.values())
      pending.reject(new Error("browser_handoff_unavailable"));
    this.pending.clear();
  }
}

export function mouseEventParams(
  event: Extract<BrowserHandoffInput, { type: "pointer" }>,
): Record<string, unknown> {
  return {
    type:
      event.action === "move"
        ? "mouseMoved"
        : event.action === "down"
          ? "mousePressed"
          : "mouseReleased",
    x: event.x,
    y: event.y,
    button: event.action === "move" ? "none" : (event.button ?? "left"),
    buttons: mouseButtonsMask(event.buttons ?? []),
    clickCount: event.action === "move" ? 0 : (event.clickCount ?? 1),
  };
}

function mouseButtonsMask(buttons: ("left" | "middle" | "right")[]): number {
  let mask = 0;
  if (buttons.includes("left")) mask |= 1;
  if (buttons.includes("right")) mask |= 2;
  if (buttons.includes("middle")) mask |= 4;
  return mask;
}

/** A disappearing CDP target must not turn a best-effort frame ACK into an unhandled rejection. */
export function ignoreScreencastAckFailure(
  acknowledgement: Promise<void>,
): Promise<void> {
  return acknowledgement.catch(() => undefined);
}

function modifierMask(modifiers: string[]): number {
  let mask = 0;
  if (modifiers.includes("Alt")) mask |= 1;
  if (modifiers.includes("Control")) mask |= 2;
  if (modifiers.includes("Meta")) mask |= 4;
  if (modifiers.includes("Shift")) mask |= 8;
  return mask;
}

function virtualKeyCode(key: string): Record<string, number> {
  const codes: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
  };
  const code = codes[key];
  return code
    ? { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }
    : {};
}

function findChromium(): string {
  if (config.browser.executablePath) return config.browser.executablePath;
  for (const name of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]) {
    const result = spawnSync("which", [name], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim())
      return result.stdout.trim();
  }
  throw new Error(
    "browser executable not found; set BROWSER_USE_EXECUTABLE_PATH",
  );
}

async function availableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForCdp(
  base: string,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/json/version`);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("browser process failed to expose internal control endpoint");
}

function killGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(kill);
      clearTimeout(giveUp);
      resolve();
    };
    child.once("exit", done);
    const kill = setTimeout(() => killGroup(child, "SIGKILL"), timeoutMs);
    const giveUp = setTimeout(() => {
      child.removeListener("exit", done);
      resolve();
    }, timeoutMs + 1_000);
    kill.unref();
    giveUp.unref();
  });
}
