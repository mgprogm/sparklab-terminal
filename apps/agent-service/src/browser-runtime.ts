import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserHandoffInput } from "@sparklab/shared-types";
import { config, CAPS } from "./config.js";
import { BrowserControlLease } from "./browser-control-lease.js";
import { BrowserSessionHost } from "./browser-session-host.js";
import { browserResources } from "./browser-resource-limiter.js";
import { browserPerformanceMetrics } from "./browser-performance-metrics.js";
import { serializeBrowserState } from "./browser-state.js";
import { sanitizePublicUrl, validateBrowserUrl } from "./browser-security.js";

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpResponse {
  id?: number;
  result?: { content?: McpContent[]; isError?: boolean };
  error?: { message?: string };
}

export interface BrowserSnapshot {
  browserId: string;
  revision: number;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  screenshot: { mediaType: "image/png" | "image/webp"; data: string };
}

export type BrowserAction =
  | { action: "navigate"; url: string; new_tab?: boolean }
  | { action: "click"; index: number; new_tab?: boolean }
  | { action: "type"; index: number; text: string }
  | { action: "scroll"; direction: "up" | "down" }
  | { action: "go_back" }
  | { action: "switch_tab"; tab_id: string }
  | { action: "close_tab"; tab_id: string };

export interface BrowserCallResult {
  content: string;
  snapshot?: BrowserSnapshot;
}

export function browserUseConfig(profileId: string, cdpUrl: string) {
  return {
    browser_profile: {
      [profileId]: {
        id: profileId,
        default: true,
        cdp_url: cdpUrl,
        // SafeBrowserProxy is the authoritative network boundary and validates
        // the exact destination IP for every HTTP request and CONNECT tunnel.
        // Browser Use's switch blocks every literal IP, including public ones.
        block_ip_addresses: false,
        disable_security: false,
        enable_default_extensions: false,
        accept_downloads: false,
        auto_download_pdfs: false,
        permissions: [],
      },
    },
    llm: {},
    agent: {},
  };
}

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_VIEWPORT_EDGE = 2048;
const MAX_MCP_LINE_BYTES = 4 * 1024 * 1024;

/** One isolated Browser Use stdio MCP process, owned by one AgentLoop. */
export class BrowserRuntime {
  readonly browserId = randomUUID();
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private revision = 0;
  private pending = new Map<
    number,
    { resolve: (response: McpResponse) => void; reject: (error: Error) => void }
  >();
  private starting: Promise<void> | null = null;
  private lastElements = new Map<number, string>();
  private host: BrowserSessionHost;
  private lease = new BrowserControlLease();
  private closed = false;
  private disposing: Promise<number> | null = null;
  private releaseSession: (() => void) | null = null;

  constructor(
    private onUnexpectedClose?: (browserId: string, revision: number) => void,
  ) {
    this.host = new BrowserSessionHost(() => {
      if (this.closed) return;
      void this.dispose().then((revision) =>
        this.onUnexpectedClose?.(this.browserId, revision),
      );
    });
  }

  get isActive(): boolean {
    return this.child !== null || this.starting !== null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get leaseState() {
    return this.lease.state;
  }

  async observe(signal?: AbortSignal): Promise<BrowserCallResult> {
    this.lease.assertAgent();
    const content = await this.call(
      "browser_get_state",
      { include_screenshot: true },
      signal,
    );
    return this.stateResult(content);
  }

  async listTabs(signal?: AbortSignal): Promise<BrowserCallResult> {
    this.lease.assertAgent();
    const content = await this.call("browser_list_tabs", {}, signal);
    return { content: sanitizeOutputText(extractText(content)) };
  }

  async act(
    action: BrowserAction,
    signal?: AbortSignal,
  ): Promise<BrowserCallResult> {
    this.lease.assertAgent();
    let tool: string;
    let args: Record<string, unknown>;
    switch (action.action) {
      case "navigate":
        await validateBrowserUrl(action.url);
        tool = "browser_navigate";
        args = { url: action.url, new_tab: action.new_tab ?? false };
        break;
      case "click": {
        const href = this.lastElements.get(action.index);
        if (href) await validateBrowserUrl(href);
        tool = "browser_click";
        args = { index: action.index, new_tab: action.new_tab ?? false };
        break;
      }
      case "type":
        tool = "browser_type";
        args = { index: action.index, text: action.text };
        break;
      case "scroll":
        tool = "browser_scroll";
        args = { direction: action.direction };
        break;
      case "go_back":
        tool = "browser_go_back";
        args = {};
        break;
      case "switch_tab":
        tool = "browser_switch_tab";
        args = { tab_id: action.tab_id };
        break;
      case "close_tab":
        tool = "browser_close_tab";
        args = { tab_id: action.tab_id };
        break;
    }
    const actionContent = await this.call(tool, args, signal);
    const state = await this.call(
      "browser_get_state",
      { include_screenshot: true },
      signal,
    );
    const result = await this.stateResult(state);
    const actionText =
      action.action === "type"
        ? "Typed [redacted] into browser element"
        : sanitizeOutputText(extractText(actionContent));
    return {
      content: `${actionText}\n${result.content}`,
      snapshot: result.snapshot,
    };
  }

  dispose(): Promise<number> {
    if (!this.disposing) this.disposing = this.doDispose();
    return this.disposing;
  }

  private async doDispose(): Promise<number> {
    this.closed = true;
    this.lease.close();
    const revision = ++this.revision;
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (child) {
      child.stdin.end();
      killProcessGroup(child, "SIGTERM");
      await waitForExit(child, 2_000);
    }
    this.rejectPending(new Error("browser runtime closed"));
    this.lastElements.clear();
    await this.cleanupOwnedResources();
    this.releaseSession?.();
    this.releaseSession = null;
    return revision;
  }

  private async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.start();
    try {
      await this.starting;
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      this.starting = null;
    }
  }

