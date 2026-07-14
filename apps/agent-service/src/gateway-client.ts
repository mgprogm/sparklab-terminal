/**
 * Thin fetch client for the terminal gateway REST API.
 *
 * The agent operates terminals EXCLUSIVELY through these calls — it never
 * shells out to tmux itself. That keeps the gateway the single enforcement
 * point for the web-* prefix, auth, and the one-and-only kill-session site.
 *
 * When the gateway runs with auth enabled, we log in with the configured
 * credentials and reuse the `gw_session` cookie, re-logging in on a 401.
 */
import type {
  ScreenResponse,
  SendKeysRequest,
  SessionInfo,
  CreateSessionResponse,
} from "@sparklab/shared-types";
import { config } from "./config.js";

/** Origin header the gateway will accept for our POSTs (must be allowlisted). */
const SELF_ORIGIN = [...config.allowedOrigins][0] ?? "http://localhost:3000";

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

class GatewayClient {
  private cookie: string | null = null;
  private loginInFlight: Promise<void> | null = null;

  private get authEnabled(): boolean {
    return Boolean(config.gatewayAuth.user && config.gatewayAuth.password);
  }

  private async login(): Promise<void> {
    if (!this.authEnabled) return;
    const res = await fetch(`${config.gatewayUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: SELF_ORIGIN,
      },
      body: JSON.stringify({
        username: config.gatewayAuth.user,
        password: config.gatewayAuth.password,
      }),
    });
    if (res.status !== 204) {
      throw new GatewayError(
        res.status,
        `gateway login failed (${res.status})`,
      );
    }
    const setCookie = res.headers.get("set-cookie");
    const match = setCookie?.match(/gw_session=[^;]+/);
    if (!match) {
      throw new GatewayError(500, "gateway login returned no session cookie");
    }
    this.cookie = match[0];
  }

  private async ensureLogin(): Promise<void> {
    if (!this.authEnabled || this.cookie) return;
    // Collapse concurrent first-time logins into one request.
    if (!this.loginInFlight) {
      this.loginInFlight = this.login().finally(() => {
        this.loginInFlight = null;
      });
    }
    await this.loginInFlight;
  }

  /** Fetch against the gateway with cookie auth + one automatic re-login on 401. */
  private async call(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<Response> {
    await this.ensureLogin();
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (init.method && init.method !== "GET")
      headers.set("origin", SELF_ORIGIN);
    const res = await fetch(`${config.gatewayUrl}${path}`, {
      ...init,
      headers,
    });
    if (res.status === 401 && this.authEnabled && retry) {
      this.cookie = null;
      return this.call(path, init, false);
    }
    return res;
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) msg = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new GatewayError(res.status, msg);
    }
    return (await res.json()) as T;
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.json<SessionInfo[]>(await this.call("/api/sessions"));
  }

  async readScreen(
    sessionId: string,
    historyLines = 0,
  ): Promise<ScreenResponse> {
    const q = historyLines > 0 ? `?history=${historyLines}` : "";
    return this.json<ScreenResponse>(
      await this.call(
        `/api/sessions/${encodeURIComponent(sessionId)}/screen${q}`,
      ),
    );
  }

  /** POST keys/text. Gateway returns 204 on success (no body). */
  async sendKeys(sessionId: string, body: SendKeysRequest): Promise<void> {
    const res = await this.call(
      `/api/sessions/${encodeURIComponent(sessionId)}/keys`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (res.status !== 204) {
      let msg = `${res.status}`;
      try {
        const b = (await res.json()) as { error?: string };
        if (b?.error) msg = b.error;
      } catch {
        /* ignore */
      }
      throw new GatewayError(res.status, msg);
    }
  }

  async createSession(opts: {
    name?: string;
    cwd?: string;
  }): Promise<CreateSessionResponse> {
    return this.json<CreateSessionResponse>(
      await this.call("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts),
      }),
    );
  }

  /** Verify a browser's cookie by proxying to GET /api/auth/me. */
  async verifyCookie(
    cookieHeader: string | undefined,
  ): Promise<{ ok: boolean; openMode: boolean }> {
    const headers: Record<string, string> = {};
    if (cookieHeader) headers.cookie = cookieHeader;
    const res = await fetch(`${config.gatewayUrl}/api/auth/me`, { headers });
    if (res.status !== 200) return { ok: false, openMode: false };
    const body = (await res.json()) as {
      authenticated?: boolean;
      username?: string;
    };
    // Open mode: authenticated without a username (see gateway handleMe).
    return {
      ok: Boolean(body.authenticated),
      openMode: Boolean(body.authenticated) && body.username === undefined,
    };
  }
}

export const gateway = new GatewayClient();
