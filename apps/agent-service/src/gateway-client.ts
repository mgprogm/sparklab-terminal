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
  CodexRunResponse,
  CodexSandboxMode,
  KanbanBoard,
  KanbanBoardSummary,
  KanbanCard,
  KanbanListResponse,
  CreateBoardRequest,
  UpdateBoardRequest,
  CreateCardRequest,
  UpdateCardRequest,
  PmProject,
  PmProjectSummary,
  PmTask,
  PmSprint,
  PmListResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateSprintRequest,
  CreateColumnRequest,
  UpdateColumnRequest,
  FsUploadResponse,
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

  async scheduleTerminalAction(
    sessionId: string,
    keys: string[],
    executeAt: string,
  ): Promise<{ id: string; executeAt: number; status: string }> {
    return this.json(
      await this.call("/api/terminal-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, keys, executeAt }),
      }),
    );
  }

  async scheduleTerminalInput(
    sessionId: string,
    text: string,
    keys: string[],
    executeAt: string,
  ): Promise<{ id: string; executeAt: number; status: string }> {
    return this.json(
      await this.call("/api/terminal-actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "input",
          sessionId,
          text,
          keys,
          executeAt,
        }),
      }),
    );
  }

  async listScheduledTerminalActions(): Promise<{
    actions: Array<{
      id: string;
      sessionId: string;
      kind: "keys" | "input";
      keys: string[];
      hasText?: boolean;
      executeAt: number;
      status: string;
      error: string | null;
    }>;
  }> {
    return this.json(await this.call("/api/terminal-actions"));
  }

  async cancelScheduledTerminalAction(id: string): Promise<{ id: string }> {
    return this.json(
      await this.call(`/api/terminal-actions/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    );
  }

  async startTerminalMonitor(body: Record<string, unknown>) {
    return this.json(
      await this.call("/api/terminal-monitors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async listTerminalMonitors() {
    return this.json(await this.call("/api/terminal-monitors"));
  }

  async stopTerminalMonitor(id: string) {
    return this.json(
      await this.call(`/api/terminal-monitors/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    );
  }

  /**
   * Run the Codex CLI non-interactively in a session's working directory.
   * The gateway clamps `mode` to read-only|workspace-write and roots Codex at
   * the session cwd. Not-installed -> 503, timeout -> 504 (both surface as a
   * GatewayError the caller turns into a clear tool-result string).
   */
  async runCodex(
    sessionId: string,
    body: { prompt: string; mode?: CodexSandboxMode },
  ): Promise<CodexRunResponse> {
    // Codex runs as a child of the gateway, not this service, so it would not
    // otherwise see the Azure credential already loaded by agent-service.
    // Keep secrets out of the JSON body, approval UI, command argv, and logs;
    // the gateway accepts these internal headers only as ephemeral child env.
    const azureHeaders = {
      "x-sparklab-codex-azure-endpoint": config.azure.endpoint,
      "x-sparklab-codex-azure-api-key": config.azure.apiKey,
      "x-sparklab-codex-azure-api-version": config.azure.apiVersion,
      "x-sparklab-codex-azure-deployment": config.azure.deployments.sol,
    };
    return this.json<CodexRunResponse>(
      await this.call(`/api/sessions/${encodeURIComponent(sessionId)}/codex`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...azureHeaders,
        },
        body: JSON.stringify(body),
      }),
    );
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

  /** Write bounded raw bytes to an absolute path on the selected session's server. */
  async uploadSessionFile(
    sessionId: string,
    path: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<FsUploadResponse> {
    const query = new URLSearchParams({ path });
    return this.json<FsUploadResponse>(
      await this.call(
        `/api/sessions/${encodeURIComponent(sessionId)}/fs/upload?${query.toString()}`,
        {
          method: "POST",
          headers: { "content-type": contentType },
          body: Buffer.from(data),
        },
      ),
    );
  }

  // --- Kanban -------------------------------------------------------------
  // The agent drives the gateway-owned Kanban board purely as a REST client
  // (mirrors how it drives terminals); the gateway stays the single store of
  // record and enforcement point.

  async listKanbanBoards(): Promise<KanbanBoardSummary[]> {
    const r = await this.json<KanbanListResponse>(
      await this.call("/api/kanban/boards"),
    );
    return r.boards;
  }

  async getKanbanBoard(boardId: string): Promise<KanbanBoard> {
    return this.json<KanbanBoard>(
      await this.call(`/api/kanban/boards/${encodeURIComponent(boardId)}`),
    );
  }

  async createKanbanBoard(body: CreateBoardRequest): Promise<KanbanBoard> {
    return this.json<KanbanBoard>(
      await this.call("/api/kanban/boards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async updateKanbanBoard(
    boardId: string,
    body: UpdateBoardRequest,
  ): Promise<KanbanBoard> {
    return this.json<KanbanBoard>(
      await this.call(`/api/kanban/boards/${encodeURIComponent(boardId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Delete a whole board. Gateway returns 204 on success (no body). */
  async deleteKanbanBoard(boardId: string): Promise<void> {
    const res = await this.call(
      `/api/kanban/boards/${encodeURIComponent(boardId)}`,
      { method: "DELETE" },
    );
    if (res.status !== 204) throw await this.error(res);
  }

  async addKanbanCard(
    boardId: string,
    body: CreateCardRequest,
  ): Promise<KanbanCard> {
    return this.json<KanbanCard>(
      await this.call(
        `/api/kanban/boards/${encodeURIComponent(boardId)}/cards`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  async updateKanbanCard(
    boardId: string,
    cardId: string,
    body: Omit<UpdateCardRequest, "boardId">,
  ): Promise<KanbanCard> {
    return this.json<KanbanCard>(
      await this.call(`/api/kanban/cards/${encodeURIComponent(cardId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardId, ...body }),
      }),
    );
  }

  /**
   * Move (or reorder) a card. The gateway rejects a stale `rev` with 409 and
   * echoes the current board; we surface that as `{ stale: true, board }` so
   * the tool executor can refetch the fresh rev and retry once — the model
   * never has to manage rev itself.
   */
  async moveKanbanCard(
    boardId: string,
    cardId: string,
    body: { toColumnId: string; toIndex: number; rev: number },
  ): Promise<{ stale: boolean; board: KanbanBoard }> {
    const res = await this.call(
      `/api/kanban/cards/${encodeURIComponent(cardId)}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boardId, ...body }),
      },
    );
    if (res.status === 409) {
      const b = (await res.json()) as { error?: string; board: KanbanBoard };
      return { stale: true, board: b.board };
    }
    return { stale: false, board: await this.json<KanbanBoard>(res) };
  }

  /** Delete a card. `?boardId=` locates it; 204 on success (no body). */
  async deleteKanbanCard(boardId: string, cardId: string): Promise<void> {
    const res = await this.call(
      `/api/kanban/cards/${encodeURIComponent(cardId)}?boardId=${encodeURIComponent(boardId)}`,
      { method: "DELETE" },
    );
    if (res.status !== 204) throw await this.error(res);
  }

  // --- Project management (PM) -------------------------------------------
  // Same posture as Kanban: the agent drives the gateway-owned PM store purely
  // as a REST client. The gateway remains the single store of record and the
  // one enforcement point (auth, CSRF, rev-guarded move).

  async listPmProjects(): Promise<PmProjectSummary[]> {
    const r = await this.json<PmListResponse>(
      await this.call("/api/pm/projects"),
    );
    return r.projects;
  }

  async getPmProject(projectId: string): Promise<PmProject> {
    return this.json<PmProject>(
      await this.call(`/api/pm/projects/${encodeURIComponent(projectId)}`),
    );
  }

  /** The project's issue hierarchy as a derived forest (read-only). */
  async getPmTree(projectId: string): Promise<unknown> {
    return this.json<unknown>(
      await this.call(`/api/pm/projects/${encodeURIComponent(projectId)}/tree`),
    );
  }

  async createPmProject(body: CreateProjectRequest): Promise<PmProject> {
    return this.json<PmProject>(
      await this.call("/api/pm/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  async updatePmProject(
    projectId: string,
    body: UpdateProjectRequest,
  ): Promise<PmProject> {
    return this.json<PmProject>(
      await this.call(`/api/pm/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Delete a whole project. Gateway returns 204 on success (no body). */
  async deletePmProject(projectId: string): Promise<void> {
    const res = await this.call(
      `/api/pm/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE" },
    );
    if (res.status !== 204) throw await this.error(res);
  }

  async addPmTask(projectId: string, body: CreateTaskRequest): Promise<PmTask> {
    return this.json<PmTask>(
      await this.call(
        `/api/pm/projects/${encodeURIComponent(projectId)}/tasks`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  /**
   * Update a task's fields and/or its dependency set. The client injects
   * `projectId` (which locates the task) into the body so callers only pass the
   * fields they want to change. A dependency cycle comes back as
   * `400 {error:"dependency cycle"}` → surfaced as a GatewayError.
   */
  async updatePmTask(
    projectId: string,
    taskId: string,
    body: Omit<UpdateTaskRequest, "projectId">,
  ): Promise<PmTask> {
    return this.json<PmTask>(
      await this.call(`/api/pm/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      }),
    );
  }

  /**
   * Move (or reorder) a task. The gateway rejects a stale `rev` with 409 and
   * echoes the current project; we surface that as `{ stale: true, project }`
   * so the tool executor can refetch the fresh rev and retry once — the model
   * never has to manage rev itself (mirrors moveKanbanCard).
   */
  async movePmTask(
    projectId: string,
    taskId: string,
    body: { toColumnId: string; toIndex: number; rev: number },
  ): Promise<{ stale: boolean; project: PmProject }> {
    const res = await this.call(
      `/api/pm/tasks/${encodeURIComponent(taskId)}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      },
    );
    if (res.status === 409) {
      const b = (await res.json()) as { error?: string; project: PmProject };
      return { stale: true, project: b.project };
    }
    return { stale: false, project: await this.json<PmProject>(res) };
  }

  // --- PM Column CRUD -------------------------------------------------------

  async createPmColumn(
    projectId: string,
    body: CreateColumnRequest,
  ): Promise<PmProject> {
    return this.json<PmProject>(
      await this.call(
        `/api/pm/projects/${encodeURIComponent(projectId)}/columns`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  async updatePmColumn(
    projectId: string,
    colId: string,
    body: Omit<UpdateColumnRequest, "projectId">,
  ): Promise<PmProject> {
    return this.json<PmProject>(
      await this.call(`/api/pm/columns/${encodeURIComponent(colId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      }),
    );
  }

  /**
   * Move (reorder) a column. Rev-guarded; mirrors movePmTask — a 409 stale
   * echoes the current project so the tool executor can retry once.
   */
  async movePmColumn(
    projectId: string,
    colId: string,
    body: { toIndex: number; rev: number },
  ): Promise<{ stale: boolean; project: PmProject }> {
    const res = await this.call(
      `/api/pm/columns/${encodeURIComponent(colId)}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ...body }),
      },
    );
    if (res.status === 409) {
      const b = (await res.json()) as { error?: string; project: PmProject };
      return { stale: true, project: b.project };
    }
    return { stale: false, project: await this.json<PmProject>(res) };
  }

  /** Delete a column. 204 on success. */
  async deletePmColumn(
    projectId: string,
    colId: string,
    opts: { mode?: string; toColumnId?: string } = {},
  ): Promise<void> {
    const params = new URLSearchParams({ projectId });
    if (opts.mode) params.set("mode", opts.mode);
    if (opts.toColumnId) params.set("toColumnId", opts.toColumnId);
    const res = await this.call(
      `/api/pm/columns/${encodeURIComponent(colId)}?${params}`,
      { method: "DELETE" },
    );
    if (res.status !== 204) throw await this.error(res);
  }

  async addPmSprint(
    projectId: string,
    body: CreateSprintRequest,
  ): Promise<PmSprint> {
    return this.json<PmSprint>(
      await this.call(
        `/api/pm/projects/${encodeURIComponent(projectId)}/sprints`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  // --- PM Collaboration (Phase 3) -------------------------------------------

  async addPmComment(
    projectId: string,
    taskId: string,
    body: { body: string },
  ): Promise<unknown> {
    return this.json<unknown>(
      await this.call(
        `/api/pm/tasks/${encodeURIComponent(taskId)}/comments?projectId=${encodeURIComponent(projectId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    );
  }

  async listPmComments(projectId: string, taskId: string): Promise<unknown> {
    return this.json<unknown>(
      await this.call(
        `/api/pm/tasks/${encodeURIComponent(taskId)}/comments?projectId=${encodeURIComponent(projectId)}`,
      ),
    );
  }

  async listPmActivity(
    projectId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.before !== undefined) params.set("before", String(opts.before));
    const qs = params.toString();
    return this.json<unknown>(
      await this.call(
        `/api/pm/projects/${encodeURIComponent(projectId)}/activity${qs ? `?${qs}` : ""}`,
      ),
    );
  }

  async watchPmTask(projectId: string, taskId: string): Promise<unknown> {
    return this.json<unknown>(
      await this.call(
        `/api/pm/tasks/${encodeURIComponent(taskId)}/watch?projectId=${encodeURIComponent(projectId)}`,
        { method: "POST" },
      ),
    );
  }

  async unwatchPmTask(projectId: string, taskId: string): Promise<unknown> {
    return this.json<unknown>(
      await this.call(
        `/api/pm/tasks/${encodeURIComponent(taskId)}/unwatch?projectId=${encodeURIComponent(projectId)}`,
        { method: "POST" },
      ),
    );
  }

  async listPmAttachments(projectId: string, taskId: string): Promise<unknown> {
    return this.json<unknown>(
      await this.call(
        `/api/pm/tasks/${encodeURIComponent(taskId)}/attachments?projectId=${encodeURIComponent(projectId)}`,
      ),
    );
  }

  /** Build a GatewayError from a non-2xx response (used by the 204 methods). */
  private async error(res: Response): Promise<GatewayError> {
    let msg = `${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) msg = b.error;
    } catch {
      /* non-JSON error body */
    }
    return new GatewayError(res.status, msg);
  }

  /** Verify a browser's cookie by proxying to GET /api/auth/me. */
  async verifyCookie(
    cookieHeader: string | undefined,
  ): Promise<{ ok: boolean; openMode: boolean; username?: string }> {
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
      ...(typeof body.username === "string" ? { username: body.username } : {}),
    };
  }
}

export const gateway = new GatewayClient();