  private async start(): Promise<void> {
    this.assertOpen();
    const project = config.browser.project;
    if (!project)
      throw new Error("browser tools are disabled: set BROWSER_USE_PROJECT");
    const workdir = resolve(project);
    this.releaseSession = browserResources.reserveSession();
    const releaseLaunch = await browserResources.acquireLaunch();
    try {
      this.assertOpen();
      await this.host.start();
    } finally {
      releaseLaunch();
    }
    this.assertOpen();
    const configDir = this.host.configDir;
    const profileId = randomUUID();
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify(browserUseConfig(profileId, this.host.cdpUrl)),
      { mode: 0o600 },
    );
    this.assertOpen();

    const mcpStartedAt = Date.now();
    let mcpReady = false;
    try {
      const child = spawn("uv", ["run", "browser-use", "--mcp"], {
        cwd: workdir,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configDir,
          BROWSER_USE_CONFIG_DIR: configDir,
          ANONYMIZED_TELEMETRY: "false",
          BROWSER_USE_CLOUD_SYNC: "false",
          BROWSER_USE_DISABLE_EXTENSIONS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      this.child = child;
      child.once("error", (error) => this.rejectPending(error));
      child.once("exit", (code, signal) => {
        const unexpected = this.child === child;
        if (unexpected) {
          this.child = null;
          void this.cleanupOwnedResources();
          this.onUnexpectedClose?.(this.browserId, ++this.revision);
        }
        this.rejectPending(
          new Error(`Browser Use exited (${code ?? signal ?? "unknown"})`),
        );
      });
      child.stderr.on("data", () => undefined);
      let stdout = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_MCP_LINE_BYTES) {
          void this.dispose();
          return;
        }
        let newline = stdout.indexOf(0x0a);
        while (newline >= 0) {
          const line = stdout.subarray(0, newline).toString("utf8");
          stdout = stdout.subarray(newline + 1);
          this.handleLine(line);
          newline = stdout.indexOf(0x0a);
        }
      });
      await withAbortAndTimeout(
        this.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sparklab-agent-service", version: "0.1.0" },
        }),
        undefined,
        30_000,
      );
      this.notify("notifications/initialized", {});
      mcpReady = true;
    } finally {
      browserPerformanceMetrics.mcpReady(Date.now() - mcpStartedAt, mcpReady);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("browser runtime closed during startup");
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpContent[]> {
    await this.ensureStarted();
    const startedAt = Date.now();
    let succeeded = false;
    try {
      let response: McpResponse;
      try {
        response = await withAbortAndTimeout(
          this.request("tools/call", { name, arguments: args }),
          signal,
          CAPS.browserActionTimeoutMs,
        );
      } catch (error) {
        await this.dispose();
        throw error;
      }
      if (response.error)
        throw new Error(response.error.message || "Browser Use MCP error");
      const result = response.result;
      if (!result?.content)
        throw new Error("Browser Use returned a malformed result");
      if (result.isError) throw new Error(extractText(result.content));
      const text = extractText(result.content);
      if (/^(Error:|Unknown tool:)/i.test(text)) throw new Error(text);
      succeeded = true;
      return result.content;
    } finally {
      browserPerformanceMetrics.browserCall(Date.now() - startedAt, succeeded);
    }
  }

  private request(method: string, params: unknown): Promise<McpResponse> {
    const child = this.child;
    if (!child?.stdin.writable)
      return Promise.reject(new Error("browser runtime is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  private handleLine(line: string): void {
    let response: McpResponse;
    try {
      response = JSON.parse(line) as McpResponse;
    } catch {
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  private async stateResult(content: McpContent[]): Promise<BrowserCallResult> {
    const text = extractText(content);
    let state: Record<string, unknown>;
    try {
      state = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Browser Use returned malformed page state");
    }
    const rawUrl = typeof state.url === "string" ? state.url : "";
    const url = sanitizePublicUrl(rawUrl);
    this.host.setActiveUrl(rawUrl);
    state.url = url;
    if (Array.isArray(state.interactive_elements)) {
      state.interactive_elements = state.interactive_elements.map((value) => {
        if (!value || typeof value !== "object") return value;
        const element = { ...(value as Record<string, unknown>) };
        if (typeof element.href === "string")
          element.href = sanitizePublicUrl(element.href, rawUrl);
        return element;
      });
    }
    sanitizeStateUrls(state, rawUrl);
    const publicText = serializeBrowserState(state);
    browserPerformanceMetrics.browserState(Buffer.byteLength(publicText));
    if (!url || url === "about:blank") {
      this.lastElements.clear();
      return { content: publicText };
    }
    if (url) {
      try {
        await validateBrowserUrl(rawUrl);
      } catch (error) {
        await this.dispose();
        throw new Error(
          `blocked unsafe browser redirect: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    this.lastElements.clear();
    if (Array.isArray(state.interactive_elements)) {
      for (const value of state.interactive_elements) {
        if (!value || typeof value !== "object") continue;
        const element = value as Record<string, unknown>;
        if (
          typeof element.index !== "number" ||
          typeof element.href !== "string"
        )
          continue;
        try {
          const href = new URL(element.href, url).toString();
          this.lastElements.set(element.index, href);
        } catch {
          // Invalid hrefs cannot be clicked through the safe adapter.
        }
      }
    }
    const image = content.find((item) => item.type === "image");
    const viewport = state.viewport as Record<string, unknown> | undefined;
    const width = boundedDimension(viewport?.width);
    const height = boundedDimension(viewport?.height);
    if (!image?.data || !image.mimeType || !width || !height) {
      throw new Error(
        "Browser Use did not return a bounded viewport screenshot",
      );
    }
    const mediaType = image.mimeType;
    if (mediaType !== "image/png" && mediaType !== "image/webp") {
      throw new Error("unsupported browser screenshot format");
    }
    if (Buffer.byteLength(image.data, "base64") > MAX_SCREENSHOT_BYTES) {
      throw new Error("browser screenshot exceeds the 2 MiB limit");
    }
    browserPerformanceMetrics.browserSnapshot(
      Buffer.byteLength(image.data, "base64"),
    );
    const snapshot: BrowserSnapshot = {
      browserId: this.browserId,
      revision: ++this.revision,
      url,
      title:
        typeof state.title === "string"
          ? sanitizeOutputText(state.title).slice(0, 500)
          : "",
      viewport: { width, height },
      screenshot: { mediaType, data: image.data },
    };
    return { content: publicText, snapshot };
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async cleanupOwnedResources(): Promise<void> {
    await this.host.dispose();
  }

  requestHandoff(): void {
    if (!this.isActive || this.closed)
      throw new Error("browser_handoff_unavailable");
    this.lease.requestHuman();
    this.lastElements.clear();
  }

  async activateHandoff(onFrame: (frame: Buffer) => void): Promise<void> {
    this.lease.activateHuman();
    try {
      await this.host.startInteractive(onFrame);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async handoffInput(event: BrowserHandoffInput): Promise<void> {
    this.lease.assertHuman();
    await this.host.input(event);
  }

  async finishHandoff(): Promise<void> {
    this.lease.assertHuman();
    // Reload in the same profile before the agent can observe again. This
    // preserves authenticated cookies while clearing password/OTP values and
    // other transient form data entered by the human.
    await this.host.prepareAgentReturn();
    await this.host.stopInteractive();
    this.lastElements.clear();
    this.lease.returnToAgent();
  }
}

function extractText(content: McpContent[]): string {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .slice(0, 100_000);
}

function sanitizeOutputText(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      return sanitizePublicUrl(candidate.replace(/[),.;]+$/, ""));
    } catch {
      return "[redacted-url]";
    }
  });
}

function sanitizeStateUrls(value: unknown, baseUrl: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (typeof nested === "string") {
      if (/^(url|href|src|action)$/i.test(key)) {
        (value as Record<string, unknown>)[key] = sanitizePublicUrl(
          nested,
          baseUrl,
        );
      } else {
        (value as Record<string, unknown>)[key] = sanitizeOutputText(nested);
      }
    } else {
      sanitizeStateUrls(nested, baseUrl);
    }
  }
}

function boundedDimension(value: unknown): number {
  const number = typeof value === "number" ? Math.trunc(value) : 0;
  return number > 0 && number <= MAX_VIEWPORT_EDGE ? number : 0;
}

function withAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("aborted", "AbortError"));
    const timer = setTimeout(
      () => reject(new Error("browser action timed out")),
      ms,
    );
    const abort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });
}

function killProcessGroup(
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
    let killTimer: NodeJS.Timeout;
    let giveUpTimer: NodeJS.Timeout;
    const exited = () => {
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve();
    };
    child.once("exit", exited);
    killTimer = setTimeout(() => {
      killProcessGroup(child, "SIGKILL");
    }, timeoutMs);
    giveUpTimer = setTimeout(() => {
      child.removeListener("exit", exited);
      resolve();
    }, timeoutMs + 1_000);
    killTimer.unref();
    giveUpTimer.unref();
  });
}
